//! Trae provider — port of `providers/trae/provider.ts`. Chat goes through
//! the llm_raw_chat HTTP endpoint; "stream" collects then re-emits SSE.
//! (The former CDP-injected local bridge was removed — CDP is rejected.)

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
    DEFAULT_TRAE_MODEL_LIST_PATH, DEFAULT_TRAE_RAW_CHAT_PATH, TraeAuth, TraeTokenSnapshot,
    normalize_trae_model,
};
use crate::providers::trae_rawchat::{
    anthropic_sse_from_text, build_trae_raw_chat_payload, openai_sse_from_text, run_trae_raw_chat,
};
use crate::providers::windsurf_stream::{
    anthropic_json_from_text as anthropic_json, openai_json_from_text as openai_json,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind,
};

mod core;

const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

#[derive(Debug, Clone)]
struct TraeSettings {
    auth_base_url: String,
    core_base_url: String,
    client_id: String,
    raw_chat_path: String,
    model_list_path: String,
    ide_version: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
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
        Vec::new()
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
    /// Shared `get_detail_param` catalog — identical for every account
    /// on the same client, fetched once per TTL.
    catalog: crate::providers::catalog::SharedCatalog<Vec<String>>,
}

impl TraeProvider {
    /// Model for a request — explicit `model` wins; otherwise the first
    /// fetched id (catalog always comes from `get_detail_param`).
    async fn resolve_model(&self, body: &Value) -> Option<String> {
        if let Some(m) = body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(normalize_trae_model(m));
        }
        self.core.pool.lock().await.list_models().into_iter().next()
    }

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
                catalog: crate::providers::catalog::SharedCatalog::new(),
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
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
        self.core
            .pool
            .lock()
            .await
            .list_models()
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
        let Some(model) = self.resolve_model(&body).await else {
            return GatewayResponse::error(
                400,
                "Trae has no fetched models; refresh the account model list first",
                "invalid_request_error",
            );
        };
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
        let Some(model) = self.resolve_model(&body).await else {
            return GatewayResponse::error(
                400,
                "Trae has no fetched models; refresh the account model list first",
                "invalid_request_error",
            );
        };
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
                            && acc.config.fields.get(field).and_then(Value::as_str) != Some(v)
                        {
                            acc.config.fields.insert(field.into(), json!(v));
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
            models,
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyTraeError` port.
pub fn classify_trae_error(raw: &str) -> ClassifiedError {
    // TraeAuthError kinds are flattened into the message by callers
    let msg = raw.to_lowercase();
    let has = |p: &str| {
        regex::Regex::new(p)
            .expect("validated invariant")
            .is_match(&msg)
    };
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
    }
}
