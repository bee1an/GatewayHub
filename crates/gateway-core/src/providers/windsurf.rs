//! Windsurf provider — port of `providers/windsurf/provider.ts`.
//! Unlike HTTP providers, this drives a per-account local language-server
//! process over Connect-RPC and polls Cascade trajectories.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::protocol::extract_text;
use crate::provider::ProviderAdapter;
use crate::providers::windsurf_cascade::{
    WindsurfImageAttachment, WindsurfPromptPayload, WindsurfSettingsView, get_windsurf_user_models,
    run_windsurf_cascade, run_windsurf_cascade_stream,
};
use crate::providers::windsurf_connect::{
    DEFAULT_INFERENCE_API_SERVER_URL, DEFAULT_WINDSURF_API_SERVER_URL, DEFAULT_WINDSURF_MODEL,
    WindsurfLanguageServerClient, normalize_windsurf_model,
};
use crate::providers::windsurf_stream::{
    anthropic_json_from_text, anthropic_sse_from_cascade_deltas, openai_json_from_text,
    openai_sse_from_cascade_deltas,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind,
};

const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

#[derive(Debug, Clone)]
struct WindsurfSettings {
    api_server_url: String,
    inference_api_server_url: String,
    language_server_binary_path: String,
    codeium_dir: String,
    vpn_proxy_url: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
    launch_timeout: Duration,
    detect_proxy: bool,
}

impl WindsurfSettings {
    fn view(&self) -> WindsurfSettingsView {
        WindsurfSettingsView {
            launch_timeout: self.launch_timeout,
            first_token_timeout: self.first_token_timeout,
            streaming_read_timeout: self.streaming_read_timeout,
        }
    }
}

struct WindsurfBehavior;
impl crate::pool::PoolBehavior for WindsurfBehavior {
    fn provider_name(&self) -> &'static str {
        "windsurf"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_windsurf_model(model)
    }
    /// Empty model list → accept everything (models load lazily via
    /// GetUserStatus).
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        if account.state.model_ids.is_empty() {
            return true;
        }
        account
            .state
            .model_ids
            .iter()
            .any(|m| normalize_windsurf_model(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        Vec::new()
    }
}

pub struct WindsurfProvider {
    core: Arc<WindsurfCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct WindsurfCore {
    pool: Arc<Mutex<AccountPool<WindsurfBehavior>>>,
    clients: Mutex<HashMap<String, Arc<WindsurfLanguageServerClient>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<WindsurfSettings>,
    log: LogSink,
}

impl WindsurfProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        _persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let mut settings = windsurf_settings(&provider_config.settings);
        // runtime-injected proxy: vpnProxyUrl is resolved from the global
        // server.proxyUrl + provider useProxy flag (TS registry behavior)
        if provider_config.use_proxy.unwrap_or(false) && settings.vpn_proxy_url.is_empty() {
            settings.vpn_proxy_url = proxy_url.to_string();
        }
        let http = UpstreamHttp::new("http://127.0.0.1", Some(proxy_url))?;

        let mut pool = AccountPool::new(WindsurfBehavior);
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
        // windsurf invalidates persisted model caches on reload (older builds
        // cached disabled/BYOK ids)
        {
            for acc in &mut pool.accounts {
                acc.state.models_cached_at = 0;
                acc.state.model_ids = Vec::new();
            }
        }

