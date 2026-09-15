//! Kiro provider — port of `providers/kiro/` (CodeWhisperer streaming
//! runtime + kiro_desktop / aws_sso_oidc auth). Upstream is a JSON-fragment
//! stream, not SSE; "non-stream" calls collect it into one JSON.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Semaphore};

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::provider::ProviderAdapter;
use crate::providers::kiro_auth::{KiroAuth, KiroAuthType, KiroSnapshot};
use crate::providers::kiro_convert::{
    anthropic_input_tokens, build_kiro_payload_from_anthropic, build_kiro_payload_from_openai,
    normalize_kiro_model_id,
};
use crate::providers::kiro_stream::{
    anthropic_json_from_kiro, anthropic_sse_from_kiro, openai_json_from_kiro, openai_sse_from_kiro,
    parse_kiro_stream,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind,
};

const DEFAULT_KIRO_MODEL: &str = "auto";
const FALLBACK_MODELS: &[&str] = &[
    "auto",
    "claude-opus-4.7",
    "claude-opus-4.6",
    "claude-sonnet-4.6",
    "claude-opus-4.5",
    "claude-sonnet-4.5",
    "claude-sonnet-4",
    "claude-haiku-4.5",
    "deepseek-3.2",
    "minimax-m2.5",
    "minimax-m2.1",
    "glm-5",
    "qwen3-coder-next",
];
const MODELS_CACHE_TTL_MS: i64 = 15 * 60_000;

#[derive(Debug, Clone)]
struct KiroSettings {
    region: String,
    api_region: Option<String>,
    /// Test hook — overrides the runtime host template entirely
    /// (`runtime.{region}.kiro.dev` is a fixed AWS domain).
    runtime_base_url: Option<String>,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
    max_retries: usize,
    max_concurrent_requests: usize,
    max_concurrent_large: usize,
    large_prompt_bytes: usize,
    probabilistic_retry_chance: f64,
    account_max_backoff_multiplier: u64,
}

struct KiroBehavior {
    retry_chance: f64,
    max_backoff_multiplier: u64,
}

impl crate::pool::PoolBehavior for KiroBehavior {
    fn provider_name(&self) -> &'static str {
        "kiro"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_kiro_model_id(model)
    }
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        let list: Vec<String> = if account.state.model_ids.is_empty() {
            FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
        } else {
            account.state.model_ids.clone()
        };
        list.iter().any(|m| normalize_kiro_model_id(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
    }
    fn retry_chance(&self) -> f64 {
        self.retry_chance
    }
    /// kiro `resolveCooldown` — quota honors resetAtIso; cooling base
    /// `max(1000, cooldownMs)` with a configurable cap
    /// (`accountMaxBackoffMultiplier`).
    fn resolve_cooldown(
        &self,
        account: &AccountWithState,
        classified: &ClassifiedError,
        now: i64,
    ) -> (AccountStatus, Option<i64>) {
        match classified.kind {
            ResponseKind::Auth => (AccountStatus::AuthFailed, None),
            ResponseKind::Quota => {
                let until = classified
                    .reset_at_iso
                    .as_deref()
                    .and_then(|iso| chrono::DateTime::parse_from_rfc3339(iso).ok())
                    .map(|d| d.timestamp_millis())
                    .unwrap_or(now + classified.cooldown_ms);
                (AccountStatus::QuotaExceeded, Some(until))
            }
            ResponseKind::RateLimit => (
                AccountStatus::RateLimited,
                Some(now + classified.cooldown_ms),
            ),
            _ => {
                let base = classified.cooldown_ms.max(1_000);
                let multiplier = 2_i64
                    .pow(account.state.failures.saturating_sub(1).min(20) as u32)
                    .min(self.max_backoff_multiplier as i64);
                (AccountStatus::Cooling, Some(now + base * multiplier))
            }
        }
    }
}

/// `KiroRequestLimiter` — global concurrency cap + a tighter cap for
/// large prompts (body bytes > threshold).
struct KiroRequestLimiter {
    slots: Semaphore,
    large_slots: Semaphore,
    large_prompt_bytes: usize,
}

impl KiroRequestLimiter {
    fn new(settings: &KiroSettings) -> Self {
        Self {
            slots: Semaphore::new(settings.max_concurrent_requests),
            large_slots: Semaphore::new(settings.max_concurrent_large),
            large_prompt_bytes: settings.large_prompt_bytes,
        }
    }

