//! Codex provider — port of `providers/codex/` (GptWeb OAuth + the
//! `/codex/responses` Responses-API upstream). Unlike nvidia/openrouter
//! the upstream always streams; "non-stream" calls collect the stream.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::provider::ProviderAdapter;
use crate::providers::codex_auth::{AuthSnapshot, CodexAuth};
use crate::providers::codex_convert::{anthropic_to_responses_payload, chat_to_responses_payload};
use crate::providers::codex_stream::{
    anthropic_json_from_codex, anthropic_sse_from_codex, openai_json_from_codex,
    openai_sse_from_codex, parse_codex_stream,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind,
};

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
const DEFAULT_CODEX_MODEL: &str = "gpt-5";
const FALLBACK_MODELS: &[&str] = &[
    "gpt-5",
    "gpt-5-codex",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-pro",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
];
const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;
const MODELS_REFRESH_BACKOFF_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone)]
struct CodexSettings {
    base_url: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
    max_retries: usize,
    refresh_skew_seconds: u64,
}

/// `normalizeCodexModel` — strip `provider/` prefix + `-YYYY-MM-DD` tail.
pub fn normalize_codex_model(model: &str) -> String {
    let trimmed = model.trim().to_lowercase();
    let no_prefix = trimmed.split('/').next_back().unwrap_or("");
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"-\d{4}-\d{2}-\d{2}$").unwrap())
        .replace(no_prefix, "")
        .to_string()
}

fn responses_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/backend-api") {
        format!("{base}/codex/responses")
    } else {
        format!("{base}/api/codex/responses")
    }
}

fn models_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/backend-api") {
        format!("{base}/codex/models")
    } else {
        format!("{base}/codex/models")
    }
}

fn usage_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/backend-api") {
        format!("{base}/wham/usage")
    } else {
        format!("{base}/api/wham/usage")
    }
}

struct CodexBehavior;

impl crate::pool::PoolBehavior for CodexBehavior {
    fn provider_name(&self) -> &'static str {
        "codex"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_codex_model(model)
    }
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        // codex: empty modelIds falls back to the seed list
        let list: Vec<String> = if account.state.model_ids.is_empty() {
            FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
        } else {
            account.state.model_ids.clone()
        };
        list.iter().any(|m| normalize_codex_model(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
    }
    /// codex `resolveCooldown` — quota honors the upstream resetAtIso
    /// deadline; cooling base is `max(1000, cooldownMs || 30_000)`.
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
                let base = classified.cooldown_ms.max(30_000).max(1_000);
                let multiplier = 2_i64
                    .pow(account.state.failures.saturating_sub(1).min(6) as u32)
                    .min(64);
                (AccountStatus::Cooling, Some(now + base * multiplier))
            }
        }
    }
}

/// Shared provider state — everything the failover streams need is in an
/// `Arc` so the lazy stream can outlive the `&self` adapter call.
pub struct CodexCore {
    pool: Arc<Mutex<AccountPool<CodexBehavior>>>,
    /// Per-account OAuth managers, built lazily on first use.
    auths: Mutex<HashMap<String, Arc<CodexAuth>>>,
    /// Serializes per-account `/codex/models` fetches + failure backoff.
    model_refresh: Mutex<HashMap<String, i64>>, // account_id → last_failed_ms
    http: Arc<UpstreamHttp>,
    settings: Arc<CodexSettings>,
    persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
}

pub struct CodexProvider {
    core: Arc<CodexCore>,
    enabled: bool,
    display_name: Option<String>,
}