        Ok(Self {
            core: Arc::new(WindsurfCore {
                pool: Arc::new(Mutex::new(pool)),
                clients: Mutex::new(HashMap::new()),
                http: Arc::new(http),
                settings: Arc::new(settings),
                log,
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
}

impl WindsurfCore {
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
            provider: Some("windsurf".into()),
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

    /// `ensureClient` — lazily construct + start the language server.
    async fn ensure_client(
        &self,
        account_id: &str,
    ) -> anyhow::Result<Arc<WindsurfLanguageServerClient>> {
        if let Some(client) = self.clients.lock().await.get(account_id) {
            client.ensure_started().await?;
            return Ok(client.clone());
        }
        let Some(config) = ({
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        }) else {
            anyhow::bail!("Account not found: {account_id}");
        };
        if config
            .fields
            .get("apiKey")
            .and_then(Value::as_str)
            .unwrap_or("")
            .is_empty()
        {
            anyhow::bail!("Missing Windsurf apiKey/accessToken");
        }
        let client = Arc::new(WindsurfLanguageServerClient::new(
            &config,
            &self.settings.api_server_url,
            &self.settings.inference_api_server_url,
            &self.settings.language_server_binary_path,
            &self.settings.codeium_dir,
            self.settings.detect_proxy,
            &self.settings.vpn_proxy_url,
            self.settings.launch_timeout,
            self.http.client(),
        ));
        client.ensure_started().await?;
        self.clients
            .lock()
            .await
            .insert(account_id.to_string(), client.clone());
        Ok(client)
    }

    async fn try_ensure_client(&self, account_id: &str) -> bool {
        match self.ensure_client(account_id).await {
            Ok(_) => true,
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.last_error = Some(message.clone());
                    acc.state.last_failure_at = now_ms();
                    acc.state.status = AccountStatus::AuthFailed;
                    acc.state.status_reason = Some(message.chars().take(200).collect());
                    acc.state.status_updated_at = now_ms();
                }
                false
            }
        }
    }

    /// windsurf ordering: model → availability → client start.
    async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<WindsurfLanguageServerClient>)> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                if !self.pool.lock().await.has_model(&id, model) {
                    continue;
                }
                if !self.try_ensure_client(&id).await {
                    continue;
                }
                let client = self.clients.lock().await.get(&id).cloned();
                let mut pool = self.pool.lock().await;
                pool.commit(&id);
                if let (Some(acc), Some(client)) = (pool.find(&id).cloned(), client) {
                    return Some((acc, client));
                }
            }
        }
        None
    }

    /// `maybeRefreshAccountModels` — 30min TTL → GetUserStatus model ids.
    async fn maybe_refresh_models(&self, account_id: &str) -> anyhow::Result<()> {
        {
            let pool = self.pool.lock().await;
            if let Some(acc) = pool.find(account_id)
                && acc.state.models_cached_at > 0
                && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
                && !acc.state.model_ids.is_empty()
            {
                return Ok(());
            }
        }
        let client = self.ensure_client(account_id).await?;
        let models = get_windsurf_user_models(&client, self.settings.launch_timeout)
            .await?
            .iter()
            .map(|m| normalize_windsurf_model(m))
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.model_ids = models;
            acc.state.models_cached_at = now_ms();
        }
        Ok(())
    }

    fn build_prompt(&self, format: &'static str, body: &Value) -> WindsurfPromptPayload {
        if format == "openai" {
            openai_to_windsurf_prompt(body)
        } else {
            anthropic_to_windsurf_prompt(body)
        }
    }

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
        for attempt in 0..total {
            let Some((account, client)) = self.get_account_for_model(model, &excluded).await else {
                break;
            };
            let started = now_ms();
            let payload = self.build_prompt(format, body);
            match run_windsurf_cascade(&client, &payload, model, self.settings.view()).await {
                Ok(result) => {
                    let out = if format == "openai" {
                        openai_json_from_text(
                            &result.text,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            Some(&result.usage),
                            &result.tool_calls,
                            &account.config.id,
                        )
                    } else {
                        anthropic_json_from_text(
                            &result.text,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            Some(&result.usage),
                            &result.tool_calls,
                            &account.config.id,
                        )
                    };
                    self.pool.lock().await.report_success(&account.config.id);
                    self.log_entry(
                        LogLevel::Info,
                        "Windsurf upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    return GatewayResponse::json(200, out);
                }
                Err(e) => {
                    last_error = e.to_string();
                    let classified = classify_windsurf_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Windsurf upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    if classified.kind != ResponseKind::Timeout
                        && classified.kind != ResponseKind::Network
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32)))
                        .await;
                }
            }
        }
        GatewayResponse::error(
            502,
            format!(
                "Windsurf request failed: {}",
                if last_error.is_empty() {
                    "No available accounts".into()
                } else {
                    last_error
                }
            ),
            "gateway_error",
        )
    }

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
            'outer: for attempt in 0..total {
                let Some((account, client)) = view.get_account_for_model(&model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let payload = view.build_prompt(format, &body);
                let source = run_windsurf_cascade_stream(
                    client,
                    payload,
                    model.clone(),
                    view.settings.view(),
                );
                let account_id = account.config.id.clone();
                let sink = on_usage.clone();
                let mut inner: std::pin::Pin<Box<dyn Stream<Item = String> + Send>> =
                    if format == "openai" {
                        Box::pin(openai_sse_from_cascade_deltas(
                            source,
                            model.clone(),
                            body.clone(),
                            sink,
                            account_id.clone(),
                        ))
                    } else {
                        Box::pin(anthropic_sse_from_cascade_deltas(
                            source,
                            model.clone(),
                            body.clone(),
                            sink,
                            account_id.clone(),
                        ))
                    };
                use futures::StreamExt;
                let mut emitted = false;
                let mut stream_err: Option<String> = None;
                while let Some(frame) = inner.next().await {
                    if frame.contains("\"error\"") {
                        stream_err = Some(frame.clone());
                        // don't forward mid-stream error payloads; fall through
                        // to failover accounting below
                        continue;
                    }
                    emitted = true;
                    yield frame;
                }
                if let Some(err_frame) = stream_err {
                    // the inner stream emitted an upstream error sentinel
                    let classified = classify_windsurf_error(&err_frame);
                    view.pool.lock().await.report_failure(
                        &account_id,
                        &err_frame,
                        &classified,
                    );
                    excluded.insert(account_id.clone());
                    if emitted {
                        yield err_frame;
                        break 'outer;
                    }
                    if classified.kind != ResponseKind::Timeout
                        && classified.kind != ResponseKind::Network
                    {
                        yield err_frame;
                        break 'outer;
                    }
                    last_error = err_frame;
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
                view.pool.lock().await.report_success(&account_id);
                view.log_entry(
                    LogLevel::Info,
                    "Windsurf stream success",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }

            let message = format!(
                "Windsurf stream failed: {}",
                if last_error.is_empty() { "No available accounts".to_string() } else { last_error }
            );
            if cancel.is_cancelled() {
                return;
            }
            if format == "openai" {
                yield format!(
                    "data: {}\n\n",
                    serde_json::to_string(&json!({
                        "error": {"message": message, "type": "gateway_error", "code": "windsurf_error"},
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

#[async_trait::async_trait]
impl ProviderAdapter for WindsurfProvider {
    fn name(&self) -> &'static str {
        "windsurf"
    }

    /// `listModelsFresh` — refresh each enabled account's model list first.
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
            let _ = self.core.maybe_refresh_models(id).await;
        }
        let models = self.core.pool.lock().await.list_models();
        models
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "windsurf".into(),
                owned_by: Some("windsurf".into()),
                description: Some("Model via Windsurf provider".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_windsurf_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_WINDSURF_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("openai", model, body, ctx)),
            };
        }
        self.core.non_stream("openai", &model, &body, ctx).await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_windsurf_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_WINDSURF_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("anthropic", model, body, ctx)),
            };
        }
        self.core.non_stream("anthropic", &model, &body, ctx).await
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
        match self.core.ensure_client(account_id).await {
            Ok(_) => {
                let _ = self.core.maybe_refresh_models(account_id).await;
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
                    message: "Windsurf account is valid".into(),
                    models,
                    auth_type: Some("windsurf-api-key".into()),
                    ..Default::default()
                }
            }
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.core.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
                    acc.state.last_error = Some(message.clone());
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
        {
            let pool = self.core.pool.lock().await;
            if pool.find(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
        }
        let _ = self.core.maybe_refresh_models(account_id).await;
        let (models, email) = {
            let pool = self.core.pool.lock().await;
            let acc = pool.find(account_id);
            (
                acc.map(|a| a.state.model_ids.clone()).unwrap_or_default(),
                acc.and_then(|a| a.config.email.clone()),
            )
        };
        Ok(json!({
            "subscription": {"title": "Windsurf", "type": "unknown"},
            "email": email,
            "models": models.iter().map(|m| json!({
                "modelId": m, "modelName": m, "rateMultiplier": 1, "rateUnit": "request",
            })).collect::<Vec<_>>(),
        }))
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let mut pool = self.core.pool.lock().await;
            let Some(acc) = pool.find_mut(account_id) else {
                anyhow::bail!("Account not found");
            };
            acc.state.models_cached_at = 0;
        }
        self.core.maybe_refresh_models(account_id).await?;
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
            name: "windsurf".into(),
            provider_type: "windsurf".into(),
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
                Some("No Windsurf accounts configured".into())
            },
            models,
            use_proxy: None,
            accounts,
        }
    }
}

