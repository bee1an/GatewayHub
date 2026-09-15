//! NVIDIA NIM provider — port of `providers/nvidia/`.
//! Pure-API-key OpenAI-compatible upstream; no token refresh.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::{UpstreamHttp, redact_secrets_in_text};
use crate::pool::{AccountPool, AccountWithState, DefaultBehavior, now_ms};
use crate::protocol::{
    anthropic_messages_to_openai, openai_completion_to_anthropic, openai_sse_to_anthropic,
};
use crate::provider::ProviderAdapter;
use crate::types::{
    AccountFile, AccountTestResult, ClassifiedError, GatewayLogEntry,
    GatewayRequestContext, GatewayResponse, LogLevel, LogSink, ProviderModel, ProviderStatus,
    ResponseKind, UsageMeta, UsageStats,
};

const NVIDIA_BASE_URL: &str = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODELS_PATH: &str = "/models";
const NVIDIA_CHAT_PATH: &str = "/chat/completions";
const NVIDIA_SMOKE_MODEL: &str = "meta/llama-3.1-8b-instruct";
const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

#[derive(Debug, Clone)]
pub struct NvidiaSettings {
    pub base_url: String,
    pub first_token_timeout: Duration,
    pub streaming_read_timeout: Duration,
    pub max_retries: usize,
}

impl NvidiaSettings {
    pub fn from_settings(settings: &serde_json::Map<String, Value>) -> Self {
        let secs = |k: &str, default: u64| {
            settings
                .get(k)
                .and_then(Value::as_u64)
                .filter(|v| *v > 0)
                .unwrap_or(default)
        };
        Self {
            base_url: settings
                .get("baseUrl")
                .and_then(Value::as_str)
                .unwrap_or(NVIDIA_BASE_URL)
                .to_string(),
            first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 120)),
            streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 300)),
            max_retries: settings
                .get("maxRetries")
                .and_then(Value::as_u64)
                .unwrap_or(2) as usize,
        }
    }
}

impl Default for NvidiaSettings {
    fn default() -> Self {
        Self {
            base_url: NVIDIA_BASE_URL.into(),
            first_token_timeout: Duration::from_secs(120),
            streaming_read_timeout: Duration::from_secs(300),
            max_retries: 2,
        }
    }
}

type NvidiaPool = AccountPool<DefaultBehavior>;

pub struct NvidiaProvider {
    view: ProviderView,
    enabled: bool,
    display_name: Option<String>,
}

