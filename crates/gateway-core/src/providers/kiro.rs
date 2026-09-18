//! Kiro provider — port of `providers/kiro/` (CodeWhisperer streaming
//! runtime + kiro_desktop / aws_sso_oidc auth). Upstream is a JSON-fragment
//! stream, not SSE; "non-stream" calls collect it into one JSON.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};
use tokio::sync::{Mutex, Semaphore};

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::provider::ProviderAdapter;
use crate::providers::kiro_auth::{KiroAuth, KiroAuthType, KiroSnapshot};
use crate::providers::kiro_convert::{
    anthropic_input_tokens, build_kiro_payload_from_anthropic, build_kiro_payload_from_openai,
    normalize_kiro_model_id,
};
use crate::providers::kiro_stream::{
    anthropic_json_from_kiro, anthropic_sse_from_kiro, openai_json_from_kiro, openai_sse_from_kiro,
    parse_kiro_stream,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind,
};

mod core;

const DEFAULT_KIRO_MODEL: &str = "auto";
const FALLBACK_MODELS: &[&str] = &[
    "auto",
    "claude-opus-4.7",
    "claude-opus-4.6",
    "claude-sonnet-4.6",
    "claude-opus-4.5",
    "claude-sonnet-4.5",
    "claude-sonnet-4",
    "claude-haiku-4.5",
    "deepseek-3.2",
    "minimax-m2.5",
    "minimax-m2.1",
    "glm-5",
    "qwen3-coder-next",
];
const MODELS_CACHE_TTL_MS: i64 = 15 * 60_000;

#[derive(Debug, Clone)]
struct KiroSettings {
    region: String,
    api_region: Option<String>,
    /// Test hook — overrides the runtime host template entirely
    /// (`runtime.{region}.kiro.dev` is a fixed AWS domain).
    runtime_base_url: Option<String>,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
    max_retries: usize,
    max_concurrent_requests: usize,
    max_concurrent_large: usize,
    large_prompt_bytes: usize,
    probabilistic_retry_chance: f64,
    account_max_backoff_multiplier: u64,
}

struct KiroBehavior {
    retry_chance: f64,
    max_backoff_multiplier: u64,
}

impl crate::pool::PoolBehavior for KiroBehavior {
    fn provider_name(&self) -> &'static str {
        "kiro"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_kiro_model_id(model)
    }
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        let list: Vec<String> = if account.state.model_ids.is_empty() {
            FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
        } else {
            account.state.model_ids.clone()
        };
        list.iter().any(|m| normalize_kiro_model_id(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
    }
    fn retry_chance(&self) -> f64 {
        self.retry_chance
    }
    /// kiro `resolveCooldown` — quota honors resetAtIso; cooling base
    /// `max(1000, cooldownMs)` with a configurable cap
    /// (`accountMaxBackoffMultiplier`).
    fn resolve_cooldown(
        &self,
        account: &AccountWithState,
        classified: &ClassifiedError,
        now: i64,
    ) -> (AccountStatus, Option<i64>) {
        match classified.kind {
            ResponseKind::Auth => (AccountStatus::AuthFailed, None),
            ResponseKind::Quota => {
                let until = classified
                    .reset_at_iso
                    .as_deref()
                    .and_then(|iso| chrono::DateTime::parse_from_rfc3339(iso).ok())
                    .map(|d| d.timestamp_millis())
                    .unwrap_or(now + classified.cooldown_ms);
                (AccountStatus::QuotaExceeded, Some(until))
            }
            ResponseKind::RateLimit => (
                AccountStatus::RateLimited,
                Some(now + classified.cooldown_ms),
            ),
            _ => {
                let base = classified.cooldown_ms.max(1_000);
                let multiplier = 2_i64
                    .pow(account.state.failures.saturating_sub(1).min(20) as u32)
                    .min(self.max_backoff_multiplier as i64);
                (AccountStatus::Cooling, Some(now + base * multiplier))
            }
        }
    }
}

/// `KiroRequestLimiter` — global concurrency cap + a tighter cap for
/// large prompts (body bytes > threshold).
struct KiroRequestLimiter {
    slots: Semaphore,
    large_slots: Semaphore,
    large_prompt_bytes: usize,
}

impl KiroRequestLimiter {
    fn new(settings: &KiroSettings) -> Self {
        Self {
            slots: Semaphore::new(settings.max_concurrent_requests),
            large_slots: Semaphore::new(settings.max_concurrent_large),
            large_prompt_bytes: settings.large_prompt_bytes,
        }
    }

    /// Acquires permits; returned guard releases on drop.
    async fn acquire(
        &self,
        body: &Value,
    ) -> (
        tokio::sync::SemaphorePermit<'_>,
        Option<tokio::sync::SemaphorePermit<'_>>,
    ) {
        let is_large =
            serde_json::to_string(body).map(|s| s.len()).unwrap_or(0) > self.large_prompt_bytes;
        // large requests hold both slots (TS limiter semantics)
        let normal = if is_large {
            Some(self.slots.acquire().await.expect("slots closed"))
        } else {
            Some(self.slots.acquire().await.expect("slots closed"))
        };
        let large = if is_large {
            Some(self.large_slots.acquire().await.expect("slots closed"))
        } else {
            None
        };
        (normal.unwrap(), large)
    }
}

