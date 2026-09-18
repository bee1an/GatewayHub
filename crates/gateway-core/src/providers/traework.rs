//! TraeWork provider — port of `providers/traework/provider.ts` +
//! `accountPool.ts` + the hourly check-in scheduler. Chat streams through
//! llm_utils_chat directly (real streaming, not collect-then-emit).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::provider::ProviderAdapter;
use crate::providers::traework_auth::{
    DEFAULT_TRAEWORK_APP_ID, DEFAULT_TRAEWORK_AUTH_BASE_URL, DEFAULT_TRAEWORK_CLIENT_ID,
    DEFAULT_TRAEWORK_CORE_BASE_URL, DEFAULT_TRAEWORK_DETAIL_PARAM_PATH, DEFAULT_TRAEWORK_FUNCTION,
    DEFAULT_TRAEWORK_IDE_VERSION, DEFAULT_TRAEWORK_PACKAGE_TYPE, DEFAULT_TRAEWORK_RAW_CHAT_PATH,
    DEFAULT_TRAEWORK_VERSION_CODE, TraeWorkAuth, TraeWorkHeaderSettings, TraeWorkTokenSnapshot,
    describe_traework_model, normalize_traework_model,
};
use crate::providers::traework_chat::{
    TraeWorkStreamEvent, anthropic_json_from_result, anthropic_sse_from_events,
    build_traework_chat_payload, collect_traework_chat, openai_json_from_result,
    openai_sse_from_events, stream_traework_chat,
};
use crate::providers::traework_checkin::{
    claim_checkin, cn_day_key, get_checkin_status, get_credits_usage,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, CheckinState,
    ClassifiedError, GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel,
    LogSink, ProviderModel, ProviderStatus, ResponseKind,
};

mod core;

const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;
const CHECKIN_INTERVAL: Duration = Duration::from_secs(60 * 60);
const CHECKIN_STARTUP_DELAY: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
struct TraeWorkSettings {
    core_base_url: String,
    auth_base_url: String,
    client_id: String,
    raw_chat_path: String,
    detail_param_path: String,
    function: String,
    auto_checkin: bool,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
    header: TraeWorkHeaderSettings,
}

struct TraeWorkBehavior;
impl crate::pool::PoolBehavior for TraeWorkBehavior {
    fn provider_name(&self) -> &'static str {
        "traework"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_traework_model(model)
    }
    /// Empty model list → accept everything (fresh models loaded lazily).
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        if account.state.model_ids.is_empty() {
            return true;
        }
        account
            .state
            .model_ids
            .iter()
            .any(|m| normalize_traework_model(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        Vec::new()
    }
}

pub struct TraeWorkProvider {
    core: Arc<TraeWorkCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct TraeWorkCore {
    pool: Arc<Mutex<AccountPool<TraeWorkBehavior>>>,
    auths: Mutex<HashMap<String, Arc<TraeWorkAuth>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<TraeWorkSettings>,
    persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
    /// Shared `batch_get_detail_param` catalog — identical for every
    /// account on the same client/app id, fetched once per TTL.
    catalog: crate::providers::catalog::SharedCatalog<Vec<String>>,
}

impl TraeWorkProvider {
    /// Model for a request — explicit `model` wins; otherwise the first
    /// fetched id (catalog always comes from `batch_get_detail_param`).
    async fn resolve_model(&self, body: &Value) -> Option<String> {
        if let Some(m) = body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(normalize_traework_model(m));
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
        let settings = traework_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.core_base_url, Some(proxy_url))?;

        let mut pool = AccountPool::new(TraeWorkBehavior);
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

        let core = Arc::new(TraeWorkCore {
            pool: Arc::new(Mutex::new(pool)),
            auths: Mutex::new(HashMap::new()),
            http: Arc::new(http),
            settings: Arc::new(settings),
            persist_account,
            log,
        });

        // hourly self-rescheduling check-in sweep
        if provider_config.enabled && core.settings.auto_checkin {
            let view = core.clone();
            tokio::spawn(async move {
                tokio::time::sleep(CHECKIN_STARTUP_DELAY).await;
                loop {
                    let result = view.checkin_accounts(None, false).await;
                    if result.0 > 0 || result.1 > 0 {
                        view.log_entry(
                            LogLevel::Info,
                            format!(
                                "TraeWork daily check-in: {} claimed, {} failed",
                                result.0, result.1
                            ),
                            None,
                            None,
                            None,
                            None,
                            None,
                        );
                    }
                    tokio::time::sleep(CHECKIN_INTERVAL).await;
                }
            });
        }

