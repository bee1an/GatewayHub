//! GptWeb provider — port of `providers/gptweb/provider.ts` + `accountPool.ts`.
//! Sentinel → conduit → /f/conversation JSON-patch stream.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::protocol::{
    anthropic_messages_to_openai, openai_completion_to_anthropic, openai_sse_to_anthropic,
};
use crate::provider::ProviderAdapter;
use crate::providers::gptweb_upstream::{
    DEFAULT_GPT_WEB_BASE_URL, GPT_WEB_KNOWN_MODELS, GptWebStreamingState,
    build_non_stream_response, convert_openai_to_gptweb_body, fetch_conduit_token,
    fetch_gptweb_models, fetch_sentinel_tokens, normalize_gptweb_model, parse_gptweb_sse,
    stream_conversation,
};
use crate::providers::kiro_convert::estimate_tokens;
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind, UsageMeta, UsageStats,
};

const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

#[derive(Debug, Clone)]
struct GptWebSettings {
    base_url: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
}

struct GptWebBehavior;
impl crate::pool::PoolBehavior for GptWebBehavior {
    fn provider_name(&self) -> &'static str {
        "gptWeb"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_gptweb_model(model)
    }
    fn account_has_model(&self, _account: &AccountWithState, _model: &str) -> bool {
        true
    }
    fn seed_models(&self) -> Vec<String> {
        Vec::new()
    }
}