// ---------------------------------------------------------------------------
// prompt converters (converters.ts)
// ---------------------------------------------------------------------------

pub fn openai_to_windsurf_prompt(body: &Value) -> WindsurfPromptPayload {
    let mut lines: Vec<String> = Vec::new();
    let mut images: Vec<WindsurfImageAttachment> = Vec::new();
    for msg in body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
        let content = msg.get("content").unwrap_or(&Value::Null);
        let text = extract_text(content);
        images.extend(extract_openai_images(content));
        match role {
            "system" | "developer" => {
                if !text.is_empty() {
                    lines.push(format!("System: {text}"));
                }
            }
            "assistant" => {
                if !text.is_empty() {
                    lines.push(format!("Assistant: {text}"));
                }
                for call in msg
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    let name = call
                        .pointer("/function/name")
                        .or_else(|| call.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let args = call
                        .pointer("/function/arguments")
                        .or_else(|| call.get("arguments"))
                        .map(|a| match a {
                            Value::String(s) => s.clone(),
                            other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
                        })
                        .unwrap_or_else(|| "{}".into());
                    lines.push(format!("Assistant tool call {name}: {args}"));
                }
            }
            "tool" => {
                let id = msg
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                lines.push(format!(
                    "Tool result{}: {text}",
                    if id.is_empty() {
                        String::new()
                    } else {
                        format!(" {id}")
                    }
                ));
            }
            _ => {
                if !text.is_empty() {
                    lines.push(format!("User: {text}"));
                }
            }
        }
    }
    append_image_notes(&mut lines, &images);
    WindsurfPromptPayload {
        prompt: lines.join("\n\n"),
        images,
    }
}

