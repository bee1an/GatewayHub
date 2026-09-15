//! Trae provider — port of `providers/trae/provider.ts`. Chat goes either
//! through the local Trae.app ai-agent bridge (CDP-injected) or the
//! llm_raw_chat HTTP endpoint; "stream" collects then re-emits SSE.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::provider::ProviderAdapter;
use crate::providers::trae_auth::{
    DEFAULT_TRAE_AUTH_BASE_URL, DEFAULT_TRAE_CLIENT_ID, DEFAULT_TRAE_CORE_BASE_URL,
    DEFAULT_TRAE_LOCAL_APP_PATH, DEFAULT_TRAE_LOCAL_DEBUG_PORT, DEFAULT_TRAE_MODEL,
    DEFAULT_TRAE_MODEL_LIST_PATH, DEFAULT_TRAE_RAW_CHAT_PATH, TraeAuth, TraeTokenSnapshot,
    normalize_trae_model,
};
use crate::providers::trae_local_bridge::{TraeLocalChatResult, run_trae_local_chat};
use crate::providers::trae_rawchat::{
    anthropic_sse_from_text, anthropic_to_trae_messages, build_trae_raw_chat_payload,
    openai_sse_from_text, openai_to_trae_messages, run_trae_raw_chat,
};
use crate::providers::windsurf_stream::{
    anthropic_json_from_text as anthropic_json, openai_json_from_text as openai_json,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind,
};

const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

#[derive(Debug, Clone)]
struct TraeSettings {
    auth_base_url: String,
    core_base_url: String,
    client_id: String,
    raw_chat_path: String,
    local_chat_enabled: bool,
    local_debug_port: u16,
    local_app_path: String,
    model_list_path: String,
    ide_version: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
    expose_unavailable_in_us: bool,
}

struct TraeBehavior;
impl crate::pool::PoolBehavior for TraeBehavior {
    fn provider_name(&self) -> &'static str {
        "trae"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_trae_model(model)
    }
    /// Empty model list → accept everything (loaded lazily per account).
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        if account.state.model_ids.is_empty() {
            return true;
        }
        account
            .state
            .model_ids
            .iter()
            .any(|m| normalize_trae_model(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        vec![DEFAULT_TRAE_MODEL.to_string()]
    }
}

