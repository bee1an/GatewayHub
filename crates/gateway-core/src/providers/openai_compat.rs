//! Shared OpenAI-compatible provider pipeline — the common body of the
//! nvidia/openrouter TS providers (retry loops, SSE proxy, model refresh
//! hooks, usage reporting). Provider-specific bits are injected:
//! - `classify`: error→kind mapping
//! - `refresher`: per-provider `/models` (+extras) refresh
//! - `headers`: auth + attribution headers

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, DefaultBehavior, now_ms};
use crate::types::{
    AccountFile, ClassifiedError, GatewayLogEntry, GatewayRequestContext, GatewayResponse,
    LogLevel, LogSink, ResponseKind, UsageMeta, UsageStats,
};

pub type CompatPool = AccountPool<DefaultBehavior>;
pub type BoxFut<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone)]
pub struct CompatSettings {
    pub base_url: String,
    pub first_token_timeout: Duration,
    pub streaming_read_timeout: Duration,
    pub max_retries: usize,
}

/// Per-provider lazy model-cache refresh — runs outside the pool lock.
pub trait CompatRefresh: Send + Sync + Sized + 'static {
    fn maybe_refresh<'a>(
        &'a self,
        view: &'a CompatView<Self>,
        account_id: &'a str,
    ) -> BoxFut<'a, ()>;
}

/// Shared provider view — every field is cheap to clone for stream capture.
pub struct CompatView<R: CompatRefresh> {
    pub pool: Arc<Mutex<CompatPool>>,
    pub http: Arc<UpstreamHttp>,
    pub settings: Arc<CompatSettings>,
    pub persist: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    pub log: LogSink,
    pub provider: &'static str,
    pub classify: fn(u16, &str) -> ClassifiedError,
    pub refresher: R,
}

impl<R: CompatRefresh> CompatView<R> {
    pub fn log_entry(
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
            provider: Some(self.provider.into()),
            account_id: account.map(|a| {
                a.config
                    .label
                    .clone()
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

    // --- account selection with lazy refresh (no lock during HTTP) ---

    pub async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<AccountWithState> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                self.refresher.maybe_refresh(self, &id).await;
                let mut pool = self.pool.lock().await;
                if pool.has_model(&id, model) {
                    pool.commit(&id);
                    return pool.find(&id).cloned();
                }
            }
        }
        None
    }