impl NvidiaProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((std::collections::HashMap<String, crate::types::AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = NvidiaSettings::from_settings(&provider_config.settings);
        let http = UpstreamHttp::new(settings.base_url.clone(), Some(proxy_url))?;

        let mut pool = AccountPool::new(DefaultBehavior("nvidia"));
        pool.set_on_changed(on_changed);
        let mut states = provider_state
            .accounts
            .iter()
            .map(|(k, v)| (k.clone(), crate::types::AccountRuntimeState::from_value(v)))
            .collect();
        pool.reload(account_files, &mut states, provider_state.current_account_index);

        Ok(Self {
            view: ProviderView {
                pool: Arc::new(Mutex::new(pool)),
                http: Arc::new(http),
                settings: Arc::new(settings),
                persist: persist_account,
                log,
            },
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }

    fn log_entry(&self, level: LogLevel, message: impl Into<String>, account: Option<&AccountWithState>, request_id: Option<&str>, model: Option<&str>, duration_ms: Option<u64>, extra: Option<Value>) {
        (self.view.log)(GatewayLogEntry {
            ts: now_ms(),
            level,
            message: message.into(),
            provider: Some("nvidia".into()),
            account_id: account.map(|a| a.config.label.clone().unwrap_or_else(|| a.config.id.clone())),
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

    async fn check_api_key(&self, api_key: &str) -> anyhow::Result<()> {
        let res = self
            .view
            .http
            .post_json(
                NVIDIA_CHAT_PATH,
                &json!({
                    "model": NVIDIA_SMOKE_MODEL,
                    "max_tokens": 1,
                    "stream": false,
                    "messages": [{"role": "user", "content": "Reply OK."}],
                }),
                &[
                    ("authorization", &format!("Bearer {api_key}")),
                    ("content-type", "application/json"),
                ],
                self.view.settings.first_token_timeout,
            )
            .await?;
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
        if status >= 400 || payload.get("error").is_some() {
            anyhow::bail!(
                "NVIDIA key check failed: HTTP {} {}",
                status,
                redact_secrets_in_text(&text).chars().take(500).collect::<String>()
            );
        }
        Ok(())
    }

    fn report_usage(
        &self,
        parsed: &Value,
        model: &str,
        account: &AccountWithState,
        ctx: &GatewayRequestContext,
    ) {
        let Some(sink) = &ctx.on_usage else { return };
        let Some(usage) = parsed.get("usage") else { return };
        sink(
            UsageStats {
                input_tokens: usage
                    .get("prompt_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output_tokens: usage
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                ..Default::default()
            },
            UsageMeta {
                account_id: Some(account.config.id.clone()),
                model: Some(model.to_string()),
                provider: Some("nvidia".into()),
            },
        );
    }

    async fn non_stream_proxy(
        &self,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.view.pool.lock().await.accounts.len();
        let attempts = total.min(self.view.settings.max_retries + 1).max(1);

        for attempt in 0..attempts {
            let Some(account) = self.view.get_account_for_model(model, &excluded).await else {
                break;
            };
            let started = now_ms();
            match self.view.fetch_upstream(&account, body, false).await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    let text = res.text().await.unwrap_or_default();
                    if status < 400 {
                        let parsed: Value =
                            serde_json::from_str(&text).unwrap_or_else(|_| json!({ "raw": text }));
                        self.report_usage(&parsed, model, &account, ctx);
                        self.view.pool.lock().await.report_success(&account.config.id);
                        self.log_entry(
                            LogLevel::Info,
                            "NVIDIA upstream success",
                            Some(&account),
                            Some(&ctx.request_id),
                            Some(model),
                            Some((now_ms() - started) as u64),
                            None,
                        );
                        return GatewayResponse::json(200, parsed);
                    }
                    let classified = classify_nvidia_error(status, &text);
                    last_error = format!("HTTP {status}: {}", text.chars().take(500).collect::<String>());
                    self.view.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    self.log_entry(
                        LogLevel::Warn,
                        format!("NVIDIA upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        Some(json!({ "kind": kind_name(&classified), "attempt": attempt + 1 })),
                    );
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                        break;
                    }
                }
                Err(e) => {
                    if ctx.cancel.is_cancelled() {
                        return GatewayResponse::error(499, "Client aborted request", "client_aborted");
                    }
                    last_error = e.to_string();
                    let classified = classify_nvidia_error(0, &last_error);
                    self.view.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                        break;
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
        }
        if last_error.is_empty() {
            last_error = "No available NVIDIA accounts".into();
        }
        GatewayResponse::error(502, last_error, "gateway_error")
    }
}

/// The streaming retry loop — a lazy `Stream` that picks accounts, performs
/// the upstream call, yields raw SSE text, and retries with the next account
/// on failure (port of `streamProxy`).
fn nvidia_stream(
    pool: Arc<Mutex<NvidiaPool>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<NvidiaSettings>,
    persist: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
    model: String,
    body: Value,
    request_id: String,
    on_usage: Option<crate::types::UsageSink>,
    cancel: tokio_util::sync::CancellationToken,
) -> impl futures::Stream<Item = String> + Send {
    // Re-implement get_account_for_model inside the stream via a small
    // helper that borrows the shared pieces.
    let provider_view = ProviderView {
        pool: pool.clone(),
        http: http.clone(),
        settings: settings.clone(),
        persist,
        log: log.clone(),
    };
    async_stream::stream! {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = pool.lock().await.accounts.len();
        let attempts = total.min(settings.max_retries + 1).max(1);

        'outer: for attempt in 0..attempts {
            let Some(account) = provider_view.get_account_for_model(&model, &excluded).await else {
                break;
            };
            let started = now_ms();
            let res = provider_view.fetch_upstream(&account, &body, true).await;
            let upstream = match res {
                Ok(r) if r.status().as_u16() < 400 => r,
                Ok(r) => {
                    let status = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    let classified = classify_nvidia_error(status, &text);
                    last_error = format!("HTTP {status}: {}", text.chars().take(500).collect::<String>());
                    pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) { break; }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
                Err(e) => {
                    if cancel.is_cancelled() { break 'outer; }
                    last_error = e.to_string();
                    let classified = classify_nvidia_error(0, &last_error);
                    pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) { break; }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
            };

            // read upstream SSE bytes → incremental UTF-8 decode → yield text
            let mut byte_stream = upstream.bytes_stream();
            let mut tail: Vec<u8> = Vec::new();
            let mut usage_chunk: Option<Value> = None;
            let mut stream_failed = false;
            loop {
                let item = tokio::time::timeout(
                    settings.streaming_read_timeout,
                    byte_stream.next(),
                )
                .await;
                let chunk = match item {
                    Ok(Some(Ok(b))) => b,
                    Ok(Some(Err(e))) => {
                        last_error = e.to_string();
                        stream_failed = true;
                        break;
                    }
                    Ok(None) => break,
                    Err(_) => {
                        last_error = "NVIDIA stream read timeout".into();
                        stream_failed = true;
                        break;
                    }
                };
                if cancel.is_cancelled() {
                    stream_failed = true;
                    break;
                }
                tail.extend_from_slice(&chunk);
                let valid = match std::str::from_utf8(&tail) {
                    Ok(s) => {
                        let out = s.to_string();
                        tail.clear();
                        out
                    }
                    Err(e) if e.valid_up_to() > 0 => {
                        let out = String::from_utf8_lossy(&tail[..e.valid_up_to()]).into_owned();
                        tail.drain(..e.valid_up_to());
                        out
                    }
                    Err(_) => continue, // incomplete codepoint at tail
                };
                if let Some(u) = extract_usage_chunk(&valid) {
                    usage_chunk = Some(u);
                }
                yield valid;
            }
            if !tail.is_empty() {
                yield String::from_utf8_lossy(&tail).into_owned();
            }

            if stream_failed || cancel.is_cancelled() {
                if cancel.is_cancelled() { break 'outer; }
                let classified = classify_nvidia_error(0, &last_error);
                pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                excluded.insert(account.config.id.clone());
                if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) { break; }
                tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                continue;
            }

            if let (Some(sink), Some(chunk)) = (&on_usage, &usage_chunk) {
                if let Some(u) = chunk.get("usage") {
                    sink(
                        UsageStats {
                            input_tokens: u.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                            output_tokens: u.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some("nvidia".into()),
                        },
                    );
                }
            }
            pool.lock().await.report_success(&account.config.id);
            log(GatewayLogEntry {
                ts: now_ms(),
                level: LogLevel::Info,
                message: "NVIDIA stream success".into(),
                provider: Some("nvidia".into()),
                account_id: Some(account.config.label.clone().unwrap_or_else(|| account.config.id.clone())),
                request_id: Some(request_id.clone()),
                category: Some("upstream".into()),
                status_code: None,
                duration: Some((now_ms() - started) as u64),
                streaming: Some(true),
                time_to_first_token: None,
                chunk_count: None,
                model: Some(model.clone()),
                api_format: None,
                usage: None,
                cost: None,
                error: None,
                extra: Default::default(),
            });
            return;
        }

        let message = format!(
            "NVIDIA stream failed: {}",
            if last_error.is_empty() { "No available accounts".to_string() } else { last_error }
        );
        yield format!(
            "data: {}\n\n",
            serde_json::to_string(&json!({
                "error": { "message": message, "type": "gateway_error", "code": "nvidia_error" }
            })).unwrap_or_else(|_| "{}".into())
        );
        yield "data: [DONE]\n\n".to_string();
    }
}

/// Shared view used by both the owning provider and the detached SSE stream.
struct ProviderView {
    pool: Arc<Mutex<NvidiaPool>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<NvidiaSettings>,
    persist: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
}

impl ProviderView {
    async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<AccountWithState> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                self.maybe_refresh_account_models(&id).await;
                let mut pool = self.pool.lock().await;
                if pool.has_model(&id, model) {
                    pool.commit(&id);
                    return pool.find(&id).cloned();
                }
            }
        }
        None
    }

    async fn maybe_refresh_account_models(&self, account_id: &str) {
        let (api_key, fresh) = {
            let pool = self.pool.lock().await;
            let Some(acc) = pool.find(account_id) else {
                return;
            };
            let fresh = acc.state.models_cached_at > 0
                && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
                && !acc.state.model_ids.is_empty();
            (acc.config.field_str("apiKey").map(str::to_string), fresh)
        };
        if fresh {
            return;
        }
        let Some(key) = api_key else { return };
        let res = self
            .http
            .get(
                NVIDIA_MODELS_PATH,
                &[("authorization", &format!("Bearer {key}"))],
                Duration::from_secs(30),
            )
            .await;
        match res {
            Ok(r) => {
                let status = r.status().as_u16();
                let text = r.text().await.unwrap_or_default();
                if status >= 400 {
                    let classified = classify_nvidia_error(status, &text);
                    if classified.kind == ResponseKind::Auth {
                        let mut pool = self.pool.lock().await;
                        if let Some(acc) = pool.find_mut(account_id) {
                            acc.state.status = crate::types::AccountStatus::AuthFailed;
                            acc.state.status_reason = Some(
                                redact_secrets_in_text(&text).chars().take(200).collect(),
                            );
                            acc.state.status_updated_at = now_ms();
                        }
                    }
                    return;
                }
                let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                let mut ids: Vec<String> = payload
                    .get("data")
                    .and_then(Value::as_array)
                    .map(|data| {
                        data.iter()
                            .filter_map(|m| m.get("id").and_then(Value::as_str))
                            .map(|id| id.trim().to_string())
                            .filter(|id| !id.is_empty() && !is_non_chat_model(id))
                            .collect()
                    })
                    .unwrap_or_default();
                ids.sort();
                ids.dedup();
                let mut pool = self.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.model_ids = ids;
                    acc.state.models_cached_at = now_ms();
                    if acc.config.fields.get("keyLabel").is_none() {
                        acc.config
                            .fields
                            .insert("keyLabel".into(), json!("NVIDIA NIM"));
                    }
                    acc.config
                        .fields
                        .insert("lastKeyInfoAt".into(), json!(now_ms()));
                    let config = acc.config.clone();
                    drop(pool);
                    if let Some(persist) = &self.persist {
                        persist(&config);
                    }
                }
            }
            Err(e) => {
                let classified = classify_nvidia_error(0, &e.to_string());
                if classified.kind == ResponseKind::Auth {
                    let mut pool = self.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = crate::types::AccountStatus::AuthFailed;
                        acc.state.status_reason =
                            Some(e.to_string().chars().take(200).collect());
                        acc.state.status_updated_at = now_ms();
                    }
                }
            }
        }
    }

    async fn fetch_upstream(
        &self,
        account: &AccountWithState,
        body: &Value,
        stream: bool,
    ) -> anyhow::Result<reqwest::Response> {
        let key = account
            .config
            .field_str("apiKey")
            .ok_or_else(|| anyhow::anyhow!("NVIDIA account has no apiKey"))?
            .to_string();
        let mut upstream = body.clone();
        upstream["stream"] = json!(stream);
        let res = tokio::time::timeout(
            self.settings.first_token_timeout,
            self.http.post_json_stream(
                NVIDIA_CHAT_PATH,
                &upstream,
                &[
                    ("content-type", "application/json"),
                    ("authorization", &format!("Bearer {key}")),
                    ("http-referer", "https://gatewayhub.local"),
                    ("x-title", "GatewayHub"),
                ],
                self.settings.first_token_timeout,
            ),
        )
        .await;
        match res {
            Ok(Ok(r)) => Ok(r),
            Ok(Err(e)) => Err(e.into()),
            Err(_) => anyhow::bail!("NVIDIA upstream timeout"),
        }
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for NvidiaProvider {
    fn name(&self) -> &'static str {
        "nvidia"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        // `listModelsFresh` port: refresh every enabled account first
        // (allSettled semantics — failures are swallowed by maybe_refresh).
        let ids: Vec<String> = {
            let pool = self.view.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| a.config.enabled)
                .map(|a| a.config.id.clone())
                .collect()
        };
        for id in ids {
            self.view.maybe_refresh_account_models(&id).await;
        }
        self.view.pool
            .lock()
            .await
            .list_models()
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "nvidia".into(),
                owned_by: Some("nvidia".into()),
                description: None,
            })
            .collect()
    }

    async fn chat_completions(
        &self,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(nvidia_stream(
                    self.view.pool.clone(),
                    self.view.http.clone(),
                    self.view.settings.clone(),
                    self.view.persist.clone(),
                    self.view.log.clone(),
                    model,
                    body,
                    ctx.request_id.clone(),
                    ctx.on_usage.clone(),
                    ctx.cancel.clone(),
                )),
            };
        }
        self.non_stream_proxy(&model, &body, ctx).await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let openai_body = anthropic_messages_to_openai(&body, &model);
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            let inner = nvidia_stream(
                self.view.pool.clone(),
                self.view.http.clone(),
                self.view.settings.clone(),
                self.view.persist.clone(),
                self.view.log.clone(),
                model.clone(),
                openai_body,
                ctx.request_id.clone(),
                ctx.on_usage.clone(),
                ctx.cancel.clone(),
            );
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(openai_sse_to_anthropic(inner, model)),
            };
        }
        let response = self.non_stream_proxy(&model, &openai_body, ctx).await;
        match response {
            GatewayResponse::Json { status, body: parsed } if status < 400 => {
                GatewayResponse::json(
                    status,
                    openai_completion_to_anthropic(&parsed, &model, &body),
                )
            }
            other => other,
        }
    }

    async fn test_account(&self, account_id: &str) -> AccountTestResult {
        let api_key = {
            let pool = self.view.pool.lock().await;
            pool.find(account_id)
                .and_then(|a| a.config.field_str("apiKey").map(str::to_string))
        };
        let Some(key) = api_key else {
            return AccountTestResult {
                ok: false,
                account_id: account_id.into(),
                message: "Account not found".into(),
                ..Default::default()
            };
        };
        match self.check_api_key(&key).await {
            Ok(()) => {
                self.view.maybe_refresh_account_models(account_id).await;
                let models = {
                    let mut pool = self.view.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = crate::types::AccountStatus::Available;
                        acc.state.status_reason = None;
                        acc.state.status_updated_at = now_ms();
                        acc.state.model_ids.clone()
                    } else {
                        Vec::new()
                    }
                };
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: format!(
                        "NVIDIA key valid, {} model(s) discovered from /models",
                        models.len()
                    ),
                    models: models.into_iter().take(50).collect(),
                    auth_type: Some("nvidia-api-key".into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.view.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
                    acc.state.last_error = Some(message.clone());
                    acc.state.status = crate::types::AccountStatus::AuthFailed;
                    acc.state.status_reason =
                        Some(message.chars().take(200).collect());
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

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let mut pool = self.view.pool.lock().await;
            if let Some(acc) = pool.find_mut(account_id) {
                acc.state.models_cached_at = 0;
            } else {
                anyhow::bail!("Account not found");
            }
        }
        self.view.maybe_refresh_account_models(account_id).await;
        Ok(self
            .view
            .pool
            .lock()
            .await
            .find(account_id)
            .map(|a| a.state.model_ids.clone())
            .unwrap_or_default())
    }

    async fn reset_account(&self, account_id: &str) -> anyhow::Result<()> {
        self.view.pool.lock().await.reset_account(account_id);
        Ok(())
    }

    async fn set_account_status(
        &self,
        account_id: &str,
        status: crate::types::AccountStatus,
        reason: Option<String>,
    ) -> anyhow::Result<()> {
        self.view.pool
            .lock()
            .await
            .set_account_status(account_id, status, reason)
    }

    fn status(&self) -> ProviderStatus {
        let accounts = self.view.pool.try_lock().map(|p| p.accounts.len()).unwrap_or(0);
        let models = self
            .view
            .pool
            .try_lock()
            .map(|p| p.list_models())
            .unwrap_or_default();
        ProviderStatus {
            name: "nvidia".into(),
            provider_type: "nvidia".into(),
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
                Some(format!("{accounts} key(s)"))
            } else {
                Some("No NVIDIA keys configured".into())
            },
            models,
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyNvidiaError` port — error kind + cooldown from status/body text.
pub fn classify_nvidia_error(status: u16, body: &str) -> ClassifiedError {
    let msg = body.to_lowercase();
    let is = |pats: &[&str]| pats.iter().any(|p| msg.contains(p));
    if status == 401 || status == 403 || is(&["http 401", "http 403", "invalid"]) && is(&["key"]) || is(&["unauthorized"]) {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if status == 402 || is(&["payment required", "negative credit", "insufficient credit"]) {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 60 * 60_000,
            reset_at_iso: None,
        };
    }
    if status == 429 || is(&["rate limit", "too many requests"]) {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if is(&["quota", "credits", "insufficient", "exceeded"]) {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 60 * 60_000,
            reset_at_iso: None,
        };
    }
    if is(&["timeout"]) {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    if status >= 500 {
        return ClassifiedError {
            kind: ResponseKind::ServerError,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    ClassifiedError {
        kind: ResponseKind::ServerError,
        cooldown_ms: 15_000,
        reset_at_iso: None,
    }
}

fn kind_name(classified: &ClassifiedError) -> &'static str {
    match classified.kind {
        ResponseKind::Success => "success",
        ResponseKind::RateLimit => "rate_limit",
        ResponseKind::Quota => "quota",
        ResponseKind::Auth => "auth",
        ResponseKind::ModelError => "model_error",
        ResponseKind::ServerError => "server_error",
        ResponseKind::Network => "network",
        ResponseKind::Timeout => "timeout",
    }
}

fn is_non_chat_model(id: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r"(?:^|[/_.-])(bge|deplot|detector|embed|embedding|fuyu|flux|image|kosmos|multimodal|neva|nvclip|parse|rerank|retriever|reward|video|vision|vila|vl)(?:$|[/_.-])",
        )
        .expect("model filter regex")
    })
    .is_match(id)
}

fn extract_usage_chunk(text: &str) -> Option<Value> {
    for line in text.lines() {
        if line.starts_with("data: ") && line.contains("\"usage\"") {
            if let Ok(parsed) = serde_json::from_str::<Value>(&line[6..])
                && parsed.get("usage").is_some()
            {
                return Some(parsed);
            }
        }
    }
    None
}