pub struct TraeProvider {
    core: Arc<TraeCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct TraeCore {
    pool: Arc<Mutex<AccountPool<TraeBehavior>>>,
    auths: Mutex<HashMap<String, Arc<TraeAuth>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<TraeSettings>,
    persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
}

impl TraeProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = trae_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.core_base_url, Some(proxy_url))?;

        let mut pool = AccountPool::new(TraeBehavior);
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
        // trae invalidates persisted model caches on reload (older builds
        // filtered upstream models through a built-in whitelist)
        for acc in &mut pool.accounts {
            acc.state.models_cached_at = 0;
            acc.state.model_ids = Vec::new();
        }

        Ok(Self {
            core: Arc::new(TraeCore {
                pool: Arc::new(Mutex::new(pool)),
                auths: Mutex::new(HashMap::new()),
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

impl TraeCore {
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
            provider: Some("trae".into()),
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

    /// `ensureAuth` — eagerly construct per-account auth (sync init in TS
    /// reload); lazily here on first access.
    async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<TraeAuth>> {
        if let Some(auth) = self.auths.lock().await.get(account_id) {
            return Ok(auth.clone());
        }
        let Some(config) = ({
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        }) else {
            anyhow::bail!("Account not found: {account_id}");
        };
        let persist = self.persist_account.clone();
        let pool_ref = self.pool.clone();
        let on_change: Arc<dyn Fn(&str, &TraeTokenSnapshot) + Send + Sync> =
            Arc::new(move |acc_id: &str, snap: &TraeTokenSnapshot| {
                if let Ok(mut pool) = pool_ref.try_lock()
                    && let Some(acc) = pool.find_mut(acc_id)
                {
                    apply_token_snapshot(&mut acc.config, snap);
                    let config = acc.config.clone();
                    if let Some(persist) = &persist {
                        persist(&config);
                    }
                }
            });
        let auth = Arc::new(TraeAuth::new(
            &config,
            &self.settings.auth_base_url,
            &self.settings.core_base_url,
            &self.settings.client_id,
            &self.settings.ide_version,
            &self.settings.model_list_path,
            self.http.client(),
            Some(on_change),
        ));
        self.auths
            .lock()
            .await
            .insert(account_id.to_string(), auth.clone());
        Ok(auth)
    }

    async fn try_ensure_auth(&self, account_id: &str) -> bool {
        match self.ensure_auth(account_id).await {
            Ok(auth) => match auth.get_jwt_token().await {
                Ok(_) => true,
                Err(e) => {
                    self.mark_auth_failed(account_id, &e.to_string()).await;
                    false
                }
            },
            Err(e) => {
                self.mark_auth_failed(account_id, &e.to_string()).await;
                false
            }
        }
    }

    async fn mark_auth_failed(&self, account_id: &str, message: &str) {
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.last_error = Some(message.to_string());
            acc.state.last_failure_at = now_ms();
            acc.state.status = AccountStatus::AuthFailed;
            acc.state.status_reason = Some(message.chars().take(200).collect());
            acc.state.status_updated_at = now_ms();
            acc.state.cooldown_until = None;
        }
    }

    /// trae ordering: availability → model → auth.
    async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<TraeAuth>)> {
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

    /// `refreshAccountModels` — GetModelList → sanitize → fallback built-ins.
    async fn refresh_models(&self, account_id: &str) {
        let models = match self.ensure_auth(account_id).await {
            Ok(auth) => auth.get_model_list().await.unwrap_or_else(|e| {
                self.log_entry(
                    LogLevel::Warn,
                    format!("Trae model list refresh failed: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
                Vec::new()
            }),
            Err(e) => {
                self.log_entry(
                    LogLevel::Warn,
                    format!("Trae model list refresh failed: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
                Vec::new()
            }
        };
        let usable: Vec<String> = models
            .iter()
            .map(|m| normalize_trae_model(m))
            .filter(|m| !m.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let country_code = {
            let pool = self.pool.lock().await;
            pool.find(account_id).and_then(|a| {
                a.config
                    .fields
                    .get("countryCode")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
        };
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.model_ids = if usable.is_empty() {
                fallback_models(
                    self.settings.expose_unavailable_in_us,
                    country_code.as_deref(),
                )
            } else {
                usable
            };
            acc.state.models_cached_at = now_ms();
        }
    }

    async fn maybe_refresh_models(&self, account_id: &str) {
        {
            let pool = self.pool.lock().await;
            if let Some(acc) = pool.find(account_id)
                && acc.state.models_cached_at > 0
                && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
                && !acc.state.model_ids.is_empty()
            {
                return;
            }
        }
        self.refresh_models(account_id).await;
    }

    /// `callTrae` — localChatEnabled → local bridge, else rawChat.
    async fn call_trae(
        &self,
        account: &AccountWithState,
        auth: &Arc<TraeAuth>,
        format: &'static str,
        model: &str,
        body: &Value,
    ) -> anyhow::Result<(
        String,
        Option<crate::types::UsageStats>,
        Vec<crate::providers::windsurf_stream::GatewayToolCall>,
    )> {
        if self.settings.local_chat_enabled {
            let token = auth.get_jwt_token().await?;
            let messages = if format == "openai" {
                openai_to_trae_messages(body)
            } else {
                anthropic_to_trae_messages(body)
            };
            let prompt = build_prompt(&messages);
            let field = |k: &str| {
                account
                    .config
                    .fields
                    .get(k)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            let TraeLocalChatResult { text, usage, .. } = run_trae_local_chat(
                &self.http.client(),
                self.settings.local_debug_port,
                &self.settings.local_app_path,
                &account
                    .config
                    .email
                    .clone()
                    .or_else(|| account.config.label.clone())
                    .unwrap_or_default(),
                &field("userId"),
                &field("countryCode"),
                &token,
                model,
                prompt,
                self.settings.streaming_read_timeout,
            )
            .await?;
            if let Some(err) = text.strip_prefix("__TRAE_ERROR__:") {
                anyhow::bail!(
                    "Trae stream error: {}",
                    err.chars().take(800).collect::<String>()
                );
            }
            return Ok((text, usage, Vec::new()));
        }
        let core_base = account
            .config
            .fields
            .get("coreBaseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| self.settings.core_base_url.clone());
        let payload = build_trae_raw_chat_payload(model, body, format);
        let result = run_trae_raw_chat(
            auth,
            &self.http.client(),
            &core_base,
            &self.settings.raw_chat_path,
            &self.settings.ide_version,
            &payload,
            self.settings.first_token_timeout,
            self.settings.streaming_read_timeout,
        )
        .await?;
        if let Some(err) = result.text.strip_prefix("__TRAE_ERROR__:") {
            anyhow::bail!(
                "Trae stream error: {}",
                err.chars().take(800).collect::<String>()
            );
        }
        Ok((result.text, result.usage, result.tool_calls))
    }

    async fn non_stream(
        &self,
        format: &'static str,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> anyhow::Result<Value> {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.pool.lock().await.accounts.len().max(1);
        for attempt in 0..total {
            let Some((account, auth)) = self.get_account_for_model(model, &excluded).await else {
                break;
            };
            let started = now_ms();
            match self.call_trae(&account, &auth, format, model, body).await {
                Ok((text, usage, tool_calls)) => {
                    // usage sink runs inside the output converters
                    let out = if format == "openai" {
                        openai_json(
                            &text,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            usage.as_ref(),
                            &tool_calls,
                            &account.config.id,
                            "trae",
                        )
                    } else {
                        anthropic_json(
                            &text,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            usage.as_ref(),
                            &tool_calls,
                            &account.config.id,
                            "trae",
                        )
                    };
                    self.pool.lock().await.report_success(&account.config.id);
                    self.log_entry(
                        LogLevel::Info,
                        "Trae upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    return Ok(out);
                }
                Err(e) => {
                    last_error = e.to_string();
                    let classified = classify_trae_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Trae upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    if !matches!(
                        classified.kind,
                        ResponseKind::Timeout | ResponseKind::Network | ResponseKind::ServerError
                    ) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32)))
                        .await;
                }
            }
        }
        anyhow::bail!(
            "Trae request failed: {}",
            if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            }
        )
    }
}

fn build_prompt(messages: &[crate::providers::trae_rawchat::TraeMessage]) -> String {
    let users: Vec<_> = messages.iter().filter(|m| m.role == "user").collect();
    if messages.len() == 1 && users.len() == 1 {
        return users[0].content.clone();
    }
    messages
        .iter()
        .map(|m| format!("{}:\n{}", m.role.to_uppercase(), m.content))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn fallback_models(expose_unavailable_in_us: bool, country_code: Option<&str>) -> Vec<String> {
    let _ = (expose_unavailable_in_us, country_code);
    vec![DEFAULT_TRAE_MODEL.to_string()]
}

fn apply_token_snapshot(config: &mut AccountFile, snap: &TraeTokenSnapshot) {
    let fields = &mut config.fields;
    if !snap.jwt_token.is_empty() {
        fields.insert("jwtToken".into(), json!(snap.jwt_token));
    }
    if !snap.refresh_token.is_empty() {
        fields.insert("refreshToken".into(), json!(snap.refresh_token));
    }
    if snap.token_expires_at > 0 {
        fields.insert("tokenExpiresAt".into(), json!(snap.token_expires_at));
    }
    if snap.refresh_expires_at > 0 {
        fields.insert("refreshExpiresAt".into(), json!(snap.refresh_expires_at));
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for TraeProvider {
    fn name(&self) -> &'static str {
        "trae"
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
        let mut models = self.core.pool.lock().await.list_models();
        if models.is_empty() {
            models = vec![DEFAULT_TRAE_MODEL.to_string()];
        }
        models
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "trae".into(),
                owned_by: Some("trae".into()),
                description: Some("Model via Trae provider".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_trae_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAE_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            // trae stream = collect then re-emit one text blob
            let mut collect_body = body.clone();
            collect_body["stream"] = json!(false);
            match self
                .core
                .non_stream("openai", &model, &collect_body, ctx)
                .await
            {
                Ok(result) => {
                    let text = result
                        .pointer("/choices/0/message/content")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let tool_calls = result
                        .pointer("/choices/0/message/tool_calls")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|item| {
                                    Some(crate::providers::windsurf_stream::GatewayToolCall {
                                        id: item
                                            .get("id")
                                            .and_then(Value::as_str)
                                            .map(str::to_string),
                                        name: item
                                            .pointer("/function/name")
                                            .and_then(Value::as_str)?
                                            .to_string(),
                                        input: item
                                            .pointer("/function/arguments")
                                            .cloned()
                                            .unwrap_or(json!({})),
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let frames = openai_sse_from_text(&text, &model, &body, None, &tool_calls);
                    return GatewayResponse::Sse {
                        status: 200,
                        stream: Box::pin(futures::stream::once(async move { frames })),
                    };
                }
                Err(e) => {
                    let message = format!("Trae stream failed: {e}");
                    return GatewayResponse::Sse {
                        status: 200,
                        stream: Box::pin(futures::stream::once(async move {
                            format!(
                                "data: {}\n\ndata: [DONE]\n\n",
                                serde_json::to_string(&json!({
                                    "error": {"message": message, "type": "gateway_error", "code": "trae_error"},
                                }))
                                .unwrap_or_default()
                            )
                        })),
                    };
                }
            }
        }
        match self.core.non_stream("openai", &model, &body, ctx).await {
            Ok(v) => GatewayResponse::json(200, v),
            Err(e) => GatewayResponse::error(502, e.to_string(), "gateway_error"),
        }
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_trae_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAE_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            let mut collect_body = body.clone();
            collect_body["stream"] = json!(false);
            match self
                .core
                .non_stream("anthropic", &model, &collect_body, ctx)
                .await
            {
                Ok(result) => {
                    let text = result
                        .get("content")
                        .and_then(Value::as_array)
                        .and_then(|arr| {
                            arr.iter()
                                .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        })
                        .and_then(|b| b.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let tool_calls = result
                        .get("content")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter(|b| {
                                    b.get("type").and_then(Value::as_str) == Some("tool_use")
                                })
                                .filter_map(|item| {
                                    Some(crate::providers::windsurf_stream::GatewayToolCall {
                                        id: item
                                            .get("id")
                                            .and_then(Value::as_str)
                                            .map(str::to_string),
                                        name: item.get("name").and_then(Value::as_str)?.to_string(),
                                        input: item.get("input").cloned().unwrap_or(json!({})),
                                    })
                                })
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    let frames = anthropic_sse_from_text(&text, &model, &body, None, &tool_calls);
                    return GatewayResponse::Sse {
                        status: 200,
                        stream: Box::pin(futures::stream::once(async move { frames })),
                    };
                }
                Err(e) => {
                    let message = format!("Trae stream failed: {e}");
                    return GatewayResponse::Sse {
                        status: 200,
                        stream: Box::pin(futures::stream::once(async move {
                            format!(
                                "event: error\ndata: {}\n\n",
                                serde_json::to_string(&json!({
                                    "type": "error",
                                    "error": {"type": "api_error", "message": message},
                                }))
                                .unwrap_or_default()
                            )
                        })),
                    };
                }
            }
        }
        match self.core.non_stream("anthropic", &model, &body, ctx).await {
            Ok(v) => GatewayResponse::json(200, v),
            Err(e) => GatewayResponse::error(502, e.to_string(), "gateway_error"),
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
        let auth = match self.core.ensure_auth(account_id).await {
            Ok(a) => a,
            Err(e) => {
                self.core.mark_auth_failed(account_id, &e.to_string()).await;
                return AccountTestResult {
                    ok: false,
                    account_id: account_id.into(),
                    message: e.to_string(),
                    ..Default::default()
                };
            }
        };
        match auth.get_user_info().await {
            Ok(info) => {
                // persist updated user fields
                let persist = self.core.persist_account.clone();
                let mut pool = self.core.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    for (key, field) in [
                        ("email", "email"),
                        ("userId", "userId"),
                        ("countryCode", "countryCode"),
                    ] {
                        if let Some(v) = info
                            .get(key)
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            if acc.config.fields.get(field).and_then(Value::as_str) != Some(v) {
                                acc.config.fields.insert(field.into(), json!(v));
                            }
                        }
                    }
                    if let Some(persist) = &persist {
                        persist(&acc.config);
                    }
                }
                drop(pool);
                self.core.refresh_models(account_id).await;
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
                    message: "Trae account is valid".into(),
                    models,
                    expires_at: auth.expires_at_iso().await,
                    auth_type: Some(auth.auth_type().await.into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                self.core.mark_auth_failed(account_id, &message).await;
                let mut pool = self.core.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.failures += 1;
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
        let (models, email, country, auth_base, core_base) = {
            let pool = self.core.pool.lock().await;
            let acc = pool.find(account_id);
            (
                acc.map(|a| a.state.model_ids.clone()).unwrap_or_default(),
                acc.and_then(|a| a.config.email.clone()),
                acc.and_then(|a| {
                    a.config
                        .fields
                        .get("countryCode")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
                acc.and_then(|a| {
                    a.config
                        .fields
                        .get("authBaseUrl")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| self.core.settings.auth_base_url.clone()),
                acc.and_then(|a| {
                    a.config
                        .fields
                        .get("coreBaseUrl")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_else(|| self.core.settings.core_base_url.clone()),
            )
        };
        Ok(json!({
            "id": account_id,
            "subscription": {"title": "Trae Free/Pro", "type": "unknown"},
            "email": email,
            "countryCode": country,
            "endpoints": {"authBaseUrl": auth_base, "coreBaseUrl": core_base},
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
        }
        self.core.refresh_models(account_id).await;
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
            name: "trae".into(),
            provider_type: "trae".into(),
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
                Some("No Trae accounts configured".into())
            },
            models: if models.is_empty() {
                vec![DEFAULT_TRAE_MODEL.to_string()]
            } else {
                models
            },
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyTraeError` port.
pub fn classify_trae_error(raw: &str) -> ClassifiedError {
    // TraeAuthError kinds are flattened into the message by callers
    let msg = raw.to_lowercase();
    let has = |p: &str| regex::Regex::new(p).unwrap().is_match(&msg);
    if has(
        r#"code["']?:\s*1001|unauthorized|unauthenticated|invalid token|missing token|401|403|auth"#,
    ) {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if has(r"quota|usage limit|insufficient|balance|exceeded") {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 60 * 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"rate limit|too many requests|429|queue|busy|high demand") {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"timeout|idle timeout") {
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

fn trae_settings(settings: &JsonMap) -> TraeSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    TraeSettings {
        auth_base_url: settings
            .get("authBaseUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAE_AUTH_BASE_URL)
            .to_string(),
        core_base_url: settings
            .get("coreBaseUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAE_CORE_BASE_URL)
            .to_string(),
        client_id: settings
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAE_CLIENT_ID)
            .to_string(),
        raw_chat_path: settings
            .get("rawChatPath")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAE_RAW_CHAT_PATH)
            .to_string(),
        local_chat_enabled: settings
            .get("localChatEnabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        local_debug_port: settings
            .get("localDebugPort")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_TRAE_LOCAL_DEBUG_PORT as u64) as u16,
        local_app_path: settings
            .get("localAppPath")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAE_LOCAL_APP_PATH)
            .to_string(),
        model_list_path: settings
            .get("modelListPath")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAE_MODEL_LIST_PATH)
            .to_string(),
        ide_version: settings
            .get("ideVersion")
            .and_then(Value::as_str)
            .unwrap_or("3.5.60")
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 60)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
        expose_unavailable_in_us: settings
            .get("exposeUnavailableInUS")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}