    /// Acquires permits; returned guard releases on drop.
    async fn acquire(
        &self,
        body: &Value,
    ) -> (
        tokio::sync::SemaphorePermit<'_>,
        Option<tokio::sync::SemaphorePermit<'_>>,
    ) {
        let is_large =
            serde_json::to_string(body).map(|s| s.len()).unwrap_or(0) > self.large_prompt_bytes;
        // large requests hold both slots (TS limiter semantics)
        let normal = if is_large {
            Some(self.slots.acquire().await.expect("slots closed"))
        } else {
            Some(self.slots.acquire().await.expect("slots closed"))
        };
        let large = if is_large {
            Some(self.large_slots.acquire().await.expect("slots closed"))
        } else {
            None
        };
        (normal.unwrap(), large)
    }
}

pub struct KiroProvider {
    core: Arc<KiroCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct KiroCore {
    pool: Arc<Mutex<AccountPool<KiroBehavior>>>,
    auths: Mutex<HashMap<String, Arc<KiroAuth>>>,
    models_cache: Mutex<HashMap<String, (i64, Vec<String>)>>, // account → (cached_at, modelIds)
    limiter: KiroRequestLimiter,
    http: Arc<UpstreamHttp>,
    settings: Arc<KiroSettings>,
    persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
}

impl KiroProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = kiro_settings(&provider_config.settings);
        let http = UpstreamHttp::new("https://runtime.local", Some(proxy_url))?;

        let mut pool = AccountPool::new(KiroBehavior {
            retry_chance: settings.probabilistic_retry_chance,
            max_backoff_multiplier: settings.account_max_backoff_multiplier,
        });
        pool.set_on_changed(on_changed);
        let mut states = provider_state
            .accounts
            .iter()
            .map(|(k, v)| (k.clone(), AccountRuntimeState::from_value(v)))
            .collect();
        pool.reload(
            account_files,
            &mut states,
            provider_state.current_account_index,
        );