pub struct KiroProvider {
    core: Arc<KiroCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct KiroCore {
    pool: Arc<Mutex<AccountPool<KiroBehavior>>>,
    auths: Mutex<HashMap<String, Arc<KiroAuth>>>,
    models_cache: Mutex<HashMap<String, (i64, Vec<String>)>>, // account → (cached_at, modelIds)
    /// Shared `/ListAvailableModels` catalog keyed by profileArn —
    /// accounts on the same entitlement get identical model lists.
    catalog: crate::providers::catalog::SharedCatalog<Value>,
    limiter: KiroRequestLimiter,
    http: Arc<UpstreamHttp>,
    settings: Arc<KiroSettings>,
    persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
}

impl KiroProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = kiro_settings(&provider_config.settings);
        let http = UpstreamHttp::new("https://runtime.local", Some(proxy_url))?;

        let mut pool = AccountPool::new(KiroBehavior {
            retry_chance: settings.probabilistic_retry_chance,
            max_backoff_multiplier: settings.account_max_backoff_multiplier,
        });
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
            core: Arc::new(KiroCore {
                pool: Arc::new(Mutex::new(pool)),
                auths: Mutex::new(HashMap::new()),
                models_cache: Mutex::new(HashMap::new()),
                catalog: crate::providers::catalog::SharedCatalog::new(),
                limiter: KiroRequestLimiter::new(&settings),
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

#[async_trait::async_trait]
impl ProviderAdapter for KiroProvider {
    fn name(&self) -> &'static str {
        "kiro"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        let ids: Vec<String> = {
            let pool = self.core.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| a.config.enabled)
                .map(|a| a.config.id.clone())
                .collect()
        };
        for id in ids {
            self.core.maybe_refresh_models(&id).await;
        }
        let models = {
            let pool = self.core.pool.lock().await;
            let set = pool.list_models();
            if set.is_empty() {
                FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
            } else {
                set
            }
        };
        models
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "kiro".into(),
                owned_by: Some("kiro".into()),
                description: Some("Model via Kiro GatewayHub provider".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_kiro_model_id(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_KIRO_MODEL),
        );
        let stream = body.get("stream").and_then(Value::as_bool) != Some(false);
        if stream {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(
                    "openai",
                    model.clone(),
                    model,
                    body,
                    ctx,
                )),
            };
        }
        self.core
            .non_stream("openai", &model, &model, &body, ctx)
            .await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_kiro_model_id(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_KIRO_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(
                    "anthropic",
                    model.clone(),
                    model,
                    body,
                    ctx,
                )),
            };
        }
        self.core
            .non_stream("anthropic", &model, &model, &body, ctx)
            .await
    }

    async fn count_tokens(
        &self,
        body: Value,
        _ctx: &GatewayRequestContext,
    ) -> Option<GatewayResponse> {
        Some(GatewayResponse::json(
            200,
            json!({ "input_tokens": anthropic_input_tokens(&body) }),
        ))
    }

    async fn test_account(&self, account_id: &str) -> AccountTestResult {
        let auth = match self.core.ensure_auth(account_id).await {
            Ok(a) => a,
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.core.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.last_error = Some(message.clone());
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
                    acc.state.status = AccountStatus::AuthFailed;
                    acc.state.status_reason = Some(message.chars().take(200).collect());
                    acc.state.status_updated_at = now_ms();
                }
                return AccountTestResult {
                    ok: false,
                    account_id: account_id.into(),
                    message,
                    ..Default::default()
                };
            }
        };
        match auth.get_access_token().await {
            Ok(_) => {
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
                    message: "Account token is valid".into(),
                    models,
                    auth_type: Some(
                        match auth.auth_type().await {
                            KiroAuthType::KiroDesktop => "kiro_desktop",
                            KiroAuthType::AwsSsoOidc => "aws_sso_oidc",
                        }
                        .into(),
                    ),
                    expires_at: auth.expires_at_iso().await,
                }
            }
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.core.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.last_error = Some(message.clone());
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
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
        let config = {
            let pool = self.core.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let Some(config) = config else {
            anyhow::bail!("Account not found");
        };
        let auth = self.core.ensure_auth(account_id).await?;

        // getUsageLimits + listAvailableModels in parallel (TS Promise.allSettled)
        let usage_fut = async {
            let arn = auth.profile_arn().await;
            if arn.is_empty() {
                return Err(anyhow::anyhow!(
                    "profileArn is not available for this account"
                ));
            }
            auth.api_get(
                "/getUsageLimits",
                &[
                    ("profileArn", arn.as_str()),
                    ("origin", "AI_EDITOR"),
                    ("resourceType", "AGENTIC_REQUEST"),
                    ("isEmailRequired", "true"),
                ],
            )
            .await
        };
        let models_fut = self.core.list_available_models(account_id, false);
        let (usage, models) = tokio::join!(usage_fut, models_fut);
        let usage = usage.ok();
        let models = models.ok();
        if usage.is_none() && models.is_none() {
            anyhow::bail!("Both API calls failed");
        }
        let breakdown = usage
            .as_ref()
            .and_then(|u| u.get("usageBreakdownList"))
            .and_then(Value::as_array)
            .and_then(|a| a.first().cloned());
        Ok(json!({
            "subscription": usage.as_ref().and_then(|u| u.get("subscriptionInfo")).cloned()
                .unwrap_or_else(|| json!({"title": "Unknown", "type": "unknown"})),
            "email": usage.as_ref().and_then(|u| u.pointer("/userInfo/email")).cloned()
                .or_else(|| config.email.clone().map(Value::String)),
            "usage": {
                "used": breakdown.as_ref().and_then(|b| b.get("currentUsage")).cloned().unwrap_or(json!(0)),
                "limit": breakdown.as_ref().and_then(|b| b.get("usageLimit")).cloned().unwrap_or(json!(0)),
                "overages": breakdown.as_ref().and_then(|b| b.get("currentOverages")).cloned().unwrap_or(json!(0)),
                "overageCap": breakdown.as_ref().and_then(|b| b.get("overageCap")).cloned().unwrap_or(json!(0)),
                "overageRate": breakdown.as_ref().and_then(|b| b.get("overageRate")).cloned().unwrap_or(json!(0)),
                "overageCharges": breakdown.as_ref().and_then(|b| b.get("overageCharges")).cloned().unwrap_or(json!(0)),
                "resetDate": usage.as_ref().and_then(|u| u.get("nextDateReset")).cloned().unwrap_or(json!("")),
            },
            "models": models.and_then(|m| m.get("models").cloned()).unwrap_or(json!([])),
        }))
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let pool = self.core.pool.lock().await;
            if pool.find(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
        }
        self.core.list_available_models(account_id, true).await?;
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
            name: "kiro".into(),
            provider_type: "kiro".into(),
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
                Some("No Kiro accounts configured".into())
            },
            models: if models.is_empty() {
                FALLBACK_MODELS.iter().map(|s| s.to_string()).collect()
            } else {
                models
            },
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyKiroError` port.
pub fn classify_kiro_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let status = regex::Regex::new(r"kiro http (\d{3})")
        .unwrap()
        .captures(&msg)
        .and_then(|c| c[1].parse::<u16>().ok())
        .unwrap_or(0);
    if msg.contains("refresh token is missing")
        || msg.contains("access token expired")
        || msg.contains("access token is invalid")
        || msg.contains("please add a new access token")
        || msg.contains("token refresh failed")
        || msg.contains("failed to obtain kiro access token")
    {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if status == 401 || status == 403 {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if status == 429 {
        if regex::Regex::new(r"monthly|quota|usage limit|overage cap|monthly limit|throttling")
            .unwrap()
            .is_match(&msg)
        {
            return ClassifiedError {
                kind: ResponseKind::Quota,
                cooldown_ms: 60 * 60_000,
                reset_at_iso: None,
            };
        }
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if status == 400
        && (msg.contains("invalid_model_id")
            || msg.contains("invalid model id")
            || msg.contains("select a different model"))
    {
        return ClassifiedError {
            kind: ResponseKind::ModelError,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if (500..600).contains(&status) {
        return ClassifiedError {
            kind: ResponseKind::ServerError,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    if msg.contains("first token timeout") || msg.contains("timeout") {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    if msg.contains("fetch failed")
        || msg.contains("econnrefused")
        || msg.contains("econnreset")
        || msg.contains("enotfound")
        || msg.contains("network")
    {
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

fn kiro_settings(settings: &JsonMap) -> KiroSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    let int = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    KiroSettings {
        region: settings
            .get("region")
            .and_then(Value::as_str)
            .unwrap_or("us-east-1")
            .to_string(),
        api_region: settings
            .get("apiRegion")
            .and_then(Value::as_str)
            .map(str::to_string),
        runtime_base_url: settings
            .get("runtimeBaseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 60)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 300)),
        max_retries: int("maxRetries", 3) as usize,
        max_concurrent_requests: int("maxConcurrentRequests", 4) as usize,
        max_concurrent_large: int("maxConcurrentLargePromptRequests", 1) as usize,
        large_prompt_bytes: int("largePromptBytes", 300_000) as usize,
        probabilistic_retry_chance: settings
            .get("probabilisticRetryChance")
            .and_then(Value::as_f64)
            .unwrap_or(0.1)
            .clamp(0.0, 1.0),
        account_max_backoff_multiplier: int("accountMaxBackoffMultiplier", 1440),
    }
}
