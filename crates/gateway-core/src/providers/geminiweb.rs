//! GeminiWeb provider — port of `providers/geminiweb/*`.
//! Cookie auth → /app SNlM0e scrape → StreamGenerate form POST →
//! newline-delimited JSON-array frames carrying cumulative text.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::protocol::{
    anthropic_messages_to_openai, openai_completion_to_anthropic, openai_sse_to_anthropic,
};
use crate::provider::ProviderAdapter;
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind, UsageMeta, UsageStats,
};

mod upstream;
use upstream::*;

pub const DEFAULT_GEMINI_WEB_BASE_URL: &str = "https://gemini.google.com";
pub const GEMINI_APP_PATH: &str = "/app";
pub const GEMINI_STREAM_GENERATE_PATH: &str =
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
pub const GEMINI_ROTATE_COOKIES_URL: &str = "https://accounts.google.com/RotateCookies";
pub const GEMINI_WEB_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
pub const GEMINI_WEB_DEFAULT_MODEL: &str = "gemini-3.5-flash";
pub const GEMINI_WEB_KNOWN_MODELS: &[&str] = &[
    "gemini-3.1-pro",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
];

fn model_header(mode_id: &str) -> String {
    serde_json::to_string(&json!([
        1,
        null,
        null,
        null,
        mode_id,
        null,
        null,
        0,
        [4],
        null,
        null,
        1
    ]))
    .unwrap_or_default()
}

/// `geminiWebModelHeader` — model id → x-goog-ext-525001261-jspb value.
pub fn gemini_web_model_header(model: &str) -> String {
    match normalize_geminiweb_model(model).as_str() {
        "gemini-3.1-pro" => model_header("e6fa609c3fa255c0"),
        "gemini-3.5-flash" => model_header("56fdd199312815e2"),
        "gemini-3.1-flash-lite" => model_header("8c46e95b1a07cecc"),
        _ => String::new(),
    }
}

pub fn normalize_geminiweb_model(model: &str) -> String {
    let t = model.trim();
    if t.is_empty() {
        GEMINI_WEB_DEFAULT_MODEL.into()
    } else {
        t.to_string()
    }
}

#[derive(Debug, Clone)]
struct GeminiWebSettings {
    base_url: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
}

// ---------------------------------------------------------------------------
// http.ts — SAPISID hash, /app scrape, SIDTS rotate, StreamGenerate

// ---------------------------------------------------------------------------
// provider + accountPool
// ---------------------------------------------------------------------------

struct GeminiWebBehavior;
impl crate::pool::PoolBehavior for GeminiWebBehavior {
    fn provider_name(&self) -> &'static str {
        "geminiWeb"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_geminiweb_model(model)
    }
    fn account_has_model(&self, _a: &AccountWithState, _m: &str) -> bool {
        true
    }
    fn seed_models(&self) -> Vec<String> {
        GEMINI_WEB_KNOWN_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }
}

