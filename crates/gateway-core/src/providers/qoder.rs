//! Qoder provider — port of `providers/qoder/provider.ts` + `accountPool.ts`.
//! Direct API: OpenAI-format /model/v1/chat/completions with PAT or
//! qodercli-bundle credentials. Legacy (WASM-signed) models are gated on
//! qoderCliHome; the WASM signer itself is not ported yet and errors out.

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
use crate::providers::kiro_convert::estimate_tokens;
use crate::providers::qoder_auth::{
    DEFAULT_QODER_MODEL, DEFAULT_QODER_MODEL_SERVER_BASE_URL, DEFAULT_QODER_OPENAPI_BASE_URL,
    QODER_DIRECT_MODEL_IDS, QODER_KNOWN_MODELS, QoderTokenResolver, is_qoder_legacy_model,
    normalize_qoder_model, qoder_account_uses_direct_api,
};
use crate::providers::qoder_chat::{
    build_qoder_chat_payload, collect_qoder_chat, normalize_finish_reason, stream_qoder_chat,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind, UsageMeta, UsageStats,
};

const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

#[derive(Debug, Clone)]
struct QoderSettings {
    api_base_url: String,
    openapi_base_url: String,
    max_output_tokens: String,
    max_retries: u32,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
}

struct QoderBehavior;
impl crate::pool::PoolBehavior for QoderBehavior {
    fn provider_name(&self) -> &'static str {
        "qoder"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_qoder_model(model)
    }
    /// state.modelIds carries the per-account capability list; empty →
    /// accept (refresh fills it in lazily).
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        if account.state.model_ids.is_empty() {
            return true;
        }
        account
            .state
            .model_ids
            .iter()
            .any(|m| normalize_qoder_model(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        QODER_KNOWN_MODELS
            .iter()
            .map(|(id, ..)| id.to_string())
            .collect()
    }
}