        Ok(Self {
            core,
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for TraeWorkProvider {
    fn name(&self) -> &'static str {
        "traework"
    }

    async fn checkin_accounts(
        &self,
        account_id: Option<&str>,
        force: bool,
    ) -> anyhow::Result<Value> {
        let (claimed, already, skipped, failed, results, ok) =
            self.core.checkin_result(account_id, force).await;
        Ok(json!({
            "ok": ok,
            "claimed": claimed,
            "alreadyCheckedIn": already,
            "skipped": skipped,
            "failed": failed,
            "results": results,
        }))
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
                description: describe_traework_model(&id)
                    .map(|d| format!("TraeWork {d}"))
                    .or_else(|| Some("Model via TraeWork provider".into())),
                id,
                provider: "traework".into(),
                owned_by: Some("traework".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let Some(model) = self.resolve_model(&body).await else {
            return GatewayResponse::error(
                400,
                "TraeWork has no fetched models; refresh the account model list first",
                "invalid_request_error",
            );
        };
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("openai", model, body, ctx)),
            };
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
                "TraeWork has no fetched models; refresh the account model list first",
                "invalid_request_error",
            );
        };
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("anthropic", model, body, ctx)),
            };
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
                            acc.config.fields.insert(field.into(), json!(v));
                        }
                    }
                    if let Some(persist) = &persist {
                        persist(&acc.config);
                    }
                    acc.state.status = AccountStatus::Available;
                    acc.state.status_updated_at = now_ms();
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
                    message: "TraeWork account is valid".into(),
                    models,
                    expires_at: auth.expires_at_iso().await,
                    auth_type: Some(auth.auth_type().await.into()),
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
        self.core.maybe_refresh_models(account_id).await;
        let credits = async {
            let auth = self.core.ensure_auth(account_id).await.ok()?;
            let token = auth.get_jwt_token().await.ok()?;
            let account = {
                let pool = self.core.pool.lock().await;
                pool.find(account_id).map(|a| a.config.clone())
            }?;
            get_credits_usage(
                &self.core.http.client(),
                &account,
                &token,
                &self.core.settings.auth_base_url,
            )
            .await
            .ok()
            .flatten()
        }
        .await;
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
            "subscription": {"title": "TraeWork", "type": "unknown"},
            "email": email,
            "countryCode": country,
            "creditsRemaining": credits,
            "endpoints": {"authBaseUrl": auth_base, "coreBaseUrl": core_base},
            "models": models.iter().map(|m| json!({
                "modelId": m,
                "modelName": describe_traework_model(m).unwrap_or(m),
                "rateMultiplier": 1,
                "rateUnit": "request",
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
            name: "traework".into(),
            provider_type: "traework".into(),
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
                Some("No TraeWork accounts configured".into())
            },
            models,
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyTraeWorkError` port — same table as trae.
pub fn classify_traework_error(raw: &str) -> ClassifiedError {
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

fn traework_settings(settings: &JsonMap) -> TraeWorkSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    TraeWorkSettings {
        core_base_url: settings
            .get("coreBaseUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAEWORK_CORE_BASE_URL)
            .to_string(),
        auth_base_url: settings
            .get("authBaseUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAEWORK_AUTH_BASE_URL)
            .to_string(),
        client_id: settings
            .get("clientId")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAEWORK_CLIENT_ID)
            .to_string(),
        raw_chat_path: settings
            .get("rawChatPath")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAEWORK_RAW_CHAT_PATH)
            .to_string(),
        detail_param_path: settings
            .get("detailParamPath")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAEWORK_DETAIL_PARAM_PATH)
            .to_string(),
        function: settings
            .get("function")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_TRAEWORK_FUNCTION)
            .to_string(),
        auto_checkin: settings
            .get("autoCheckin")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 60)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
        header: TraeWorkHeaderSettings {
            app_id: settings
                .get("appId")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAEWORK_APP_ID)
                .to_string(),
            ide_version: settings
                .get("ideVersion")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAEWORK_IDE_VERSION)
                .to_string(),
            version_code: settings
                .get("versionCode")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAEWORK_VERSION_CODE)
                .to_string(),
            package_type: settings
                .get("packageType")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAEWORK_PACKAGE_TYPE)
                .to_string(),
        },
    }
}