pub fn anthropic_to_windsurf_prompt(body: &Value) -> WindsurfPromptPayload {
    let system = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        other => extract_text(other.unwrap_or(&Value::Null)),
    };
    let mut lines: Vec<String> = if system.is_empty() {
        Vec::new()
    } else {
        vec![format!("System: {system}")]
    };
    let mut images: Vec<WindsurfImageAttachment> = Vec::new();
    for msg in body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            "Assistant"
        } else {
            "User"
        };
        let content = msg.get("content").unwrap_or(&Value::Null);
        let Some(blocks) = content.as_array() else {
            let text = extract_text(content);
            if !text.is_empty() {
                lines.push(format!("{role}: {text}"));
            }
            continue;
        };
        images.extend(extract_anthropic_images(blocks));
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text")
                    if block
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|t| !t.is_empty()) =>
                {
                    lines.push(format!("{role}: {}", block["text"].as_str().unwrap()));
                }
                Some("tool_use") => {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = serde_json::to_string(block.get("input").unwrap_or(&json!({})))
                        .unwrap_or_else(|_| "{}".into());
                    lines.push(format!("Assistant tool call {name}: {input}"));
                }
                Some("tool_result") => {
                    let text = extract_text(block.get("content").unwrap_or(&Value::Null));
                    let id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    lines.push(format!("Tool result {id}: {text}"));
                }
                _ => {}
            }
        }
    }
    append_image_notes(&mut lines, &images);
    WindsurfPromptPayload {
        prompt: lines.join("\n\n"),
        images,
    }
}