pub struct GptWebProvider {
    core: Arc<GptWebCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct GptWebCore {
    pool: Arc<Mutex<AccountPool<GptWebBehavior>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<GptWebSettings>,
    log: LogSink,
}

impl GptWebProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        _persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = gptweb_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.base_url, Some(proxy_url))?;

        let mut pool = AccountPool::new(GptWebBehavior);
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
        // seed known models for free accounts
        for acc in &mut pool.accounts {
            if is_free_account(&acc.config) && acc.state.model_ids.is_empty() {
                acc.state.model_ids = GPT_WEB_KNOWN_MODELS.iter().map(|s| s.to_string()).collect();
                acc.state.models_cached_at = now_ms();
            }
        }

        Ok(Self {
            core: Arc::new(GptWebCore {
                pool: Arc::new(Mutex::new(pool)),
                http: Arc::new(http),
                settings: Arc::new(settings),
                log,
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
}

impl GptWebCore {
    fn log_entry(
        &self,
        level: LogLevel,
        message: impl Into<String>,
        account: Option<&AccountWithState>,
        request_id: Option<&str>,
        duration_ms: Option<u64>,
        extra: Option<Value>,
    ) {
        (self.log)(GatewayLogEntry {
            ts: now_ms(),
            level,
            message: message.into(),
            provider: Some("gptWeb".into()),
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
            model: None,
            api_format: None,
            usage: extra,
            cost: None,
            error: None,
            extra: Default::default(),
        });
    }

    /// `getAccount` — no model filter, two-pass rotation.
    async fn get_account(&self, excluded: &HashSet<String>) -> Option<AccountWithState> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                let mut pool = self.pool.lock().await;
                pool.commit(&id);
                if let Some(acc) = pool.find(&id).cloned() {
                    return Some(acc);
                }
            }
        }
        None
    }

    /// `maybeRefreshModels` — free accounts on the known fallback keep the
    /// cached list; others re-fetch after TTL.
    async fn maybe_refresh_models(&self, account_id: &str) {
        {
            let pool = self.pool.lock().await;
            let Some(acc) = pool.find(account_id) else {
                return;
            };
            if is_free_account(&acc.config) && is_known_fallback(&acc.state.model_ids) {
                return;
            }
            if acc.state.models_cached_at > 0
                && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
            {
                return;
            }
        }
        let _ = self.refresh_models(account_id).await;
    }

    async fn refresh_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        let config = {
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let Some(config) = config else {
            anyhow::bail!("Account not found");
        };
        let models = fetch_gptweb_models(&self.http.client(), &self.settings.base_url, &config)
            .await
            .unwrap_or_default();
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            if !models.is_empty() {
                acc.state.model_ids = models.clone();
                acc.state.models_cached_at = now_ms();
            }
            Ok(acc.state.model_ids.clone())
        } else {
            anyhow::bail!("Account not found")
        }
    }

    /// `doRequest` — sentinel → conduit → stream, collect text.
    async fn do_request(
        &self,
        account: &AccountWithState,
        model: &str,
        body: &Value,
    ) -> anyhow::Result<String> {
        let chat_body = convert_openai_to_gptweb_body(
            body.get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .as_slice(),
            model,
        );
        let sentinel = fetch_sentinel_tokens(
            &self.http.client(),
            &self.settings.base_url,
            &account.config,
        )
        .await;
        let conduit = fetch_conduit_token(
            &self.http.client(),
            &self.settings.base_url,
            &account.config,
            &chat_body,
            &sentinel,
        )
        .await?;
        let lines = stream_conversation(
            self.http.client(),
            self.settings.base_url.clone(),
            account.config.clone(),
            chat_body,
            sentinel,
            conduit,
            self.settings.first_token_timeout + self.settings.streaming_read_timeout,
        );
        use futures::StreamExt;
        let mut state = GptWebStreamingState::default();
        let mut lines = Box::pin(lines);
        while let Some(line) = lines.next().await {
            let line = line?;
            let _ = parse_gptweb_sse(&line, &mut state);
        }
        if state.content.is_empty() {
            anyhow::bail!("Empty response from GptWeb");
        }
        Ok(state.content)
    }

    /// `streamConversationDirect` inside `streamWithFailover`.
    fn stream(
        self: &Arc<Self>,
        model: String,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> impl Stream<Item = String> + Send + 'static {
        let view = self.clone();
        let request_id = ctx.request_id.clone();
        let on_usage = ctx.on_usage.clone();
        async_stream::stream! {
            let mut excluded = HashSet::new();
            let mut last_error = String::new();
            let total = view.pool.lock().await.accounts.len().max(1);
            for attempt in 0..total {
                let Some(account) = view.get_account(&excluded).await else {
                    break;
                };
                let started = now_ms();
                let chat_body = convert_openai_to_gptweb_body(
                    body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default().as_slice(),
                    &model,
                );
                // sentinel + conduit before streaming
                let sentinel = fetch_sentinel_tokens(
                    &view.http.client(),
                    &view.settings.base_url,
                    &account.config,
                )
                .await;
                let conduit = fetch_conduit_token(
                    &view.http.client(),
                    &view.settings.base_url,
                    &account.config,
                    &chat_body,
                    &sentinel,
                )
                .await;
                let conduit = match conduit {
                    Ok(c) => c,
                    Err(e) => {
                        let err = e.to_string();
                        let classified = classify_gptweb_error(&err);
                        view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                        excluded.insert(account.config.id.clone());
                        last_error = err;
                        if !matches!(classified.kind, ResponseKind::Timeout | ResponseKind::Network) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                        continue;
                    }
                };
                let lines = stream_conversation(
                    view.http.client(),
                    view.settings.base_url.clone(),
                    account.config.clone(),
                    chat_body,
                    sentinel,
                    conduit,
                    view.settings.first_token_timeout + view.settings.streaming_read_timeout,
                );
                use futures::StreamExt;
                let mut state = GptWebStreamingState::default();
                let mut lines = Box::pin(lines);
                let mut stream_error: Option<String> = None;
                let mut done = false;
                while let Some(item) = lines.next().await {
                    match item {
                        Ok(line) => {
                            let (chunk, d) = parse_gptweb_sse(&line, &mut state);
                            if let Some(chunk) = chunk {
                                yield chunk;
                            }
                            if d {
                                done = true;
                                break;
                            }
                        }
                        Err(e) => {
                            stream_error = Some(e.to_string());
                            break;
                        }
                    }
                }
                if let Some(err) = stream_error {
                    let classified = classify_gptweb_error(&err);
                    view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                    excluded.insert(account.config.id.clone());
                    view.log_entry(
                        LogLevel::Warn,
                        format!("GptWeb stream failed: {err}"),
                        Some(&account),
                        Some(&request_id),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    last_error = err;
                    if !matches!(classified.kind, ResponseKind::Timeout | ResponseKind::Network) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
                let _ = done;
                yield "data: [DONE]\n\n".to_string();
                view.pool.lock().await.report_success(&account.config.id);
                view.log_entry(
                    LogLevel::Info,
                    "GptWeb upstream success (stream)",
                    Some(&account),
                    Some(&request_id),
                    Some((now_ms() - started) as u64),
                    None,
                );
                if let Some(sink) = &on_usage {
                    sink(
                        UsageStats {
                            input_tokens: 0,
                            output_tokens: estimate_tokens(&json!(state.content)),
                            estimated: Some(true),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some("gptWeb".into()),
                        },
                    );
                }
                return;
            }
            let message = if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            };
            yield format!(
                "data: {}\n\n",
                serde_json::to_string(&json!({
                    "error": {"message": message, "type": "server_error"},
                }))
                .unwrap_or_default()
            );
        }
    }
}

fn is_free_account(account: &AccountFile) -> bool {
    account
        .fields
        .get("planType")
        .and_then(Value::as_str)
        .unwrap_or("free")
        == "free"
}

