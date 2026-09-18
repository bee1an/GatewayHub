//! Codex provider — port of `providers/codex/` (GptWeb OAuth + the
//! `/codex/responses` Responses-API upstream). Unlike nvidia/openrouter
//! the upstream always streams; "non-stream" calls collect the stream.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::provider::ProviderAdapter;
use crate::providers::codex_auth::{AuthSnapshot, CodexAuth};
use crate::providers::codex_convert::{anthropic_to_responses_payload, chat_to_responses_payload};
use crate::providers::codex_stream::{
    anthropic_json_from_codex, anthropic_sse_from_codex, openai_json_from_codex,
    openai_sse_from_codex, parse_codex_stream,
};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind,
};

mod core;

const CODEX_BASE_URL: &str = "https://chatgpt.com/backend-api";
const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;
const MODELS_REFRESH_BACKOFF_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone)]
struct CodexSettings {
    base_url: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
    max_retries: usize,
    refresh_skew_seconds: u64,
}

/// `normalizeCodexModel` — strip `provider/` prefix + `-YYYY-MM-DD` tail.
pub fn normalize_codex_model(model: &str) -> String {
    let trimmed = model.trim().to_lowercase();
    let no_prefix = trimmed.split('/').next_back().unwrap_or("");
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"-\d{4}-\d{2}-\d{2}$").unwrap())
        .replace(no_prefix, "")
        .to_string()
}

fn responses_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/backend-api") {
        format!("{base}/codex/responses")
    } else {
        format!("{base}/api/codex/responses")
    }
}

fn models_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/backend-api") {
        format!("{base}/codex/models")
    } else {
        format!("{base}/codex/models")
    }
}

fn usage_url(base: &str) -> String {
    let base = base.trim_end_matches('/');
    if base.ends_with("/backend-api") {
        format!("{base}/wham/usage")
    } else {
        format!("{base}/api/wham/usage")
    }
}

struct CodexBehavior;

impl crate::pool::PoolBehavior for CodexBehavior {
    fn provider_name(&self) -> &'static str {
        "codex"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_codex_model(model)
    }
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        account
            .state
            .model_ids
            .iter()
            .any(|m| normalize_codex_model(m) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        Vec::new()
    }
    /// codex `resolveCooldown` — quota honors the upstream resetAtIso
    /// deadline; cooling base is `max(1000, cooldownMs || 30_000)`.
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
                let base = classified.cooldown_ms.max(30_000).max(1_000);
                let multiplier = 2_i64
                    .pow(account.state.failures.saturating_sub(1).min(6) as u32)
                    .min(64);
                (AccountStatus::Cooling, Some(now + base * multiplier))
            }
        }
    }
}

/// Shared provider state — everything the failover streams need is in an
/// `Arc` so the lazy stream can outlive the `&self` adapter call.
pub struct CodexCore {
    pool: Arc<Mutex<AccountPool<CodexBehavior>>>,
    /// Per-account OAuth managers, built lazily on first use.
    auths: Mutex<HashMap<String, Arc<CodexAuth>>>,
    /// Serializes per-account `/codex/models` fetches + failure backoff.
    model_refresh: Mutex<HashMap<String, i64>>, // account_id → last_failed_ms
    http: Arc<UpstreamHttp>,
    settings: Arc<CodexSettings>,
    persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
    log: LogSink,
}

pub struct CodexProvider {
    core: Arc<CodexCore>,
    enabled: bool,
    display_name: Option<String>,
}