        Ok(Self {
            core: Arc::new(KiroCore {
                pool: Arc::new(Mutex::new(pool)),
                auths: Mutex::new(HashMap::new()),
                models_cache: Mutex::new(HashMap::new()),
                limiter: KiroRequestLimiter::new(&settings),
                http: Arc::new(http),
                settings: Arc::new(settings),
                persist_account,
                log,
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
}

impl KiroCore {
    fn log_entry(
        &self,
        level: LogLevel,
        message: impl Into<String>,
        account: Option<&AccountWithState>,
        request_id: Option<&str>,
        model: Option<&str>,
        duration_ms: Option<u64>,
        extra: Option<Value>,
    ) {
        (self.log)(GatewayLogEntry {
            ts: now_ms(),
            level,
            message: message.into(),
            provider: Some("kiro".into()),
            account_id: account.map(|a| {
                a.config
                    .email
                    .clone()
                    .or_else(|| a.config.label.clone())
                    .unwrap_or_else(|| a.config.id.clone())
            }),
            request_id: request_id.map(str::to_string),
            category: Some("upstream".into()),
            status_code: None,
            duration: duration_ms,
            streaming: None,
            time_to_first_token: None,
            chunk_count: None,
            model: model.map(str::to_string),
            api_format: None,
            usage: extra,
            cost: None,
            error: None,
            extra: Default::default(),
        });
    }

    /// `ensureInitialized` — build the per-account auth manager and seed
    /// fallback models (TS sets modelsCachedAt=now — remote refresh only
    /// happens on explicit listAvailableModels).
    async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<KiroAuth>> {
        if let Some(auth) = self.auths.lock().await.get(account_id) {
            return Ok(auth.clone());
        }
        let Some(config) = ({
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        }) else {
            anyhow::bail!("Account not found: {account_id}");
        };
        {
            let mut pool = self.pool.lock().await;
            if let Some(acc) = pool.find_mut(account_id)
                && acc.state.model_ids.is_empty()
            {
                acc.state.model_ids = FALLBACK_MODELS.iter().map(|s| s.to_string()).collect();
                acc.state.models_cached_at = now_ms();
            }
        }
        let persist = self.persist_account.clone();
        let pool_ref = self.pool.clone();
        let on_change: Arc<dyn Fn(&str, &KiroSnapshot) + Send + Sync> =
            Arc::new(move |acc_id: &str, snap: &KiroSnapshot| {
                if let Ok(mut pool) = pool_ref.try_lock()
                    && let Some(acc) = pool.find_mut(acc_id)
                {
                    apply_snapshot(&mut acc.config, snap);
                    let config = acc.config.clone();
                    if let Some(persist) = &persist {
                        persist(&config);
                    }
                }
            });
        let auth = Arc::new(KiroAuth::new(
            &config,
            &self.settings.region,
            self.settings.api_region.as_deref(),
            self.settings.runtime_base_url.clone(),
            self.http.client(),
            Some(on_change),
        )?);
        self.auths
            .lock()
            .await
            .insert(account_id.to_string(), auth.clone());
        Ok(auth)
    }

    async fn try_ensure_auth(&self, account_id: &str) -> bool {
        match self.ensure_auth(account_id).await {
            Ok(_) => true,
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
                    acc.state.last_error = Some(message.clone());
                    acc.state.last_response_kind = Some("auth".into());
                    acc.state.status = AccountStatus::AuthFailed;
                    acc.state.status_reason = Some(message.chars().take(200).collect());
                    acc.state.status_updated_at = now_ms();
                }
                false
            }
        }
    }

    /// kiro ordering: model → availability → auth init.
    async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<KiroAuth>)> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                if !self.pool.lock().await.has_model(&id, model) {
                    continue;
                }
                if !self.try_ensure_auth(&id).await {
                    continue;
                }
                let auth = self.auths.lock().await.get(&id).cloned();
                let mut pool = self.pool.lock().await;
                pool.commit(&id);
                if let (Some(acc), Some(auth)) = (pool.find(&id).cloned(), auth) {
                    return Some((acc, auth));
                }
            }
        }
        None
    }

    /// `callKiro` — POST {apiHost}/generateAssistantResponse; 403 → force
    /// refresh once; 429/5xx backoff; other 4xx non-retryable.
    async fn call_kiro(
        &self,
        auth: &Arc<KiroAuth>,
        payload: &Value,
    ) -> anyhow::Result<reqwest::Response> {
        let url = format!("{}/generateAssistantResponse", auth.api_host());
        let mut last_error = String::new();
        let max = self.settings.max_retries.max(1);
        for attempt in 0..max {
            let token = auth.get_access_token().await?;
            let mut req = self
                .http
                .client()
                .post(&url)
                .header("connection", "close")
                .json(payload)
                .timeout(self.settings.first_token_timeout);
            for (k, v) in auth.build_headers(&token) {
                req = req.header(k, v);
            }
            match req.send().await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status == 403 && attempt == 0 {
                        let _ = auth.force_refresh().await;
                        continue;
                    }
                    if status < 400 {
                        return Ok(res);
                    }
                    let text = res.text().await.unwrap_or_default();
                    last_error = format!(
                        "Kiro HTTP {status}: {}",
                        text.chars().take(1000).collect::<String>()
                    );
                    if status == 429 || status >= 500 {
                        tokio::time::sleep(Duration::from_millis(500 * 2_u64.pow(attempt as u32)))
                            .await;
                        continue;
                    }
                    anyhow::bail!(NonRetryable(last_error));
                }
                Err(e) => {
                    last_error = e.to_string();
                    if attempt + 1 < max {
                        tokio::time::sleep(Duration::from_millis(500 * 2_u64.pow(attempt as u32)))
                            .await;
                    }
                }
            }
        }
        anyhow::bail!(last_error)
    }

    fn build_payload(
        &self,
        format: &'static str,
        body: &Value,
        model: &str,
        profile_arn: &str,
    ) -> anyhow::Result<Value> {
        if format == "openai" {
            build_kiro_payload_from_openai(body, model, profile_arn)
        } else {
            build_kiro_payload_from_anthropic(body, model, profile_arn)
        }
    }

    async fn non_stream(
        &self,
        format: &'static str,
        model: &str,
        kiro_model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let _permits = self.limiter.acquire(body).await;
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.pool.lock().await.accounts.len().max(1);
        for _ in 0..total {
            let Some((account, auth)) = self.get_account_for_model(kiro_model, &excluded).await
            else {
                break;
            };
            let started = now_ms();
            let profile_arn = auth.profile_arn().await;
            let payload = match self.build_payload(format, body, kiro_model, &profile_arn) {
                Ok(p) => p,
                Err(e) => {
                    last_error = e.to_string();
                    break;
                }
            };
            match self.call_kiro(&auth, &payload).await {
                Ok(res) => {
                    let events = parse_kiro_stream(
                        res,
                        self.settings.first_token_timeout,
                        self.settings.streaming_read_timeout,
                    );
                    let result = if format == "openai" {
                        openai_json_from_kiro(
                            events,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            &account.config.id,
                        )
                        .await
                    } else {
                        anthropic_json_from_kiro(
                            events,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            &account.config.id,
                        )
                        .await
                    };
                    match result {
                        Ok(parsed) => {
                            self.pool.lock().await.report_success(&account.config.id);
                            self.log_entry(
                                LogLevel::Info,
                                "Upstream success",
                                Some(&account),
                                Some(&ctx.request_id),
                                Some(model),
                                Some((now_ms() - started) as u64),
                                None,
                            );
                            return GatewayResponse::json(200, parsed);
                        }
                        Err(e) => {
                            last_error = e.to_string();
                            let classified = classify_kiro_error(&last_error);
                            if classified.kind != ResponseKind::ModelError {
                                self.pool.lock().await.report_failure(
                                    &account.config.id,
                                    &last_error,
                                    &classified,
                                );
                                excluded.insert(account.config.id.clone());
                            }
                            if classified.kind == ResponseKind::ModelError {
                                break;
                            }
                        }
                    }
                }
                Err(e) => {
                    if ctx.cancel.is_cancelled() {
                        return GatewayResponse::error(
                            499,
                            "Client aborted request",
                            "client_aborted",
                        );
                    }
                    last_error = e.to_string();
                    let classified = classify_kiro_error(&last_error);
                    if classified.kind != ResponseKind::ModelError {
                        self.pool.lock().await.report_failure(
                            &account.config.id,
                            &last_error,
                            &classified,
                        );
                        excluded.insert(account.config.id.clone());
                    }
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    if classified.kind == ResponseKind::ModelError {
                        break;
                    }
                }
            }
        }
        let message = format!(
            "Kiro request failed: {}",
            if last_error.is_empty() {
                "No available accounts".into()
            } else {
                last_error
            }
        );
        GatewayResponse::error(502, message, "gateway_error")
    }

    fn stream(
        self: &Arc<Self>,
        format: &'static str,
        model: String,
        kiro_model: String,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> impl Stream<Item = String> + Send + 'static {
        let view = self.clone();
        let request_id = ctx.request_id.clone();
        let on_usage = ctx.on_usage.clone();
        let cancel = ctx.cancel.clone();
        async_stream::stream! {
            let _permits = view.limiter.acquire(&body).await;
            let mut excluded = HashSet::new();
            let mut last_error = String::new();
            let total = view.pool.lock().await.accounts.len().max(1);

            'outer: for _ in 0..total {
                let Some((account, auth)) = view.get_account_for_model(&kiro_model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let profile_arn = auth.profile_arn().await;
                let payload = match view.build_payload(format, &body, &kiro_model, &profile_arn) {
                    Ok(p) => p,
                    Err(e) => {
                        last_error = e.to_string();
                        break;
                    }
                };
                let res = match view.call_kiro(&auth, &payload).await {
                    Ok(r) => r,
                    Err(e) => {
                        if cancel.is_cancelled() {
                            break 'outer;
                        }
                        last_error = e.to_string();
                        let classified = classify_kiro_error(&last_error);
                        if classified.kind != ResponseKind::ModelError {
                            view.pool.lock().await.report_failure(
                                &account.config.id,
                                &last_error,
                                &classified,
                            );
                            excluded.insert(account.config.id.clone());
                        }
                        if classified.kind == ResponseKind::ModelError {
                            break 'outer;
                        }
                        continue;
                    }
                };

                let events = parse_kiro_stream(
                    res,
                    view.settings.first_token_timeout,
                    view.settings.streaming_read_timeout,
                );
                let account_id = account.config.id.clone();
                let sink = on_usage.clone();
                let inner: std::pin::Pin<Box<dyn Stream<Item = String> + Send>> = if format == "openai" {
                    Box::pin(openai_sse_from_kiro(events, model.clone(), body.clone(), sink, account_id.clone()))
                } else {
                    Box::pin(anthropic_sse_from_kiro(events, model.clone(), body.clone(), sink, account_id.clone()))
                };
                let mut inner = inner;
                use futures::StreamExt;
                while let Some(frame) = inner.next().await {
                    yield frame;
                }
                view.pool.lock().await.report_success(&account_id);
                view.log_entry(
                    LogLevel::Info,
                    "Upstream stream success",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }

            let message = format!(
                "Kiro stream failed: {}",
                if last_error.is_empty() { "No available accounts".to_string() } else { last_error }
            );
            if format == "openai" {
                yield format!(
                    "data: {}\n\n",
                    serde_json::to_string(&json!({
                        "error": {"message": message, "type": "gateway_error", "code": "kiro_error"},
                    }))
                    .unwrap_or_else(|_| "{}".into())
                );
                yield "data: [DONE]\n\n".to_string();
            } else {
                yield format!(
                    "event: error\ndata: {}\n\n",
                    serde_json::to_string(&json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": message},
                    }))
                    .unwrap_or_else(|_| "{}".into())
                );
            }
        }
    }

    /// `listAvailableModels` — apiGet('/ListAvailableModels') with 15min cache.
    async fn list_available_models(&self, account_id: &str, force: bool) -> anyhow::Result<Value> {
        if !force
            && let Some((at, models)) = self.models_cache.lock().await.get(account_id)
            && now_ms() - *at < MODELS_CACHE_TTL_MS
        {
            return Ok(
                json!({ "models": models.iter().map(|m| json!({"modelId": m, "modelName": m})).collect::<Vec<_>>() }),
            );
        }
        let auth = self.ensure_auth(account_id).await?;
        let mut params = vec![("origin", "AI_EDITOR")];
        let arn = auth.profile_arn().await;
        if !arn.is_empty() {
            params.push(("profileArn", &arn));
        }
        let result = auth.api_get("/ListAvailableModels", &params).await;
        match result {
            Ok(data) => {
                let ids: Vec<String> = data
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m.get("modelId").and_then(Value::as_str))
                            .map(normalize_kiro_model_id)
                            .collect()
                    })
                    .unwrap_or_default();
                if !ids.is_empty() {
                    self.models_cache
                        .lock()
                        .await
                        .insert(account_id.to_string(), (now_ms(), ids.clone()));
                    let mut pool = self.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.model_ids = ids;
                        acc.state.models_cached_at = now_ms();
                    }
                }
                Ok(data)
            }
            Err(e) => {
                self.log_entry(
                    LogLevel::Warn,
                    format!("listAvailableModels failed for {account_id}: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(
                    json!({ "models": FALLBACK_MODELS.iter().map(|m| json!({"modelId": m, "modelName": m})).collect::<Vec<_>>() }),
                )
            }
        }
    }
}

