//! WorkBuddy provider — port of `providers/workbuddy/provider.ts`.
//! Upstream already speaks OpenAI chat-completions; requests are forced to
//! stream:true and SSE is relayed verbatim. Anthropic path adapts through
//! the shared protocol converters.

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
use crate::providers::workbuddy_auth::{
    DEFAULT_WORKBUDDY_BACKEND, DEFAULT_WORKBUDDY_MODEL, WORKBUDDY_BUILT_IN_MODELS,
    WORKBUDDY_CHAT_PATH, WorkBuddyAuth, WorkBuddyTokenSnapshot, build_workbuddy_headers,
    load_workbuddy_product_models, normalize_workbuddy_model,
};
use crate::providers::workbuddy_checkin::{
    claim_checkin, cn_day_key, get_checkin_status, get_credits_usage,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, CheckinState,
    ClassifiedError, GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel,
    LogSink, ProviderModel, ProviderStatus, ResponseKind, UsageMeta, UsageStats,
};

mod upstream;
use upstream::*;

const MODELS_CACHE_TTL_MS: i64 = 6 * 60 * 60_000;
const CHECKIN_INTERVAL: Duration = Duration::from_secs(60 * 60);
const CHECKIN_STARTUP_DELAY: Duration = Duration::from_secs(25);

#[derive(Debug, Clone)]
struct WorkBuddySettings {
    backend: String,
    billing_hosts: Vec<String>,
    product_json_path: String,
    auto_checkin: bool,
    max_retries: u32,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
}

struct WorkBuddyBehavior;
impl crate::pool::PoolBehavior for WorkBuddyBehavior {
    fn provider_name(&self) -> &'static str {
        "workbuddy"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_workbuddy_model(model)
    }
    fn account_has_model(&self, _account: &AccountWithState, _model: &str) -> bool {
        true
    }
    fn seed_models(&self) -> Vec<String> {
        WORKBUDDY_BUILT_IN_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }
}