impl CodexProvider {
    /// Model for a request — explicit `model` wins; otherwise the first
    /// fetched id (catalog always comes from the upstream model list).
    async fn resolve_model(&self, body: &Value) -> Option<String> {
        if let Some(m) = body
            .get("model")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Some(normalize_codex_model(m));
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
        let settings = codex_settings(&provider_config.settings);
        let http = UpstreamHttp::new(settings.base_url.clone(), Some(proxy_url))?;

        let mut pool = AccountPool::new(CodexBehavior);
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
            core: Arc::new(CodexCore {
                pool: Arc::new(Mutex::new(pool)),
                auths: Mutex::new(HashMap::new()),
                model_refresh: Mutex::new(HashMap::new()),
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
impl ProviderAdapter for CodexProvider {
    fn name(&self) -> &'static str {
        "codex"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        // trigger background refresh for all enabled accounts
        let core = &self.core;
        let ids: Vec<String> = {
            let pool = core.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| a.config.enabled)
                .map(|a| a.config.id.clone())
                .collect()
        };
        for id in ids {
            core.maybe_refresh_models(&id).await;
        }
        let models = {
            let pool = core.pool.lock().await;
            pool.list_models()
        };
        models
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "codex".into(),
                owned_by: Some("codex".into()),
                description: Some("Model via Codex (GptWeb) provider".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let Some(model) = self.resolve_model(&body).await else {
            return GatewayResponse::error(
                400,
                "Codex has no fetched models; refresh the account model list first",
                "invalid_request_error",
            );
        };
        let stream = body.get("stream").and_then(Value::as_bool) != Some(false);
        if stream {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("openai", model, body, ctx)),
            };
        }
        self.core.non_stream("openai", &model, &body, ctx).await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let Some(model) = self.resolve_model(&body).await else {
            return GatewayResponse::error(
                400,
                "Codex has no fetched models; refresh the account model list first",
                "invalid_request_error",
            );
        };
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream("anthropic", model, body, ctx)),
            };
        }
        self.core.non_stream("anthropic", &model, &body, ctx).await
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
            Ok(_token) => {
                // force a fresh model fetch, clear failure backoff
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.models_cached_at = 0;
                    }
                }
                self.core.model_refresh.lock().await.remove(account_id);
                self.core.maybe_refresh_models(account_id).await;
                let (models, expires) = {
                    let pool = self.core.pool.lock().await;
                    (
                        pool.find(account_id)
                            .map(|a| a.state.model_ids.clone())
                            .unwrap_or_default(),
                        auth.expires_at_iso().await,
                    )
                };
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: "Codex account is valid".into(),
                    models,
                    auth_type: Some(auth.auth_type().into()),
                    expires_at: expires,
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
        let rate_limits = self.core.fetch_rate_limits(&auth).await.ok();
        Ok(json!({
            "id": config.id,
            "email": config.email,
            "name": config.fields.get("name"),
            "gptWebAccountId": config.fields.get("gptWebAccountId"),
            "subscriptionActiveUntil": config.fields.get("subscriptionActiveUntil"),
            "expiresAt": config.fields.get("expiresAt"),
            "lastRefresh": config.fields.get("lastRefresh"),
            "rateLimits": rate_limits,
        }))
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let mut pool = self.core.pool.lock().await;
            if pool.find_mut(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
            if let Some(acc) = pool.find_mut(account_id) {
                acc.state.models_cached_at = 0;
            }
        }
        self.core.model_refresh.lock().await.remove(account_id);
        self.core.maybe_refresh_models(account_id).await;
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
            name: "codex".into(),
            provider_type: "codex".into(),
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
                Some("No Codex accounts configured".into())
            },
            models,
            use_proxy: None,
            accounts,
        }
    }
}

/// `classifyCodexError` port.
pub fn classify_codex_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let status = regex::Regex::new(r"codex http (\d{3})")
        .unwrap()
        .captures(&msg)
        .and_then(|c| c[1].parse::<u16>().ok())
        .unwrap_or(0);
    if msg.contains("refresh token")
        || msg.contains("access token")
        || msg.contains("gptweb-account-id")
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
        if msg.contains("quota") || msg.contains("usage limit") || msg.contains("exceeded") {
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

fn codex_settings(settings: &JsonMap) -> CodexSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    CodexSettings {
        base_url: settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .unwrap_or(CODEX_BASE_URL)
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 30)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 600)),
        max_retries: settings
            .get("maxRetries")
            .and_then(Value::as_u64)
            .unwrap_or(2) as usize,
        refresh_skew_seconds: secs("refreshSkewSeconds", 60),
    }
}