fn is_known_fallback(models: &[String]) -> bool {
    if models.is_empty() {
        return true;
    }
    models
        .iter()
        .all(|m| GPT_WEB_KNOWN_MODELS.contains(&m.as_str()))
}

fn should_fallback_to_known_models(msg: &str) -> bool {
    let msg = msg.to_lowercase();
    if msg.contains("401") || msg.contains("unauthorized") || msg.contains("invalid_token") {
        return false;
    }
    msg.contains("403")
        || msg.contains("challenge")
        || msg.contains("unusual activity")
        || msg.contains("cloudflare")
}

#[async_trait::async_trait]
impl ProviderAdapter for GptWebProvider {
    fn name(&self) -> &'static str {
        "gptWeb"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        let ids = {
            let pool = self.core.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| a.config.enabled)
                .map(|a| a.config.id.clone())
                .collect::<Vec<_>>()
        };
        for id in &ids {
            self.core.maybe_refresh_models(id).await;
        }
        self.core
            .pool
            .lock()
            .await
            .list_models()
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "gptWeb".into(),
                owned_by: Some("openai".into()),
                description: Some("Model via GptWeb".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model =
            normalize_gptweb_model(body.get("model").and_then(Value::as_str).unwrap_or("auto"));
        // TS defaults stream:true when not explicitly false
        if body.get("stream").and_then(Value::as_bool) != Some(false) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(model, body, ctx)),
            };
        }
        match self.non_stream(&model, &body, ctx).await {
            Ok(v) => GatewayResponse::json(200, v),
            Err(e) => GatewayResponse::error(502, e.to_string(), "gateway_error"),
        }
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model =
            normalize_gptweb_model(body.get("model").and_then(Value::as_str).unwrap_or("auto"));
        let openai_body = anthropic_messages_to_openai(&body, &model);
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(openai_sse_to_anthropic(
                    self.core.clone().stream(model.clone(), openai_body, ctx),
                    model,
                )),
            };
        }
        match self.non_stream(&model, &openai_body, ctx).await {
            Ok(v) => GatewayResponse::json(200, openai_completion_to_anthropic(&v, &model, &body)),
            Err(e) => GatewayResponse::error(502, e.to_string(), "gateway_error"),
        }
    }

    async fn count_tokens(
        &self,
        body: Value,
        _ctx: &GatewayRequestContext,
    ) -> Option<GatewayResponse> {
        Some(GatewayResponse::json(
            200,
            json!({ "input_tokens": estimate_tokens(&body) }),
        ))
    }

    async fn test_account(&self, account_id: &str) -> AccountTestResult {
        let config = {
            let pool = self.core.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let Some(config) = config else {
            return AccountTestResult {
                ok: false,
                account_id: account_id.into(),
                message: "Account not found".into(),
                ..Default::default()
            };
        };
        match fetch_gptweb_models(
            &self.core.http.client(),
            &self.core.settings.base_url,
            &config,
        )
        .await
        {
            Ok(models) => {
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        if !models.is_empty() {
                            acc.state.model_ids = models.clone();
                            acc.state.models_cached_at = now_ms();
                        }
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_updated_at = now_ms();
                    }
                }
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: "GptWeb account is valid".into(),
                    models,
                    expires_at: None,
                    auth_type: Some("gptweb-token".into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                if should_fallback_to_known_models(&message) {
                    let mut pool = self.core.pool.lock().await;
                    let models = if let Some(acc) = pool.find_mut(account_id) {
                        let models: Vec<String> = if acc.state.model_ids.is_empty() {
                            GPT_WEB_KNOWN_MODELS.iter().map(|s| s.to_string()).collect()
                        } else {
                            acc.state.model_ids.clone()
                        };
                        acc.state.model_ids = models.clone();
                        acc.state.models_cached_at = now_ms();
                        acc.state.last_error = Some(message.clone());
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_reason =
                            Some("Model discovery blocked; using known models".into());
                        acc.state.status_updated_at = now_ms();
                        models
                    } else {
                        Vec::new()
                    };
                    return AccountTestResult {
                        ok: true,
                        account_id: account_id.into(),
                        message: format!(
                            "GptWeb models endpoint blocked; using known models: {message}"
                        ),
                        models,
                        expires_at: None,
                        auth_type: Some("gptweb-token".into()),
                    };
                }
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.failures += 1;
                        acc.state.last_failure_at = now_ms();
                        acc.state.last_error = Some(message.clone());
                        acc.state.status = AccountStatus::AuthFailed;
                        acc.state.status_reason = Some(message.chars().take(200).collect());
                        acc.state.status_updated_at = now_ms();
                    }
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
        {
            let pool = self.core.pool.lock().await;
            if pool.find(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
        }
        self.core.maybe_refresh_models(account_id).await;
        let (models, email, plan) = {
            let pool = self.core.pool.lock().await;
            let acc = pool.find(account_id);
            (
                acc.map(|a| {
                    if a.state.model_ids.is_empty() {
                        GPT_WEB_KNOWN_MODELS.iter().map(|s| s.to_string()).collect()
                    } else {
                        a.state.model_ids.clone()
                    }
                })
                .unwrap_or_default(),
                acc.and_then(|a| a.config.email.clone()),
                acc.and_then(|a| {
                    a.config
                        .fields
                        .get("planType")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| "free".into()),
            )
        };
        Ok(json!({
            "id": account_id,
            "subscription": {"title": "GptWeb", "type": plan},
            "email": email,
            "models": models.iter().map(|m| json!({
                "modelId": m, "modelName": m, "rateMultiplier": 1, "rateUnit": "request",
            })).collect::<Vec<_>>(),
        }))
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let pool = self.core.pool.lock().await;
            if pool.find(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
            if let Some(acc) = self.core.pool.lock().await.find_mut(account_id) {
                acc.state.models_cached_at = 0;
            }
        }
        self.core.refresh_models(account_id).await
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
            name: "gptWeb".into(),
            provider_type: "gptWeb".into(),
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
                Some("No GptWeb accounts configured".into())
            },
            models: if models.is_empty() {
                GPT_WEB_KNOWN_MODELS.iter().map(|s| s.to_string()).collect()
            } else {
                models
            },
            use_proxy: None,
            accounts,
        }
    }
}