#[derive(Debug)]
struct NonRetryable(String);
impl std::fmt::Display for NonRetryable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for NonRetryable {}

fn apply_snapshot(config: &mut AccountFile, snap: &KiroSnapshot) {
    let fields = &mut config.fields;
    if !snap.access_token.is_empty() {
        fields.insert("accessToken".into(), json!(snap.access_token));
    }
    if !snap.refresh_token.is_empty() {
        fields.insert("refreshToken".into(), json!(snap.refresh_token));
    }
    if snap.expires_at_ms > 0
        && let Some(iso) = chrono::DateTime::from_timestamp_millis(snap.expires_at_ms)
    {
        fields.insert("expiresAt".into(), json!(iso.to_rfc3339()));
    }
    if !snap.profile_arn.is_empty() {
        fields.insert("profileArn".into(), json!(snap.profile_arn));
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for KiroProvider {
    fn name(&self) -> &'static str {
        "kiro"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        let models = {
            let pool = self.core.pool.lock().await;
            let set = pool.list_models();
            if set.is_empty() {
                FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
            } else {
                set
            }
        };
        models
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "kiro".into(),
                owned_by: Some("kiro".into()),
                description: Some("Model via Kiro GatewayHub provider".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_kiro_model_id(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_KIRO_MODEL),
        );
        let stream = body.get("stream").and_then(Value::as_bool) != Some(false);
        if stream {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(
                    "openai",
                    model.clone(),
                    model,
                    body,
                    ctx,
                )),
            };
        }
        self.core
            .non_stream("openai", &model, &model, &body, ctx)
            .await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_kiro_model_id(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_KIRO_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(
                    "anthropic",
                    model.clone(),
                    model,
                    body,
                    ctx,
                )),
            };
        }
        self.core
            .non_stream("anthropic", &model, &model, &body, ctx)
            .await
    }

    async fn count_tokens(
        &self,
        body: Value,
        _ctx: &GatewayRequestContext,
    ) -> Option<GatewayResponse> {
        Some(GatewayResponse::json(
            200,
            json!({ "input_tokens": anthropic_input_tokens(&body) }),
        ))
    }

    async fn test_account(&self, account_id: &str) -> AccountTestResult {
        let auth = match self.core.ensure_auth(account_id).await {
            Ok(a) => a,
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.core.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.last_error = Some(message.clone());
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
                    acc.state.status = AccountStatus::AuthFailed;
                    acc.state.status_reason = Some(message.chars().take(200).collect());
                    acc.state.status_updated_at = now_ms();
                }
                return AccountTestResult {
                    ok: false,
                    account_id: account_id.into(),
                    message,
                    ..Default::default()
                };
            }
        };
        match auth.get_access_token().await {
            Ok(_) => {
                let models = self
                    .core
                    .pool
                    .lock()
                    .await
                    .find(account_id)
                    .map(|a| a.state.model_ids.clone())
                    .unwrap_or_default();
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: "Account token is valid".into(),
                    models,
                    auth_type: Some(
                        match auth.auth_type().await {
                            KiroAuthType::KiroDesktop => "kiro_desktop",
                            KiroAuthType::AwsSsoOidc => "aws_sso_oidc",
                        }
                        .into(),
                    ),
                    expires_at: auth.expires_at_iso().await,
                }
            }
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.core.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.last_error = Some(message.clone());
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
                    acc.state.status = AccountStatus::AuthFailed;
                    acc.state.status_reason = Some(message.chars().take(200).collect());
                    acc.state.status_updated_at = now_ms();
                }
                AccountTestResult {
                    ok: false,
                    account_id: account_id.into(),
                    message,
                    ..Default::default()
                }
            }
        }
    }

    async fn get_account_info(&self, account_id: &str) -> anyhow::Result<Value> {
        let config = {
            let pool = self.core.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let Some(config) = config else {
            anyhow::bail!("Account not found");
        };
        let auth = self.core.ensure_auth(account_id).await?;

        // getUsageLimits + listAvailableModels in parallel (TS Promise.allSettled)
        let usage_fut = async {
            let arn = auth.profile_arn().await;
            if arn.is_empty() {
                return Err(anyhow::anyhow!(
                    "profileArn is not available for this account"
                ));
            }
            auth.api_get(
                "/getUsageLimits",
                &[
                    ("profileArn", arn.as_str()),
                    ("origin", "AI_EDITOR"),
                    ("resourceType", "AGENTIC_REQUEST"),
                    ("isEmailRequired", "true"),
                ],
            )
            .await
        };
        let models_fut = self.core.list_available_models(account_id, false);
        let (usage, models) = tokio::join!(usage_fut, models_fut);
        let usage = usage.ok();
        let models = models.ok();
        if usage.is_none() && models.is_none() {
            anyhow::bail!("Both API calls failed");
        }
        let breakdown = usage
            .as_ref()
            .and_then(|u| u.get("usageBreakdownList"))
            .and_then(Value::as_array)
            .and_then(|a| a.first().cloned());
        Ok(json!({
            "subscription": usage.as_ref().and_then(|u| u.get("subscriptionInfo")).cloned()
                .unwrap_or_else(|| json!({"title": "Unknown", "type": "unknown"})),
            "email": usage.as_ref().and_then(|u| u.pointer("/userInfo/email")).cloned()
                .or_else(|| config.email.clone().map(Value::String)),
            "usage": {
                "used": breakdown.as_ref().and_then(|b| b.get("currentUsage")).cloned().unwrap_or(json!(0)),
                "limit": breakdown.as_ref().and_then(|b| b.get("usageLimit")).cloned().unwrap_or(json!(0)),
                "overages": breakdown.as_ref().and_then(|b| b.get("currentOverages")).cloned().unwrap_or(json!(0)),
                "overageCap": breakdown.as_ref().and_then(|b| b.get("overageCap")).cloned().unwrap_or(json!(0)),
                "overageRate": breakdown.as_ref().and_then(|b| b.get("overageRate")).cloned().unwrap_or(json!(0)),
                "overageCharges": breakdown.as_ref().and_then(|b| b.get("overageCharges")).cloned().unwrap_or(json!(0)),
                "resetDate": usage.as_ref().and_then(|u| u.get("nextDateReset")).cloned().unwrap_or(json!("")),
            },
            "models": models.and_then(|m| m.get("models").cloned()).unwrap_or(json!([])),
        }))
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let pool = self.core.pool.lock().await;
            if pool.find(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
        }
        self.core.list_available_models(account_id, true).await?;
        Ok(self
            .core
            .pool
            .lock()
            .await
            .find(account_id)
            .map(|a| a.state.model_ids.clone())
            .unwrap_or_default())
    }

    async fn reset_account(&self, account_id: &str) -> anyhow::Result<()> {
        self.core.pool.lock().await.reset_account(account_id);
        Ok(())
    }

    async fn set_account_status(
        &self,
        account_id: &str,
        status: AccountStatus,
        reason: Option<String>,
    ) -> anyhow::Result<()> {
        self.core
            .pool
            .lock()
            .await
            .set_account_status(account_id, status, reason)
    }

    fn status(&self) -> ProviderStatus {
        let (accounts, models) = self
            .core
            .pool
            .try_lock()
            .map(|p| (p.accounts.len(), p.list_models()))
            .unwrap_or_default();
        ProviderStatus {
            name: "kiro".into(),
            provider_type: "kiro".into(),
            display_name: self.display_name.clone(),
            enabled: self.enabled,
            configured: accounts > 0,
            status: if !self.enabled {
                "disabled"
            } else if accounts > 0 {
                "ready"
            } else {
                "error"
            },
            message: if accounts > 0 {
                Some(format!("{accounts} account(s)"))
            } else {
                Some("No Kiro accounts configured".into())
            },
            models: if models.is_empty() {
                FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
            } else {
                models
            },
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyKiroError` port.
pub fn classify_kiro_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let status = regex::Regex::new(r"kiro http (\d{3})")
        .unwrap()
        .captures(&msg)
        .and_then(|c| c[1].parse::<u16>().ok())
        .unwrap_or(0);
    if msg.contains("refresh token is missing")
        || msg.contains("access token expired")
        || msg.contains("access token is invalid")
        || msg.contains("please add a new access token")
        || msg.contains("token refresh failed")
        || msg.contains("failed to obtain kiro access token")
    {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if status == 401 || status == 403 {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if status == 429 {
        if regex::Regex::new(r"monthly|quota|usage limit|overage cap|monthly limit|throttling")
            .unwrap()
            .is_match(&msg)
        {
            return ClassifiedError {
                kind: ResponseKind::Quota,
                cooldown_ms: 60 * 60_000,
                reset_at_iso: None,
            };
        }
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if status == 400
        && (msg.contains("invalid_model_id")
            || msg.contains("invalid model id")
            || msg.contains("select a different model"))
    {
        return ClassifiedError {
            kind: ResponseKind::ModelError,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if (500..600).contains(&status) {
        return ClassifiedError {
            kind: ResponseKind::ServerError,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    if msg.contains("first token timeout") || msg.contains("timeout") {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    if msg.contains("fetch failed")
        || msg.contains("econnrefused")
        || msg.contains("econnreset")
        || msg.contains("enotfound")
        || msg.contains("network")
    {
        return ClassifiedError {
            kind: ResponseKind::Network,
            cooldown_ms: 15_000,
            reset_at_iso: None,
        };
    }
    ClassifiedError {
        kind: ResponseKind::ServerError,
        cooldown_ms: 30_000,
        reset_at_iso: None,
    }
}

fn kiro_settings(settings: &JsonMap) -> KiroSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    let int = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    KiroSettings {
        region: settings
            .get("region")
            .and_then(Value::as_str)
            .unwrap_or("us-east-1")
            .to_string(),
        api_region: settings
            .get("apiRegion")
            .and_then(Value::as_str)
            .map(str::to_string),
        runtime_base_url: settings
            .get("runtimeBaseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 60)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 300)),
        max_retries: int("maxRetries", 3) as usize,
        max_concurrent_requests: int("maxConcurrentRequests", 4) as usize,
        max_concurrent_large: int("maxConcurrentLargePromptRequests", 1) as usize,
        large_prompt_bytes: int("largePromptBytes", 300_000) as usize,
        probabilistic_retry_chance: settings
            .get("probabilisticRetryChance")
            .and_then(Value::as_f64)
            .unwrap_or(0.1)
            .clamp(0.0, 1.0),
        account_max_backoff_multiplier: int("accountMaxBackoffMultiplier", 1440),
    }
}