impl CodexProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = codex_settings(&provider_config.settings);
        let http = UpstreamHttp::new(settings.base_url.clone(), Some(proxy_url))?;

        let mut pool = AccountPool::new(CodexBehavior);
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
            core: Arc::new(CodexCore {
                pool: Arc::new(Mutex::new(pool)),
                auths: Mutex::new(HashMap::new()),
                model_refresh: Mutex::new(HashMap::new()),
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

impl CodexCore {
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
            provider: Some("codex".into()),
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

    /// `ensureInitialized` — lazily build the per-account auth manager and
    /// wire the token-refresh snapshot → account-file persist.
    async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<CodexAuth>> {
        if let Some(auth) = self.auths.lock().await.get(account_id) {
            return Ok(auth.clone());
        }
        let Some(config) = ({
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        }) else {
            anyhow::bail!("Account not found: {account_id}");
        };
        if !config.fields.contains_key("refreshToken") && !config.fields.contains_key("accessToken")
        {
            anyhow::bail!("Codex account has no tokens");
        }
        // Seed fallback models if none cached yet (modelsCachedAt stays 0 so
        // the TTL check still triggers a real refresh).
        {
            let mut pool = self.pool.lock().await;
            if let Some(acc) = pool.find_mut(account_id)
                && acc.state.model_ids.is_empty()
            {
                acc.state.model_ids = FALLBACK_MODELS.iter().map(|s| s.to_string()).collect();
            }
        }
        let persist = self.persist_account.clone();
        let account_id_owned = account_id.to_string();
        let on_change: Arc<dyn Fn(&str, &AuthSnapshot) + Send + Sync> = {
            let pool = self.pool.clone();
            Arc::new(move |acc_id: &str, snap: &AuthSnapshot| {
                // applySnapshot port — write refreshed tokens to config+file
                let mut pool_guard = pool.try_lock();
                if let Ok(ref mut pool) = pool_guard
                    && let Some(acc) = pool.find_mut(acc_id)
                {
                    apply_snapshot(&mut acc.config, snap);
                    let config = acc.config.clone();
                    if let Some(persist) = &persist {
                        persist(&config);
                    }
                }
            })
        };
        let auth = Arc::new(CodexAuth::new(
            &config,
            self.settings.refresh_skew_seconds,
            self.http.client(),
            Some(on_change),
        ));
        self.auths
            .lock()
            .await
            .insert(account_id_owned, auth.clone());
        Ok(auth)
    }

    /// `tryEnsureInitialized` — failures mark the account auth_failed.
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

    /// Account selection — codex ordering: model → availability → auth init.
    async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<CodexAuth>)> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                // model check under lock
                if !self.pool.lock().await.has_model(&id, model) {
                    continue;
                }
                // lazy model refresh (HTTP outside lock)
                self.maybe_refresh_models(&id).await;
                // auth init (async)
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

    /// `refreshAccountModels` — TTL + 5min failure backoff; serial via the
    /// model_refresh map (per-account in-flight dedup through the pool lock
    /// window being small — a duplicate fetch is harmless).
    async fn maybe_refresh_models(&self, account_id: &str) {
        let (fresh, backed_off) = {
            let pool = self.pool.lock().await;
            let fresh = pool.find(account_id).is_some_and(|a| {
                a.state.models_cached_at > 0
                    && now_ms() - a.state.models_cached_at < MODELS_CACHE_TTL_MS
                    && !a.state.model_ids.is_empty()
            });
            let failed_at = self.model_refresh.lock().await.get(account_id).copied();
            let backed_off = failed_at.is_some_and(|t| now_ms() - t < MODELS_REFRESH_BACKOFF_MS);
            (fresh, backed_off)
        };
        if fresh || backed_off {
            return;
        }
        let Some(auth) = self.ensure_auth(account_id).await.ok() else {
            self.model_refresh
                .lock()
                .await
                .insert(account_id.to_string(), now_ms());
            return;
        };
        match self.fetch_models(&auth).await {
            Ok(models) if !models.is_empty() => {
                let mut pool = self.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.model_ids = models;
                    acc.state.models_cached_at = now_ms();
                }
                self.model_refresh.lock().await.remove(account_id);
            }
            Ok(_) => {}
            Err(e) => {
                self.model_refresh
                    .lock()
                    .await
                    .insert(account_id.to_string(), now_ms());
                self.log_entry(
                    LogLevel::Warn,
                    format!("Failed to fetch Codex models: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
            }
        }
    }

    /// `fetchCodexModels` — GET /codex/models?client_version=<semver>.
    async fn fetch_models(&self, auth: &Arc<CodexAuth>) -> anyhow::Result<Vec<String>> {
        let token = auth
            .get_access_token()
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let headers = auth
            .build_headers(&token)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let url = format!(
            "{}?client_version={}",
            models_url(&self.settings.base_url),
            url_encode(env!("CARGO_PKG_VERSION"))
        );
        let mut req = self
            .http
            .client()
            .get(&url)
            .timeout(Duration::from_secs(15));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let res = req.send().await?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        if status >= 400 {
            anyhow::bail!(
                "GET {url} failed ({status}): {}",
                text.chars().take(500).collect::<String>()
            );
        }
        let payload: Value = serde_json::from_str(&text)?;
        let mut models: Vec<(i64, String)> = payload
            .get("models")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter(|m| {
                        m.get("slug").and_then(Value::as_str).is_some()
                            && m.get("supported_in_api").and_then(Value::as_bool) != Some(false)
                            && m.get("visibility").and_then(Value::as_str) != Some("hidden")
                    })
                    .map(|m| {
                        (
                            m.get("priority")
                                .and_then(Value::as_i64)
                                .unwrap_or(i64::MAX),
                            m["slug"].as_str().unwrap_or("").to_string(),
                        )
                    })
                    .collect()
            })
            .unwrap_or_default();
        models.sort_by_key(|(p, _)| *p);
        Ok(models.into_iter().map(|(_, s)| s).collect())
    }

    /// `fetchCodexRateLimits` — GET /wham/usage.
    async fn fetch_rate_limits(&self, auth: &Arc<CodexAuth>) -> anyhow::Result<Value> {
        let token = auth
            .get_access_token()
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let headers = auth
            .build_headers(&token)
            .await
            .map_err(|e| anyhow::anyhow!("{e}"))?;
        let url = usage_url(&self.settings.base_url);
        let mut req = self
            .http
            .client()
            .get(&url)
            .timeout(Duration::from_secs(15));
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let res = req.send().await?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        if status >= 400 {
            anyhow::bail!(
                "GET {url} failed ({status}): {}",
                text.chars().take(500).collect::<String>()
            );
        }
        let payload: Value = serde_json::from_str(&text)?;
        let rl = payload.get("rate_limit");
        Ok(json!({
            "primary": map_window(rl.and_then(|r| r.get("primary_window"))),
            "secondary": map_window(rl.and_then(|r| r.get("secondary_window"))),
            "planType": payload.get("plan_type"),
            "fetchedAt": chrono::Local::now().to_rfc3339(),
        }))
    }

    /// `callCodex` — inner retry loop: 401→force-refresh once, 429/5xx
    /// exponential backoff, other 4xx non-retryable.
    async fn call_codex(
        &self,
        auth: &Arc<CodexAuth>,
        payload: &Value,
    ) -> anyhow::Result<reqwest::Response> {
        let url = responses_url(&self.settings.base_url);
        let mut last_error = String::new();
        for attempt in 0..self.settings.max_retries.max(1) {
            let token = auth
                .get_access_token()
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let headers = auth
                .build_headers(&token)
                .await
                .map_err(|e| anyhow::anyhow!("{e}"))?;
            let mut req = self
                .http
                .client()
                .post(&url)
                .header("accept", "text/event-stream")
                .json(payload)
                .timeout(self.settings.first_token_timeout);
            for (k, v) in headers {
                req = req.header(k, v);
            }
            match req.send().await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    if (status == 401 || status == 403) && attempt == 0 {
                        let _ = auth.force_refresh().await;
                        continue;
                    }
                    if status < 400 {
                        return Ok(res);
                    }
                    let text = res.text().await.unwrap_or_default();
                    last_error = format!(
                        "Codex HTTP {status}: {}",
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
                    if attempt + 1 < self.settings.max_retries.max(1) {
                        tokio::time::sleep(Duration::from_millis(500 * 2_u64.pow(attempt as u32)))
                            .await;
                    }
                }
            }
        }
        anyhow::bail!(last_error)
    }

    /// Non-stream failover — collect the upstream SSE into one JSON
    /// (TS `nonStreamWithFailover`).
    async fn non_stream(
        &self,
        format: &'static str,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.pool.lock().await.accounts.len().max(1);
        for _ in 0..total {
            let Some((account, auth)) = self.get_account_for_model(model, &excluded).await else {
                break;
            };
            let started = now_ms();
            let payload = if format == "openai" {
                chat_to_responses_payload(body, &normalize_codex_model)
            } else {
                anthropic_to_responses_payload(body, &normalize_codex_model)
            };
            match self.call_codex(&auth, &payload).await {
                Ok(res) => {
                    let events = parse_codex_stream(
                        res,
                        self.settings.first_token_timeout,
                        self.settings.streaming_read_timeout,
                    );
                    let result = if format == "openai" {
                        openai_json_from_codex(
                            events,
                            model,
                            ctx.on_usage.as_ref(),
                            &account.config.id,
                        )
                        .await
                    } else {
                        anthropic_json_from_codex(
                            events,
                            model,
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
                                "Codex upstream success",
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
                            let classified = classify_codex_error(&last_error);
                            self.pool.lock().await.report_failure(
                                &account.config.id,
                                &last_error,
                                &classified,
                            );
                            excluded.insert(account.config.id.clone());
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
                    let classified = classify_codex_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Codex upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    excluded.insert(account.config.id.clone());
                }
            }
        }
        let message = format!(
            "Codex request failed: {}",
            if last_error.is_empty() {
                "No available accounts".into()
            } else {
                last_error
            }
        );
        GatewayResponse::error(502, message, "gateway_error")
    }

    /// Streaming failover — retries ONLY on FirstTokenTimeoutError
    /// (mid-stream errors would duplicate output).
    fn stream(
        self: &Arc<Self>,
        format: &'static str,
        model: String,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> impl Stream<Item = String> + Send + 'static {
        let view = self.clone();
        let request_id = ctx.request_id.clone();
        let on_usage = ctx.on_usage.clone();
        let cancel = ctx.cancel.clone();
        async_stream::stream! {
            let mut excluded = HashSet::new();
            let mut last_error = String::new();
            let total = view.pool.lock().await.accounts.len().max(1);

            'outer: for _ in 0..total {
                let Some((account, auth)) = view.get_account_for_model(&model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let payload = if format == "openai" {
                    chat_to_responses_payload(&body, &normalize_codex_model)
                } else {
                    anthropic_to_responses_payload(&body, &normalize_codex_model)
                };
                let res = match view.call_codex(&auth, &payload).await {
                    Ok(r) => r,
                    Err(e) => {
                        if cancel.is_cancelled() {
                            break 'outer;
                        }
                        last_error = e.to_string();
                        let classified = classify_codex_error(&last_error);
                        view.pool.lock().await.report_failure(
                            &account.config.id,
                            &last_error,
                            &classified,
                        );
                        excluded.insert(account.config.id.clone());
                        continue;
                    }
                };

                // the upstream stream — failures mid-stream end the attempt
                let events = parse_codex_stream(
                    res,
                    view.settings.first_token_timeout,
                    view.settings.streaming_read_timeout,
                );
                let account_id = account.config.id.clone();
                let sink = on_usage.clone();
                let inner: std::pin::Pin<Box<dyn Stream<Item = String> + Send>> = if format == "openai" {
                    Box::pin(openai_sse_from_codex(events, model.clone(), sink, account_id.clone()))
                } else {
                    Box::pin(anthropic_sse_from_codex(events, model.clone(), sink, account_id.clone()))
                };
                let mut inner = inner;
                use futures::StreamExt;
                while let Some(frame) = inner.next().await {
                    yield frame;
                }

                // completed — success
                view.pool.lock().await.report_success(&account_id);
                view.log_entry(
                    LogLevel::Info,
                    "Codex stream success",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }

            let message = format!(
                "Codex stream failed: {}",
                if last_error.is_empty() {
                    "No available accounts".to_string()
                } else {
                    last_error
                }
            );
            if format == "openai" {
                yield format!(
                    "data: {}\n\n",
                    serde_json::to_string(&json!({
                        "error": {"message": message, "type": "gateway_error", "code": "codex_error"},
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
}

#[derive(Debug)]
struct NonRetryable(String);
impl std::fmt::Display for NonRetryable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for NonRetryable {}

fn apply_snapshot(config: &mut AccountFile, snap: &AuthSnapshot) {
    fn set(config: &mut AccountFile, k: &str, v: &str) {
        if !v.is_empty() {
            config.fields.insert(k.into(), json!(v));
        }
    }
    set(config, "accessToken", &snap.access_token);
    set(config, "refreshToken", &snap.refresh_token);
    set(config, "idToken", &snap.id_token);
    set(config, "gptWebAccountId", &snap.gpt_web_account_id);
    if snap.expires_at_ms > 0 {
        config
            .fields
            .insert("expiresAt".into(), json!(snap.expires_at_ms));
    }
    set(config, "lastRefresh", &snap.last_refresh_iso);
    set(
        config,
        "subscriptionActiveUntil",
        &snap.subscription_active_until,
    );
    set(config, "name", &snap.name);
    if !snap.email.is_empty() {
        config.email = Some(snap.email.clone());
    }
}

fn map_window(window: Option<&Value>) -> Value {
    let Some(w) = window else {
        return Value::Null;
    };
    let used = w.get("used_percent").and_then(Value::as_f64).unwrap_or(0.0);
    let window_mins = w
        .get("limit_window_seconds")
        .and_then(Value::as_f64)
        .filter(|s| *s > 0.0)
        .map(|s| (s / 60.0).ceil() as i64);
    let resets_at = if let Some(r) = w
        .get("reset_at")
        .and_then(Value::as_f64)
        .filter(|r| *r > 0.0)
    {
        // upstream may give seconds or ms — pick by magnitude
        Some(if r < 1e12 {
            (r * 1000.0) as i64
        } else {
            r as i64
        })
    } else {
        w.get("reset_after_seconds")
            .and_then(Value::as_f64)
            .filter(|s| *s > 0.0)
            .map(|s| now_ms() + (s * 1000.0) as i64)
    };
    json!({
        "usedPercent": used,
        "windowDurationMins": window_mins,
        "resetsAt": resets_at,
    })
}

fn url_encode(s: &str) -> String {
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
            _ => format!("%{:02X}", c as u32),
        })
        .collect()
}

#[async_trait::async_trait]
impl ProviderAdapter for CodexProvider {
    fn name(&self) -> &'static str {
        "codex"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        // trigger background refresh for all enabled accounts
        let core = &self.core;
        let ids: Vec<String> = {
            let pool = core.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| a.config.enabled)
                .map(|a| a.config.id.clone())
                .collect()
        };
        for id in ids {
            core.maybe_refresh_models(&id).await;
        }
        let models = {
            let pool = core.pool.lock().await;
            let set: Vec<String> = pool.list_models();
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
                provider: "codex".into(),
                owned_by: Some("codex".into()),
                description: Some("Model via Codex (GptWeb) provider".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_codex_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_CODEX_MODEL),
        );
        let stream = body.get("stream").and_then(Value::as_bool) != Some(false);
        if stream {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("openai", model, body, ctx)),
            };
        }
        self.core.non_stream("openai", &model, &body, ctx).await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_codex_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_CODEX_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("anthropic", model, body, ctx)),
            };
        }
        self.core.non_stream("anthropic", &model, &body, ctx).await
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
            Ok(_token) => {
                // force a fresh model fetch, clear failure backoff
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.models_cached_at = 0;
                    }
                }
                self.core.model_refresh.lock().await.remove(account_id);
                self.core.maybe_refresh_models(account_id).await;
                let (models, expires) = {
                    let pool = self.core.pool.lock().await;
                    (
                        pool.find(account_id)
                            .map(|a| a.state.model_ids.clone())
                            .unwrap_or_default(),
                        auth.expires_at_iso().await,
                    )
                };
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: "Codex account is valid".into(),
                    models,
                    auth_type: Some(auth.auth_type().into()),
                    expires_at: expires,
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
        let rate_limits = self.core.fetch_rate_limits(&auth).await.ok();
        Ok(json!({
            "id": config.id,
            "email": config.email,
            "name": config.fields.get("name"),
            "gptWebAccountId": config.fields.get("gptWebAccountId"),
            "subscriptionActiveUntil": config.fields.get("subscriptionActiveUntil"),
            "expiresAt": config.fields.get("expiresAt"),
            "lastRefresh": config.fields.get("lastRefresh"),
            "rateLimits": rate_limits,
        }))
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let mut pool = self.core.pool.lock().await;
            if pool.find_mut(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
            if let Some(acc) = pool.find_mut(account_id) {
                acc.state.models_cached_at = 0;
            }
        }
        self.core.model_refresh.lock().await.remove(account_id);
        self.core.maybe_refresh_models(account_id).await;
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
            name: "codex".into(),
            provider_type: "codex".into(),
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
                Some("No Codex accounts configured".into())
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

/// `classifyCodexError` port.
pub fn classify_codex_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let status = regex::Regex::new(r"codex http (\d{3})")
        .unwrap()
        .captures(&msg)
        .and_then(|c| c[1].parse::<u16>().ok())
        .unwrap_or(0);
    if msg.contains("refresh token")
        || msg.contains("access token")
        || msg.contains("gptweb-account-id")
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
        if msg.contains("quota") || msg.contains("usage limit") || msg.contains("exceeded") {
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

fn codex_settings(settings: &JsonMap) -> CodexSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    CodexSettings {
        base_url: settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or(CODEX_BASE_URL)
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 30)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 600)),
        max_retries: settings
            .get("maxRetries")
            .and_then(Value::as_u64)
            .unwrap_or(2) as usize,
        refresh_skew_seconds: secs("refreshSkewSeconds", 60),
    }
}