pub struct QoderProvider {
    core: Arc<QoderCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct QoderCore {
    pool: Arc<Mutex<AccountPool<QoderBehavior>>>,
    http: Arc<UpstreamHttp>,
    resolver: Arc<QoderTokenResolver>,
    settings: Arc<QoderSettings>,
    log: LogSink,
}

impl QoderProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        _persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = qoder_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.api_base_url, Some(proxy_url))?;
        let resolver = Arc::new(QoderTokenResolver::new(
            http.client(),
            &settings.openapi_base_url,
        ));

        let mut pool = AccountPool::new(QoderBehavior);
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
            core: Arc::new(QoderCore {
                pool: Arc::new(Mutex::new(pool)),
                http: Arc::new(http),
                resolver,
                settings: Arc::new(settings),
                log,
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
}

impl QoderCore {
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
            provider: Some("qoder".into()),
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

    fn has_direct_accounts(&self) -> bool {
        self.pool
            .try_lock()
            .map(|p| {
                p.accounts
                    .iter()
                    .any(|a| a.config.enabled && qoder_account_uses_direct_api(&a.config))
            })
            .unwrap_or(false)
    }

    /// `getAccount`: availability → direct-api → legacy gate → model.
    async fn get_account(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<AccountWithState> {
        let normalized = normalize_qoder_model(model);
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                let mut pool = self.pool.lock().await;
                let Some(acc) = pool.find(&id).cloned() else {
                    continue;
                };
                if !qoder_account_uses_direct_api(&acc.config) {
                    continue;
                }
                if is_qoder_legacy_model(&normalized)
                    && acc
                        .config
                        .fields
                        .get("qoderCliHome")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .is_none_or(|s| s.is_empty())
                {
                    continue;
                }
                if !pool.has_model(&id, &normalized) {
                    continue;
                }
                pool.commit(&id);
                return pool.find(&id).cloned();
            }
        }
        None
    }

    /// `refreshAccountModels` — no server-side /models; per-account
    /// capability list (legacy needs the cli bundle).
    async fn refresh_models(&self, account_id: &str) -> Vec<String> {
        let models: Vec<String> = {
            let pool = self.pool.lock().await;
            pool.find(account_id)
                .map(|a| {
                    if qoder_account_uses_direct_api(&a.config) {
                        let has_cli = a
                            .config
                            .fields
                            .get("qoderCliHome")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.trim().is_empty());
                        if has_cli {
                            QODER_KNOWN_MODELS
                                .iter()
                                .map(|(id, ..)| id.to_string())
                                .collect()
                        } else {
                            QODER_DIRECT_MODEL_IDS
                                .iter()
                                .map(|s| s.to_string())
                                .collect()
                        }
                    } else {
                        QODER_KNOWN_MODELS
                            .iter()
                            .map(|(id, ..)| id.to_string())
                            .collect()
                    }
                })
                .unwrap_or_else(|| {
                    QODER_KNOWN_MODELS
                        .iter()
                        .map(|(id, ..)| id.to_string())
                        .collect()
                })
        };
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.model_ids = models.clone();
            acc.state.models_cached_at = now_ms();
        }
        models
    }

    async fn maybe_refresh_models(&self, account_id: &str) {
        {
            let pool = self.pool.lock().await;
            if let Some(acc) = pool.find(account_id)
                && acc.state.models_cached_at > 0
                && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
            {
                return;
            }
        }
        let _ = self.refresh_models(account_id).await;
    }

    fn report_usage(
        &self,
        body: &Value,
        output: &str,
        model: &str,
        account_id: &str,
        ctx: &GatewayRequestContext,
        upstream_usage: Option<&Value>,
    ) {
        let Some(sink) = &ctx.on_usage else { return };
        let input = upstream_usage
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or_else(|| estimate_tokens(body.get("messages").unwrap_or(body)));
        let output_tokens = upstream_usage
            .and_then(|u| u.get("completion_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or_else(|| (output.len() as u64 + 3) / 4);
        sink(
            UsageStats {
                input_tokens: input,
                output_tokens,
                estimated: Some(upstream_usage.is_none()),
                ..Default::default()
            },
            UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("qoder".into()),
            },
        );
    }

    async fn non_stream(
        &self,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.pool.lock().await.accounts.len().max(1);
        let attempts = (total as u32).clamp(1, self.settings.max_retries + 1);
        for attempt in 0..attempts {
            let Some(account) = self.get_account(model, &excluded).await else {
                break;
            };
            let started = now_ms();
            match self.run_request(&account, model, body, ctx).await {
                Ok((completion, text, usage)) => {
                    self.pool.lock().await.report_success(&account.config.id);
                    self.report_usage(body, &text, model, &account.config.id, ctx, usage.as_ref());
                    self.log_entry(
                        LogLevel::Info,
                        "Qoder upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    return GatewayResponse::json(200, completion);
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
                    let classified = classify_qoder_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Qoder upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                }
            }
        }
        GatewayResponse::error(
            502,
            if last_error.is_empty() {
                "No available Qoder direct credential accounts".to_string()
            } else {
                last_error
            },
            "gateway_error",
        )
    }

    /// Resolve token → payload → collect stream.
    async fn run_request(
        &self,
        account: &AccountWithState,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> anyhow::Result<(Value, String, Option<Value>)> {
        let token = self.resolver.resolve(&account.config).await?;
        let payload = build_qoder_chat_payload(
            body,
            model,
            &self.settings.max_output_tokens,
            &ctx.request_id,
        );
        let events = stream_qoder_chat(
            self.http.client(),
            self.settings.api_base_url.clone(),
            token,
            payload,
            ctx.request_id.clone(),
            self.settings
                .first_token_timeout
                .max(Duration::from_secs(30)),
            self.settings.streaming_read_timeout,
        );
        let mut full_text = String::new();
        let mut usage: Option<Value> = None;
        let mut finish = "stop".to_string();
        use futures::StreamExt;
        let mut events = Box::pin(events);
        let mut raw_events: Vec<crate::providers::qoder_chat::QoderChatStreamEvent> = Vec::new();
        while let Some(item) = events.next().await {
            let ev = item?;
            raw_events.push(ev);
        }
        let completion = collect_qoder_chat(
            futures::stream::iter(raw_events.iter().cloned().map(Ok)),
            model,
        )
        .await?;
        for ev in &raw_events {
            if let Some(u) = &ev.usage {
                usage = Some(u.clone());
            }
            if let Some(fr) = &ev.finish_reason {
                finish = normalize_finish_reason(fr).to_string();
            }
            if let Some(t) = &ev.text {
                full_text.push_str(t);
            }
        }
        let _ = finish;
        Ok((completion, full_text, usage))
    }

    /// `streamWithFailover` — relay upstream chunks (normalized to
    /// chat.completion.chunk), failover only before first emitted chunk.
    fn stream(
        self: &Arc<Self>,
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
            let attempts = (total as u32).clamp(1, view.settings.max_retries + 1);
            'outer: for attempt in 0..attempts {
                let Some(account) = view.get_account(&model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
                let mut emitted = false;
                let mut full_text = String::new();
                let mut finish_reason = "stop".to_string();
                let mut usage: Option<Value> = None;
                let mut saw_terminal_chunk = false;

                let run = async {
                    let token = view.resolver.resolve(&account.config).await?;
                    let payload = build_qoder_chat_payload(
                        &body,
                        &model,
                        &view.settings.max_output_tokens,
                        &request_id,
                    );
                    Ok::<_, anyhow::Error>(stream_qoder_chat(
                        view.http.client(),
                        view.settings.api_base_url.clone(),
                        token,
                        payload,
                        request_id.clone(),
                        view.settings.first_token_timeout.max(Duration::from_secs(30)),
                        view.settings.streaming_read_timeout,
                    ))
                };
                let events = match run.await {
                    Ok(e) => e,
                    Err(e) => {
                        if cancel.is_cancelled() {
                            return;
                        }
                        last_error = e.to_string();
                        let classified = classify_qoder_error(&last_error);
                        view.pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                        excluded.insert(account.config.id.clone());
                        tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                        continue;
                    }
                };
                use futures::StreamExt;
                let mut events = Box::pin(events);
                let mut stream_error: Option<String> = None;
                while let Some(item) = events.next().await {
                    match item {
                        Ok(event) => {
                            if event.done {
                                break;
                            }
                            if let Some(u) = &event.usage {
                                usage = Some(u.clone());
                            }
                            if let Some(fr) = &event.finish_reason {
                                finish_reason = normalize_finish_reason(fr).to_string();
                            }
                            if let Some(t) = &event.text {
                                full_text.push_str(t);
                            }
                            let Some(raw) = &event.raw else { continue };
                            let chunk = normalize_openai_chunk(raw, &id, &model);
                            if chunk.get("choices").and_then(Value::as_array).is_some_and(|c| {
                                c.iter().any(|ch| ch.get("finish_reason").is_some())
                            }) {
                                saw_terminal_chunk = true;
                            }
                            emitted = true;
                            yield format!("data: {}\n\n", serde_json::to_string(&chunk).unwrap_or_default());
                        }
                        Err(e) => {
                            stream_error = Some(e.to_string());
                            break;
                        }
                    }
                }
                if let Some(err) = stream_error {
                    if cancel.is_cancelled() {
                        return;
                    }
                    last_error = err;
                    let classified = classify_qoder_error(&last_error);
                    view.pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                    excluded.insert(account.config.id.clone());
                    view.log_entry(
                        LogLevel::Warn,
                        format!("Qoder stream failed: {last_error}"),
                        Some(&account),
                        Some(&request_id),
                        Some(&model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1, "emitted": emitted})),
                    );
                    if emitted {
                        break 'outer;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                    continue;
                }
                if !saw_terminal_chunk {
                    yield format!(
                        "data: {}\n\n",
                        serde_json::to_string(&json!({
                            "id": id,
                            "object": "chat.completion.chunk",
                            "created": crate::responses_api::now_secs(),
                            "model": model,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
                        }))
                        .unwrap_or_default()
                    );
                }
                yield "data: [DONE]\n\n".to_string();
                view.pool.lock().await.report_success(&account.config.id);
                if let Some(sink) = &on_usage {
                    let input = usage
                        .as_ref()
                        .and_then(|u| u.get("prompt_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or_else(|| estimate_tokens(body.get("messages").unwrap_or(&body)));
                    let output = usage
                        .as_ref()
                        .and_then(|u| u.get("completion_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or_else(|| (full_text.len() as u64 + 3) / 4);
                    sink(
                        UsageStats {
                            input_tokens: input,
                            output_tokens: output,
                            estimated: Some(usage.is_none()),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some("qoder".into()),
                        },
                    );
                }
                view.log_entry(
                    LogLevel::Info,
                    "Qoder upstream success (stream)",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }
            let message = if last_error.is_empty() {
                "No available Qoder direct credential accounts".to_string()
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

    /// `fetchQoderAccountProfile` — quota + plan + status.
    async fn account_profile(&self, account: &AccountFile) -> Option<Value> {
        let token = self.resolver.resolve(account).await.ok()?;
        let fetch = |path: String| {
            let client = self.http.client();
            let base = self.settings.openapi_base_url.clone();
            let token = token.clone();
            async move {
                client
                    .get(format!("{base}{path}"))
                    .header("authorization", format!("Bearer {token}"))
                    .header("accept", "application/json")
                    .header(
                        "user-agent",
                        crate::providers::qoder_auth::QODER_CLI_USER_AGENT,
                    )
                    .timeout(Duration::from_secs(15))
                    .send()
                    .await
                    .ok()?
                    .json::<Value>()
                    .await
                    .ok()
            }
        };
        let (quota, plan, status) = futures::join!(
            fetch(crate::providers::qoder_auth::QUOTA_USAGE_PATH.to_string()),
            fetch(crate::providers::qoder_auth::USER_PLAN_PATH.to_string()),
            fetch(crate::providers::qoder_auth::USER_STATUS_PATH.to_string()),
        );
        let quota = quota.unwrap_or(Value::Null);
        let plan = plan.unwrap_or(Value::Null);
        let status = status.unwrap_or(Value::Null);
        let pick = |v: &Value, keys: &[&str]| {
            keys.iter().filter_map(|k| v.get(*k)).find_map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
        };
        let quota_info = quota
            .get("userQuota")
            .filter(|q| q.is_object())
            .cloned()
            .unwrap_or(quota.clone());
        let used = quota_info
            .get("used")
            .or_else(|| quota.get("used"))
            .and_then(Value::as_f64);
        let limit = quota_info
            .get("total")
            .or_else(|| quota.get("total"))
            .or_else(|| quota.get("limit"))
            .and_then(Value::as_f64);
        let remaining = quota_info
            .get("remaining")
            .or_else(|| quota.get("remaining"))
            .and_then(Value::as_f64);
        let usage = match (used, limit) {
            (Some(used), Some(limit)) if limit > 0.0 => Some(json!({
                "used": used,
                "limit": limit,
                "remaining": remaining.unwrap_or((limit - used).max(0.0)),
                "isQuotaExceeded": used >= limit,
            })),
            _ => None,
        };
        Some(json!({
            "email": pick(&status, &["email"]).or_else(|| pick(&plan, &["email"])).or_else(|| account.email.clone()),
            "name": pick(&status, &["name"]),
            "subscription": {
                "title": pick(&plan, &["plan_tier_name", "planTierName"])
                    .or_else(|| pick(&status, &["userTag", "plan"]))
                    .unwrap_or_else(|| "Qoder".into()),
                "type": pick(&plan, &["user_type", "userType"])
                    .or_else(|| pick(&status, &["userType", "plan"]))
                    .unwrap_or_else(|| "qoder".into()),
            },
            "usage": usage,
            "keyInfo": {
                "quota": quota,
                "plan": plan,
                "userStatus": status,
            },
        }))
    }
}

fn normalize_openai_chunk(raw: &Value, id: &str, model: &str) -> Value {
    let mut chunk = json!({
        "id": raw.get("id").and_then(Value::as_str).unwrap_or(id),
        "object": raw.get("object").and_then(Value::as_str).unwrap_or("chat.completion.chunk"),
        "created": raw.get("created").and_then(Value::as_u64).unwrap_or_else(|| crate::responses_api::now_secs() as u64),
        "model": raw.get("model").and_then(Value::as_str).unwrap_or(model),
    });
    if let Some(obj) = raw.as_object() {
        for (k, v) in obj {
            chunk[k] = v.clone();
        }
    }
    chunk["choices"] = raw.get("choices").cloned().unwrap_or_else(|| json!([]));
    chunk
}

#[async_trait::async_trait]
impl ProviderAdapter for QoderProvider {
    fn name(&self) -> &'static str {
        "qoder"
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
        let descriptions: HashMap<&str, &str> = QODER_KNOWN_MODELS
            .iter()
            .map(|(id, _, _, d)| (*id, *d))
            .collect();
        self.core
            .pool
            .lock()
            .await
            .list_models()
            .into_iter()
            .map(|id| ProviderModel {
                description: descriptions
                    .get(id.as_str())
                    .map(|d| d.to_string())
                    .or_else(|| Some("Qoder direct API model".into())),
                id,
                provider: "qoder".into(),
                owned_by: Some("qoder".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_qoder_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_QODER_MODEL),
        );
        if !self.core.has_direct_accounts() {
            return no_qoder_credential_response();
        }
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(model, body, ctx)),
            };
        }
        self.core.non_stream(&model, &body, ctx).await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_qoder_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_QODER_MODEL),
        );
        if !self.core.has_direct_accounts() {
            return no_qoder_credential_response();
        }
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
        let response = self.core.non_stream(&model, &openai_body, ctx).await;
        match response {
            GatewayResponse::Json { status, body: b } if status < 400 => {
                GatewayResponse::json(status, openai_completion_to_anthropic(&b, &model, &body))
            }
            other => other,
        }
    }

    async fn count_tokens(
        &self,
        body: Value,
        _ctx: &GatewayRequestContext,
    ) -> Option<GatewayResponse> {
        let text_len = serde_json::to_string(&body).map(|s| s.len()).unwrap_or(0);
        Some(GatewayResponse::json(
            200,
            json!({ "input_tokens": (text_len as u64 / 4).max(1) }),
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
        if !qoder_account_uses_direct_api(&config) {
            return AccountTestResult {
                ok: false,
                account_id: account_id.into(),
                message: "Qoder direct API requires a Personal Access Token or an imported qodercli auth bundle.".into(),
                ..Default::default()
            };
        }
        // smoke test: tiny streamed request
        let result = async {
            let token = self.core.resolver.resolve(&config).await?;
            let payload = build_qoder_chat_payload(
                &json!({
                    "model": "auto",
                    "stream": true,
                    "max_tokens": 64,
                    "messages": [{"role": "user", "content": "Reply with OK only."}],
                }),
                "auto",
                &self.core.settings.max_output_tokens,
                &format!("qoder-test-{account_id}"),
            );
            let mut events = Box::pin(stream_qoder_chat(
                self.core.http.client(),
                self.core.settings.api_base_url.clone(),
                token,
                payload,
                format!("qoder-test-{account_id}"),
                Duration::from_secs(60),
                Duration::from_secs(60),
            ));
            use futures::StreamExt;
            let mut text = String::new();
            while let Some(item) = events.next().await {
                let ev = item?;
                if let Some(t) = ev.text {
                    text.push_str(&t);
                }
            }
            if text.trim().is_empty() {
                anyhow::bail!("Qoder direct API completed without assistant output");
            }
            Ok::<(), anyhow::Error>(())
        }
        .await;
        match result {
            Ok(()) => {
                let models = self.core.refresh_models(account_id).await;
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_updated_at = now_ms();
                        acc.state.last_error = None;
                        acc.state.cooldown_until = None;
                    }
                }
                let auth_type = if config
                    .fields
                    .get("personalAccessToken")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty())
                {
                    "qoder-personal-access-token"
                } else {
                    "qoder-cli-auth"
                };
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: "Qoder direct API account is valid".into(),
                    models,
                    expires_at: None,
                    auth_type: Some(auth_type.into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                let classified = classify_qoder_error(&message);
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
                        acc.state.cooldown_until = (classified.cooldown_ms > 0)
                            .then(|| now_ms() + classified.cooldown_ms as i64);
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
        let config = {
            let pool = self.core.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let Some(config) = config else {
            anyhow::bail!("Account not found");
        };
        self.core.maybe_refresh_models(account_id).await;
        let profile = self.core.account_profile(&config).await;
        let models = self
            .core
            .pool
            .lock()
            .await
            .find(account_id)
            .map(|a| {
                if a.state.model_ids.is_empty() {
                    QODER_KNOWN_MODELS
                        .iter()
                        .map(|(id, ..)| id.to_string())
                        .collect()
                } else {
                    a.state.model_ids.clone()
                }
            })
            .unwrap_or_default();
        let auth_type = if config
            .fields
            .get("personalAccessToken")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        {
            "qoder-personal-access-token"
        } else {
            "qoder-cli-auth"
        };
        Ok(json!({
            "id": account_id,
            "subscription": profile.as_ref().and_then(|p| p.get("subscription")).cloned()
                .unwrap_or_else(|| json!({"title": "Qoder", "type": auth_type})),
            "email": profile.as_ref().and_then(|p| p.get("email")).cloned()
                .unwrap_or_else(|| config.email.clone().map(|e| json!(e)).unwrap_or(Value::Null)),
            "name": profile.as_ref().and_then(|p| p.get("name")).cloned(),
            "usage": profile.as_ref().and_then(|p| p.get("usage")).cloned(),
            "keyInfo": profile.as_ref().and_then(|p| p.get("keyInfo")).cloned(),
            "directApi": qoder_account_uses_direct_api(&config),
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
        Ok(self.core.refresh_models(account_id).await)
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
        let (accounts, direct, models) = self
            .core
            .pool
            .try_lock()
            .map(|p| {
                (
                    p.accounts.len(),
                    p.accounts
                        .iter()
                        .filter(|a| qoder_account_uses_direct_api(&a.config))
                        .count(),
                    p.list_models(),
                )
            })
            .unwrap_or_default();
        ProviderStatus {
            name: "qoder".into(),
            provider_type: "qoder".into(),
            display_name: self.display_name.clone(),
            enabled: self.enabled,
            configured: direct > 0,
            status: if !self.enabled {
                "disabled"
            } else if direct > 0 {
                "ready"
            } else {
                "error"
            },
            message: if direct > 0 {
                Some(format!("{direct} direct credential account(s)"))
            } else {
                Some("No Qoder direct credentials configured".into())
            },
            models: if models.is_empty() {
                QODER_KNOWN_MODELS
                    .iter()
                    .map(|(id, ..)| id.to_string())
                    .collect()
            } else {
                models
            },
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyQoderError` port.
pub fn classify_qoder_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |s: &str| msg.contains(s);
    if has("401")
        || has("403")
        || has("unauthorized")
        || has("forbidden")
        || has("invalid token")
        || has("personal access token")
        || has("authentication")
    {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if has("quota") || has("credit") || has("insufficient") {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 10 * 60_000,
            reset_at_iso: None,
        };
    }
    if has("429") || has("rate limit") || has("too many") {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has("timeout") || has("timed out") {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 5_000,
            reset_at_iso: None,
        };
    }
    if has("enoent") || has("not found") || has("econn") || has("enotfound") || has("network") {
        return ClassifiedError {
            kind: ResponseKind::Network,
            cooldown_ms: 15_000,
            reset_at_iso: None,
        };
    }
    ClassifiedError {
        kind: ResponseKind::ServerError,
        cooldown_ms: 15_000,
        reset_at_iso: None,
    }
}

fn no_qoder_credential_response() -> GatewayResponse {
    GatewayResponse::error(
        502,
        "No available Qoder direct credentials. Add a Personal Access Token or import a qodercli auth bundle.",
        "gateway_error",
    )
}

fn qoder_settings(settings: &JsonMap) -> QoderSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    QoderSettings {
        api_base_url: settings
            .get("apiBaseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(DEFAULT_QODER_MODEL_SERVER_BASE_URL)
            .trim_end_matches('/')
            .to_string(),
        openapi_base_url: DEFAULT_QODER_OPENAPI_BASE_URL.to_string(),
        max_output_tokens: settings
            .get("maxOutputTokens")
            .and_then(Value::as_str)
            .map(|s| {
                if s == "32k" {
                    "32k".to_string()
                } else {
                    "16k".to_string()
                }
            })
            .unwrap_or_else(|| "16k".into()),
        max_retries: settings
            .get("maxRetries")
            .and_then(Value::as_u64)
            .unwrap_or(2) as u32,
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 120)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 300)),
    }
}