fn extract_openai_images(content: &Value) -> Vec<WindsurfImageAttachment> {
    let mut images = Vec::new();
    for part in content.as_array().cloned().unwrap_or_default() {
        match part.get("type").and_then(Value::as_str) {
            Some("image_url") => {
                let url = match part.get("image_url") {
                    Some(Value::String(s)) => s.clone(),
                    other => other
                        .and_then(|v| v.get("url").cloned())
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default(),
                };
                let caption = part
                    .get("detail")
                    .or_else(|| part.pointer("/image_url/detail"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some((mime, data)) = data_url_to_image(&url) {
                    images.push(WindsurfImageAttachment {
                        mime_type: Some(mime),
                        base64_data: Some(data),
                        caption,
                        source_url: None,
                    });
                } else if !url.is_empty() {
                    images.push(WindsurfImageAttachment {
                        source_url: Some(url),
                        caption,
                        ..Default::default()
                    });
                }
            }
            Some("input_image") | Some("image") => {
                let data = part
                    .get("image_base64")
                    .or_else(|| part.get("data"))
                    .or_else(|| part.get("base64"))
                    .or_else(|| part.get("base64Data"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !data.trim().is_empty() {
                    images.push(WindsurfImageAttachment {
                        base64_data: Some(strip_data_url_prefix(data)),
                        mime_type: part
                            .get("mime_type")
                            .or_else(|| part.get("mimeType"))
                            .and_then(Value::as_str)
                            .unwrap_or("image/png")
                            .to_string()
                            .into(),
                        caption: part
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        ..Default::default()
                    });
                }
            }
            _ => {}
        }
    }
    images
}

fn extract_anthropic_images(blocks: &[Value]) -> Vec<WindsurfImageAttachment> {
    let mut images = Vec::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let src = block.get("source").cloned().unwrap_or(json!({}));
        match src.get("type").and_then(Value::as_str) {
            Some("base64") => {
                if let Some(data) = src.get("data").and_then(Value::as_str) {
                    images.push(WindsurfImageAttachment {
                        base64_data: Some(strip_data_url_prefix(data)),
                        mime_type: src
                            .get("media_type")
                            .or_else(|| src.get("mediaType"))
                            .and_then(Value::as_str)
                            .unwrap_or("image/png")
                            .to_string()
                            .into(),
                        ..Default::default()
                    });
                }
            }
            _ => {
                if let Some(url) = src.get("url").and_then(Value::as_str) {
                    images.push(WindsurfImageAttachment {
                        source_url: Some(url.to_string()),
                        ..Default::default()
                    });
                }
            }
        }
    }
    images
}

fn append_image_notes(lines: &mut Vec<String>, images: &[WindsurfImageAttachment]) {
    if images.is_empty() {
        return;
    }
    let native = images.iter().filter(|i| i.base64_data.is_some()).count();
    let url_count = images.len() - native;
    let mut parts = vec![format!("{} image(s) attached", images.len())];
    if native > 0 {
        parts.push(format!("{native} sent as native Cascade image data"));
    }
    if url_count > 0 {
        parts.push(format!("{url_count} URL-only image(s) referenced in text"));
    }
    lines.push(format!("User image context: {}.", parts.join("; ")));
    for (i, image) in images.iter().enumerate() {
        if let Some(url) = &image.source_url {
            lines.push(format!("Image {} URL: {url}", i + 1));
        } else if let Some(caption) = &image.caption {
            lines.push(format!("Image {} caption: {caption}", i + 1));
        }
    }
}

fn data_url_to_image(value: &str) -> Option<(String, String)> {
    let rest = value.strip_prefix("data:")?;
    let (header, data) = rest.split_once(',')?;
    if !header.contains("base64") {
        return None;
    }
    Some((
        header.split(';').next().unwrap_or("image/png").to_string(),
        data.trim().to_string(),
    ))
}

fn strip_data_url_prefix(value: &str) -> String {
    data_url_to_image(value)
        .map(|(_, d)| d)
        .unwrap_or_else(|| value.trim().to_string())
}

/// `classifyWindsurfError` port — quota before auth (the "api key has
/// exceeded its quota" message mentions api keys).
pub fn classify_windsurf_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |p: &str| regex::Regex::new(p).unwrap().is_match(&msg);
    if has(r"high demand|try again later|temporarily unavailable|overloaded") {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"quota|usage limit|exceeded") {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 60 * 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"rate limit|429|too many requests") {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"unauthenticated|invalid api key|missing api key|unauthorized|401|403") {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if has(r"timeout") {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    if has(r"fetch failed|econnrefused|econnreset|enotfound|network") {
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

fn windsurf_settings(settings: &JsonMap) -> WindsurfSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    WindsurfSettings {
        api_server_url: settings
            .get("apiServerUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_WINDSURF_API_SERVER_URL)
            .to_string(),
        inference_api_server_url: settings
            .get("inferenceApiServerUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_INFERENCE_API_SERVER_URL)
            .to_string(),
        language_server_binary_path: settings
            .get("languageServerBinaryPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        codeium_dir: settings
            .get("codeiumDir")
            .and_then(Value::as_str)
            .unwrap_or(".codeium/windsurf")
            .to_string(),
        vpn_proxy_url: settings
            .get("vpnProxyUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 60)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
        launch_timeout: Duration::from_secs(secs("launchTimeoutSeconds", 20)),
        detect_proxy: settings
            .get("detectProxy")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}