impl GptWebProvider {
    async fn non_stream(
        &self,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> anyhow::Result<Value> {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.core.pool.lock().await.accounts.len().max(1);
        for attempt in 0..total {
            let Some(account) = self.core.get_account(&excluded).await else {
                break;
            };
            let started = now_ms();
            match self.core.do_request(&account, model, body).await {
                Ok(text) => {
                    self.core
                        .pool
                        .lock()
                        .await
                        .report_success(&account.config.id);
                    self.core.log_entry(
                        LogLevel::Info,
                        "GptWeb upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    if let Some(sink) = &ctx.on_usage {
                        sink(
                            UsageStats {
                                input_tokens: 0,
                                output_tokens: estimate_tokens(&json!(text)),
                                estimated: Some(true),
                                ..Default::default()
                            },
                            UsageMeta {
                                account_id: Some(account.config.id.clone()),
                                model: Some(model.to_string()),
                                provider: Some("gptWeb".into()),
                            },
                        );
                    }
                    return Ok(build_non_stream_response(
                        &text,
                        model,
                        estimate_tokens(&json!(text)),
                    ));
                }
                Err(e) => {
                    last_error = e.to_string();
                    let classified = classify_gptweb_error(&last_error);
                    self.core.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.core.log_entry(
                        LogLevel::Warn,
                        format!("GptWeb upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    if !matches!(
                        classified.kind,
                        ResponseKind::Timeout | ResponseKind::Network
                    ) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32)))
                        .await;
                }
            }
        }
        anyhow::bail!(
            "GptWeb request failed: {}",
            if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            }
        )
    }
}

/// `classifyGptWebError` port.
pub fn classify_gptweb_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |s: &str| msg.contains(s);
    if has("401") || has("unauthorized") || has("invalid_token") {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if has("fetch failed") || has("econn") || has("enotfound") || has("network") {
        return ClassifiedError {
            kind: ResponseKind::Network,
            cooldown_ms: 15_000,
            reset_at_iso: None,
        };
    }
    if has("429")
        || has("rate limit")
        || has("too many")
        || has("unusual activity")
        || has("turnstile")
        || has("challenge")
    {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has("quota") || has("capacity") {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 300_000,
            reset_at_iso: None,
        };
    }
    if has("timeout") || has("timed out") || has("aborted") {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 5_000,
            reset_at_iso: None,
        };
    }
    if has("econnrefused") {
        return ClassifiedError {
            kind: ResponseKind::Network,
            cooldown_ms: 10_000,
            reset_at_iso: None,
        };
    }
    ClassifiedError {
        kind: ResponseKind::ServerError,
        cooldown_ms: 15_000,
        reset_at_iso: None,
    }
}

fn gptweb_settings(settings: &JsonMap) -> GptWebSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    GptWebSettings {
        base_url: settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(DEFAULT_GPT_WEB_BASE_URL)
            .trim_end_matches('/')
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 30)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
    }
}