    /// `listModelsFresh` port — refresh all enabled accounts, then return
    /// the cached union. Failures are swallowed by the refresher.
    pub async fn list_models_fresh(&self) -> Vec<String> {
        let ids: Vec<String> = {
            let pool = self.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| a.config.enabled)
                .map(|a| a.config.id.clone())
                .collect()
        };
        for id in ids {
            self.refresher.maybe_refresh(self, &id).await;
        }
        self.pool.lock().await.list_models()
    }

    /// Non-streaming retry loop (TS `nonStreamProxy`).
    pub async fn non_stream_proxy(
        &self,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.pool.lock().await.accounts.len();
        let attempts = total.min(self.settings.max_retries + 1).max(1);

        for attempt in 0..attempts {
            let Some(account) = self.get_account_for_model(model, &excluded).await else {
                break;
            };
            let started = now_ms();
            match self.fetch_upstream(&account, body, false).await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    let text = res.text().await.unwrap_or_default();
                    if status < 400 {
                        let parsed: Value = serde_json::from_str(&text)
                            .unwrap_or_else(|_| json!({ "raw": text }));
                        report_usage(
                            &ctx.on_usage,
                            &parsed,
                            model,
                            &account,
                            self.provider,
                        );
                        self.pool.lock().await.report_success(&account.config.id);
                        self.log_entry(
                            LogLevel::Info,
                            format!("{} upstream success", self.provider),
                            Some(&account),
                            Some(&ctx.request_id),
                            Some(model),
                            Some((now_ms() - started) as u64),
                            None,
                        );
                        return GatewayResponse::json(200, parsed);
                    }
                    let classified = (self.classify)(status, &text);
                    last_error =
                        format!("HTTP {status}: {}", text.chars().take(500).collect::<String>());
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    self.log_entry(
                        LogLevel::Warn,
                        format!("{} upstream failed: {last_error}", self.provider),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        Some(json!({
                            "kind": kind_name(&classified),
                            "attempt": attempt + 1,
                        })),
                    );
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                        break;
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
                    let classified = (self.classify)(0, &last_error);
                    self.pool.lock().await.report_failure(
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
            last_error = format!("No available {} accounts", self.provider);
        }
        GatewayResponse::error(502, last_error, "gateway_error")
    }

    /// POST to the upstream chat-completions endpoint. The request timeout
    /// covers connect + response headers; streamed reads get their own
    /// per-chunk timeout in `stream_proxy`.
    pub async fn fetch_upstream(
        &self,
        account: &AccountWithState,
        body: &Value,
        stream: bool,
    ) -> anyhow::Result<reqwest::Response> {
        let key = account
            .config
            .field_str("apiKey")
            .ok_or_else(|| anyhow::anyhow!("{} account has no apiKey", self.provider))?
            .to_string();
        let mut upstream = body.clone();
        upstream["stream"] = json!(stream);
        self.http
            .post_json(
                "/chat/completions",
                &upstream,
                &[
                    ("content-type", "application/json"),
                    ("authorization", &format!("Bearer {key}")),
                    ("http-referer", "https://gatewayhub.local"),
                    ("x-title", "GatewayHub"),
                ],
                self.settings.first_token_timeout,
            )
            .await
    }

    /// Streaming retry loop — lazy `Stream`; each attempt picks a fresh
    /// account, yields raw SSE text, retries on failure (TS `streamProxy`).
    pub fn stream_proxy(
        self: &Arc<Self>,
        model: String,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> impl futures::Stream<Item = String> + Send + 'static {
        let view = self.clone();
        let request_id = ctx.request_id.clone();
        let on_usage = ctx.on_usage.clone();
        let cancel = ctx.cancel.clone();
        async_stream::stream! {
            let mut excluded = HashSet::new();
            let mut last_error = String::new();
            let total = view.pool.lock().await.accounts.len();
            let attempts = total.min(view.settings.max_retries + 1).max(1);

            'outer: for attempt in 0..attempts {
                let Some(account) = view.get_account_for_model(&model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let upstream = match view.fetch_upstream(&account, &body, true).await {
                    Ok(r) if r.status().as_u16() < 400 => r,
                    Ok(r) => {
                        let status = r.status().as_u16();
                        let text = r.text().await.unwrap_or_default();
                        let classified = (view.classify)(status, &text);
                        last_error = format!(
                            "HTTP {status}: {}",
                            text.chars().take(500).collect::<String>()
                        );
                        view.pool
                            .lock()
                            .await
                            .report_failure(&account.config.id, &last_error, &classified);
                        excluded.insert(account.config.id.clone());
                        if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(
                            300 * 2_u64.pow(attempt as u32),
                        ))
                        .await;
                        continue;
                    }
                    Err(e) => {
                        if cancel.is_cancelled() {
                            break 'outer;
                        }
                        last_error = e.to_string();
                        let classified = (view.classify)(0, &last_error);
                        view.pool
                            .lock()
                            .await
                            .report_failure(&account.config.id, &last_error, &classified);
                        excluded.insert(account.config.id.clone());
                        if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(
                            300 * 2_u64.pow(attempt as u32),
                        ))
                        .await;
                        continue;
                    }
                };

                // upstream SSE bytes → incremental UTF-8 decode → yield text
                let mut byte_stream = upstream.bytes_stream();
                let mut tail: Vec<u8> = Vec::new();
                let mut usage_chunk: Option<Value> = None;
                let mut stream_failed = false;
                loop {
                    let item = tokio::time::timeout(
                        view.settings.streaming_read_timeout,
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
                            last_error = format!("{} stream read timeout", view.provider);
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
                            let out =
                                String::from_utf8_lossy(&tail[..e.valid_up_to()]).into_owned();
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
                    if cancel.is_cancelled() {
                        break 'outer;
                    }
                    let classified = (view.classify)(0, &last_error);
                    view.pool
                        .lock()
                        .await
                        .report_failure(&account.config.id, &last_error, &classified);
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32)))
                        .await;
                    continue;
                }

                if let (Some(sink), Some(chunk)) = (&on_usage, &usage_chunk)
                    && let Some(u) = chunk.get("usage")
                {
                    sink(
                        UsageStats {
                            input_tokens: u
                                .get("prompt_tokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                            output_tokens: u
                                .get("completion_tokens")
                                .and_then(Value::as_u64)
                                .unwrap_or(0),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some(view.provider.into()),
                        },
                    );
                }
                view.pool.lock().await.report_success(&account.config.id);
                view.log_entry(
                    LogLevel::Info,
                    format!("{} stream success", view.provider),
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }

            let message = format!(
                "{} stream failed: {}",
                view.provider,
                if last_error.is_empty() {
                    "No available accounts".to_string()
                } else {
                    last_error
                }
            );
            yield format!(
                "data: {}\n\n",
                serde_json::to_string(&json!({
                    "error": {
                        "message": message,
                        "type": "gateway_error",
                        "code": format!("{}_error", view.provider),
                    }
                }))
                .unwrap_or_else(|_| "{}".into())
            );
            yield "data: [DONE]\n\n".to_string();
        }
    }
}

pub fn report_usage(
    sink: &Option<crate::types::UsageSink>,
    parsed: &Value,
    model: &str,
    account: &AccountWithState,
    provider: &str,
) {
    let Some(sink) = sink else { return };
    let Some(usage) = parsed.get("usage") else {
        return;
    };
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
            provider: Some(provider.into()),
        },
    );
}

pub fn extract_usage_chunk(text: &str) -> Option<Value> {
    for line in text.lines() {
        if line.starts_with("data: ") && line.contains("\"usage\"")
            && let Ok(parsed) = serde_json::from_str::<Value>(&line[6..])
            && parsed.get("usage").is_some()
        {
            return Some(parsed);
        }
    }
    None
}

pub fn kind_name(classified: &ClassifiedError) -> &'static str {
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