pub struct WorkBuddyProvider {
    core: Arc<WorkBuddyCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct WorkBuddyCore {
    pool: Arc<Mutex<AccountPool<WorkBuddyBehavior>>>,
    auths: Mutex<HashMap<String, Arc<WorkBuddyAuth>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<WorkBuddySettings>,
    persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
}

impl WorkBuddyProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = workbuddy_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.backend, Some(proxy_url))?;

        let mut pool = AccountPool::new(WorkBuddyBehavior);
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
        // product.json catalog re-scanned on reload
        for acc in &mut pool.accounts {
            acc.state.models_cached_at = 0;
            acc.state.model_ids = Vec::new();
        }

        let core = Arc::new(WorkBuddyCore {
            pool: Arc::new(Mutex::new(pool)),
            auths: Mutex::new(HashMap::new()),
            http: Arc::new(http),
            settings: Arc::new(settings),
            persist_account,
            log,
        });

        if provider_config.enabled && core.settings.auto_checkin {
            let view = core.clone();
            tokio::spawn(async move {
                tokio::time::sleep(CHECKIN_STARTUP_DELAY).await;
                loop {
                    let (claimed, _, _, failed, _, _) = view.checkin_result(None, false).await;
                    if claimed > 0 || failed > 0 {
                        view.log_entry(
                            LogLevel::Info,
                            format!("WorkBuddy daily check-in: {claimed} claimed, {failed} failed"),
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
impl ProviderAdapter for WorkBuddyProvider {
    fn name(&self) -> &'static str {
        "workbuddy"
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
                id,
                provider: "workbuddy".into(),
                owned_by: Some("workbuddy".into()),
                description: Some("Model via WorkBuddy provider".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_workbuddy_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_WORKBUDDY_MODEL),
        );
        let upstream_body = prepare_upstream_body(&body);
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(model, upstream_body, ctx)),
            };
        }
        self.core.non_stream(&model, &upstream_body, ctx).await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_workbuddy_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_WORKBUDDY_MODEL),
        );
        let openai_body = prepare_upstream_body(&anthropic_messages_to_openai(&body, &model));
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
        // cheap probe: 1-token streaming chat
        let probe = async {
            let token = auth.get_access_token().await?;
            let account = {
                let pool = self.core.pool.lock().await;
                pool.find(account_id).map(|a| a.config.clone())
            }
            .ok_or_else(|| anyhow::anyhow!("Account not found"))?;
            let url = format!(
                "{}{}",
                self.core.settings.backend.trim_end_matches('/'),
                WORKBUDDY_CHAT_PATH
            );
            let mut req = self
                .core
                .http
                .client()
                .post(&url)
                .timeout(Duration::from_secs(20))
                .json(&json!({
                    "model": "auto",
                    "messages": [{"role":"user","content":"hi"}],
                    "max_tokens": 1,
                    "stream": true,
                }));
            for (k, v) in build_workbuddy_headers(&account, &token) {
                req = req.header(k, v);
            }
            let res = req.send().await?;
            let status = res.status().as_u16();
            if status >= 400 {
                let text = res.text().await.unwrap_or_default();
                anyhow::bail!(
                    "WorkBuddy probe failed: HTTP {} {}",
                    status,
                    text.chars().take(300).collect::<String>()
                );
            }
            Ok::<(), anyhow::Error>(())
        };
        match probe.await {
            Ok(()) => {
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_updated_at = now_ms();
                        acc.state.cooldown_until = None;
                    }
                }
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
                    message: "WorkBuddy account is valid".into(),
                    models,
                    expires_at: auth.expires_at_iso().await,
                    auth_type: Some(auth.auth_type().await.into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                self.core.mark_auth_failed(account_id, &message).await;
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
        let (credits, checkin_info) = async {
            let auth = self.core.ensure_auth(account_id).await.ok()?;
            let token = auth.get_access_token().await.ok()?;
            let account = {
                let pool = self.core.pool.lock().await;
                pool.find(account_id).map(|a| a.config.clone())
            }?;
            let mut credits = get_credits_usage(
                &self.core.http.client(),
                &account,
                &token,
                &self.core.settings.backend,
                &self.core.settings.billing_hosts,
            )
            .await
            .ok()
            .flatten();
            let status = get_checkin_status(
                &self.core.http.client(),
                &account,
                &token,
                &self.core.settings.backend,
                &self.core.settings.billing_hosts,
            )
            .await
            .ok();
            if credits.is_none() {
                credits = status.as_ref().and_then(|s| s.total_credits);
            }
            let info = status.map(|s| {
                json!({
                    "checkedIn": s.checked_in,
                    "active": s.active,
                    "streakDays": s.streak_days,
                })
            });
            Some((credits, info))
        }
        .await
        .unwrap_or((None, None));
        let (models, email, nickname, uid, domain) = {
            let pool = self.core.pool.lock().await;
            let acc = pool.find(account_id);
            (
                acc.map(|a| a.state.model_ids.clone()).unwrap_or_default(),
                acc.and_then(|a| a.config.email.clone()),
                acc.and_then(|a| {
                    a.config
                        .fields
                        .get("nickname")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
                acc.and_then(|a| {
                    a.config
                        .fields
                        .get("uid")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
                acc.and_then(|a| {
                    a.config
                        .fields
                        .get("domain")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                }),
            )
        };
        Ok(json!({
            "id": account_id,
            "subscription": {"title": "WorkBuddy", "type": "unknown"},
            "email": email,
            "nickname": nickname,
            "uid": uid,
            "domain": domain,
            "creditsRemaining": credits,
            "checkin": checkin_info,
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
            name: "workbuddy".into(),
            provider_type: "workbuddy".into(),
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
                Some("No WorkBuddy accounts configured".into())
            },
            models,
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyWorkBuddyError` port.
pub fn classify_workbuddy_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |p: &str| regex::Regex::new(p).unwrap().is_match(&msg);
    if has(r"unauthorized|unauthenticated|invalid token|missing token|\b401\b|\b403\b|auth") {
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
    if has(r"rate limit|too many requests|\b429\b|busy|high demand") {
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

fn workbuddy_settings(settings: &JsonMap) -> WorkBuddySettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    WorkBuddySettings {
        backend: settings
            .get("backend")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_WORKBUDDY_BACKEND)
            .to_string(),
        billing_hosts: settings
            .get("billingHosts")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_else(|| {
                crate::providers::workbuddy_auth::DEFAULT_WORKBUDDY_BILLING_HOSTS
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            }),
        product_json_path: settings
            .get("productJsonPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        auto_checkin: settings
            .get("autoCheckin")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        max_retries: settings
            .get("maxRetries")
            .and_then(Value::as_u64)
            .unwrap_or(2) as u32,
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 60)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
    }
}