pub struct GeminiWebProvider {
    core: Arc<GeminiWebCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct GeminiWebCore {
    pool: Arc<Mutex<AccountPool<GeminiWebBehavior>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<GeminiWebSettings>,
    log: LogSink,
}

impl GeminiWebProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        _persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = geminiweb_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.base_url, Some(proxy_url))?;
        let mut pool = AccountPool::new(GeminiWebBehavior);
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
            core: Arc::new(GeminiWebCore {
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

impl GeminiWebCore {
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
            provider: Some("geminiWeb".into()),
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

    async fn do_request(
        &self,
        account: &AccountWithState,
        model: &str,
        body: &Value,
    ) -> anyhow::Result<String> {
        let prompt = convert_openai_to_gemini_prompt(
            body.get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .as_slice(),
        );
        let events = stream_gemini_conversation(
            self.http.client(),
            self.settings.base_url.clone(),
            account.config.clone(),
            prompt,
            model.to_string(),
            self.settings.first_token_timeout,
            self.settings.streaming_read_timeout,
        );
        let mut state = GeminiStreamingState {
            model: model.to_string(),
            ..Default::default()
        };
        let mut events = Box::pin(events);
        while let Some(item) = events.next().await {
            let event = item?;
            let _ = parse_gemini_batch_event(&event, &mut state)?;
        }
        if state.content.is_empty() {
            anyhow::bail!("Empty response from GeminiWeb");
        }
        Ok(state.content)
    }

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
                let prompt = convert_openai_to_gemini_prompt(
                    body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default().as_slice(),
                );
                let events = stream_gemini_conversation(
                    view.http.client(),
                    view.settings.base_url.clone(),
                    account.config.clone(),
                    prompt,
                    model.clone(),
                    view.settings.first_token_timeout,
                    view.settings.streaming_read_timeout,
                );
                let mut state = GeminiStreamingState { model: model.clone(), ..Default::default() };
                let mut events = Box::pin(events);
                let mut stream_error: Option<String> = None;
                let mut done = false;
                while let Some(item) = events.next().await {
                    match item {
                        Ok(event) => {
                            match parse_gemini_batch_event(&event, &mut state) {
                                Ok((chunk, d)) => {
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
                        Err(e) => {
                            stream_error = Some(e.to_string());
                            break;
                        }
                    }
                }
                if let Some(err) = stream_error {
                    let classified = classify_geminiweb_error(&err);
                    view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                    excluded.insert(account.config.id.clone());
                    view.log_entry(
                        LogLevel::Warn,
                        format!("GeminiWeb stream failed: {err}"),
                        Some(&account),
                        Some(&request_id),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    last_error = err;
                    if matches!(classified.kind, ResponseKind::Auth) {
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
                    "GeminiWeb upstream success (stream)",
                    Some(&account),
                    Some(&request_id),
                    Some((now_ms() - started) as u64),
                    None,
                );
                if let Some(sink) = &on_usage {
                    sink(
                        UsageStats {
                            input_tokens: 0,
                            output_tokens: crate::providers::kiro_convert::estimate_tokens(&json!(state.content)),
                            estimated: Some(true),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some("geminiWeb".into()),
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

#[async_trait::async_trait]
impl ProviderAdapter for GeminiWebProvider {
    fn name(&self) -> &'static str {
        "geminiWeb"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        GEMINI_WEB_KNOWN_MODELS
            .iter()
            .map(|id| ProviderModel {
                id: id.to_string(),
                provider: "geminiWeb".into(),
                owned_by: Some("google".into()),
                description: Some("Model via Gemini Web".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_geminiweb_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(GEMINI_WEB_DEFAULT_MODEL),
        );
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
        let model = normalize_geminiweb_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(GEMINI_WEB_DEFAULT_MODEL),
        );
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
            json!({ "input_tokens": crate::providers::kiro_convert::estimate_tokens(&body) }),
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
        match fetch_access_token(
            &self.core.http.client(),
            &self.core.settings.base_url,
            &config,
        )
        .await
        {
            Ok((_token, email)) => {
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_updated_at = now_ms();
                    }
                }
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: format!(
                        "GeminiWeb account is valid{}",
                        email.map(|e| format!(" ({e})")).unwrap_or_default()
                    ),
                    models: GEMINI_WEB_KNOWN_MODELS
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    expires_at: None,
                    auth_type: Some("geminiweb-cookie".into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                let classified = classify_geminiweb_error(&message);
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.failures += 1;
                        acc.state.last_failure_at = now_ms();
                        acc.state.last_error = Some(message.clone());
                        acc.state.status = if classified.kind == ResponseKind::Auth {
                            AccountStatus::AuthFailed
                        } else {
                            AccountStatus::Cooling
                        };
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
        let email = {
            let pool = self.core.pool.lock().await;
            pool.find(account_id).and_then(|a| a.config.email.clone())
        };
        Ok(json!({
            "id": account_id,
            "subscription": {"title": "GeminiWeb", "type": "web"},
            "email": email,
            "models": GEMINI_WEB_KNOWN_MODELS.iter().map(|m| json!({
                "modelId": m, "modelName": m, "rateMultiplier": 1, "rateUnit": "request",
            })).collect::<Vec<_>>(),
        }))
    }

    async fn refresh_account_models(&self, _account_id: &str) -> anyhow::Result<Vec<String>> {
        Ok(GEMINI_WEB_KNOWN_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect())
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
        let accounts = self
            .core
            .pool
            .try_lock()
            .map(|p| p.accounts.len())
            .unwrap_or_default();
        ProviderStatus {
            name: "geminiWeb".into(),
            provider_type: "geminiWeb".into(),
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
                Some("No GeminiWeb accounts configured".into())
            },
            models: GEMINI_WEB_KNOWN_MODELS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            use_proxy: None,
            accounts,
        }
    }
}

impl GeminiWebProvider {
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
                        "GeminiWeb upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    let out_tokens = crate::providers::kiro_convert::estimate_tokens(&json!(text));
                    if let Some(sink) = &ctx.on_usage {
                        sink(
                            UsageStats {
                                input_tokens: 0,
                                output_tokens: out_tokens,
                                estimated: Some(true),
                                ..Default::default()
                            },
                            UsageMeta {
                                account_id: Some(account.config.id.clone()),
                                model: Some(model.to_string()),
                                provider: Some("geminiWeb".into()),
                            },
                        );
                    }
                    return Ok(json!({
                        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4()),
                        "object": "chat.completion",
                        "created": crate::responses_api::now_secs(),
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "message": {"role": "assistant", "content": text},
                            "finish_reason": "stop",
                        }],
                        "usage": {"prompt_tokens": 0, "completion_tokens": out_tokens, "total_tokens": out_tokens},
                    }));
                }
                Err(e) => {
                    last_error = e.to_string();
                    let classified = classify_geminiweb_error(&last_error);
                    self.core.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32)))
                        .await;
                }
            }
        }
        anyhow::bail!(
            "GeminiWeb request failed: {}",
            if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            }
        )
    }
}

/// `classifyGeminiWebError` port (mirrors grokweb's table).
pub fn classify_geminiweb_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |s: &str| msg.contains(s);
    if has("401")
        || has("unauthorized")
        || has("not authenticated")
        || has("cookie may be invalid")
        || has("session tokens not found")
    {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if has("429")
        || has("rate limit")
        || has("too many")
        || has("403")
        || has("cloudflare")
        || has("challenge")
    {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
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
    if has("fetch failed") || has("econn") || has("enotfound") || has("network") {
        return ClassifiedError {
            kind: ResponseKind::Network,
            cooldown_ms: 15_000,
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
    ClassifiedError {
        kind: ResponseKind::ServerError,
        cooldown_ms: 15_000,
        reset_at_iso: None,
    }
}

fn geminiweb_settings(settings: &JsonMap) -> GeminiWebSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    GeminiWebSettings {
        base_url: settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(DEFAULT_GEMINI_WEB_BASE_URL)
            .trim_end_matches('/')
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 30)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
    }
}
