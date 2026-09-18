//! NVIDIA NIM provider — port of `providers/nvidia/`.
//! Pure-API-key OpenAI-compatible upstream; no token refresh.
//! Retry/SSE/pool plumbing lives in `openai_compat`; this file keeps the
//! nvidia-specific parts: model-catalog filtering, key smoke check,
//! error classification.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::http::{UpstreamHttp, redact_secrets_in_text};
use crate::pool::{AccountPool, DefaultBehavior, now_ms};
use crate::protocol::{
    anthropic_messages_to_openai, openai_completion_to_anthropic, openai_sse_to_anthropic,
};
use crate::provider::ProviderAdapter;
use crate::providers::openai_compat::{BoxFut, CompatRefresh, CompatSettings, CompatView};
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayRequestContext, GatewayResponse, JsonMap, ProviderModel, ProviderStatus, ResponseKind,
};

const NVIDIA_BASE_URL: &str = "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODELS_PATH: &str = "/models";
const NVIDIA_CHAT_PATH: &str = "/chat/completions";
const NVIDIA_SMOKE_MODEL: &str = "meta/llama-3.1-8b-instruct";
const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

pub type NvidiaView = CompatView<NvidiaRefresh>;

pub struct NvidiaProvider {
    view: Arc<NvidiaView>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct NvidiaRefresh;

impl NvidiaProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: crate::types::LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = nvidia_settings(&provider_config.settings);
        let http = UpstreamHttp::new(settings.base_url.clone(), Some(proxy_url))?;

        let mut pool = AccountPool::new(DefaultBehavior("nvidia"));
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
            view: Arc::new(CompatView {
                pool: Arc::new(Mutex::new(pool)),
                http: Arc::new(http),
                settings: Arc::new(settings),
                persist: persist_account,
                log,
                provider: "nvidia",
                classify: classify_nvidia_error,
                refresher: NvidiaRefresh,
                catalog: Arc::new(crate::providers::catalog::SharedCatalog::new()),
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }

    /// `checkApiKey` port — 1-token smoke completion.
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
        if status < 400 && payload.get("error").is_none() {
            return Ok(());
        }
        // The smoke model can be retired upstream (410 Gone "end of life") —
        // a dead smoke model says nothing about the key. Fall back to
        // GET /models, which still requires a valid key.
        let lower = text.to_lowercase();
        if status == 404
            || status == 410
            || (status >= 400
                && (lower.contains("end of life") || lower.contains("no longer available")))
        {
            let res = self
                .view
                .http
                .get(
                    NVIDIA_MODELS_PATH,
                    &[("authorization", &format!("Bearer {api_key}"))],
                    self.view.settings.first_token_timeout,
                )
                .await?;
            let status = res.status().as_u16();
            if status < 400 {
                return Ok(());
            }
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "NVIDIA key check failed: HTTP {} {}",
                status,
                redact_secrets_in_text(&text)
                    .chars()
                    .take(500)
                    .collect::<String>()
            );
        }
        anyhow::bail!(
            "NVIDIA key check failed: HTTP {} {}",
            status,
            redact_secrets_in_text(&text)
                .chars()
                .take(500)
                .collect::<String>()
        );
    }
}

impl CompatRefresh for NvidiaRefresh {
    /// `maybeRefreshAccountModels` — TTL-guarded `/models` fetch.
    fn maybe_refresh<'a>(&'a self, view: &'a NvidiaView, account_id: String) -> BoxFut<'a, ()> {
        Box::pin(async move {
            let (api_key, fresh) = {
                let pool = view.pool.lock().await;
                let Some(acc) = pool.find(&account_id) else {
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
            // The /models catalog is identical for every NVIDIA key — share
            // one fetch across the pool instead of one request per account.
            let res = view
                .catalog
                .get_or_fetch("", MODELS_CACHE_TTL_MS, || async {
                    let r = view
                        .http
                        .get(
                            NVIDIA_MODELS_PATH,
                            &[("authorization", &format!("Bearer {key}"))],
                            Duration::from_secs(30),
                        )
                        .await?;
                    let status = r.status().as_u16();
                    let text = r.text().await.unwrap_or_default();
                    if status >= 400 {
                        anyhow::bail!("NVIDIA model list failed: HTTP {status} {text}");
                    }
                    let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
                    Ok(payload
                        .get("data")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default())
                })
                .await;
            match res {
                Ok(data) => {
                    let mut ids: Vec<String> = data
                        .iter()
                        .filter_map(|m| m.get("id").and_then(Value::as_str))
                        .map(|id| id.trim().to_string())
                        .filter(|id| !id.is_empty() && !is_non_chat_model(id))
                        .collect();
                    ids.sort();
                    ids.dedup();
                    let mut pool = view.pool.lock().await;
                    if let Some(acc) = pool.find_mut(&account_id) {
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
                        if let Some(persist) = &view.persist {
                            persist(&config);
                        }
                    }
                }
                Err(e) => {
                    let classified = classify_nvidia_error(0, &e.to_string());
                    if classified.kind == ResponseKind::Auth {
                        let mut pool = view.pool.lock().await;
                        if let Some(acc) = pool.find_mut(&account_id) {
                            acc.state.status = AccountStatus::AuthFailed;
                            acc.state.status_reason =
                                Some(e.to_string().chars().take(200).collect());
                            acc.state.status_updated_at = now_ms();
                        }
                    }
                    view.log_entry(
                        crate::types::LogLevel::Warn,
                        format!("NVIDIA model refresh failed: {e}"),
                        None,
                        None,
                        None,
                        None,
                        None,
                    );
                }
            }
        })
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for NvidiaProvider {
    fn name(&self) -> &'static str {
        "nvidia"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        self.view
            .list_models_fresh()
            .await
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "nvidia".into(),
                owned_by: Some("nvidia".into()),
                description: None,
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.view.stream_proxy(model, body, ctx)),
            };
        }
        self.view.non_stream_proxy(&model, &body, ctx).await
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let openai_body = anthropic_messages_to_openai(&body, &model);
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            let inner = self.view.stream_proxy(model.clone(), openai_body, ctx);
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(openai_sse_to_anthropic(inner, model)),
            };
        }
        let response = self.view.non_stream_proxy(&model, &openai_body, ctx).await;
        match response {
            GatewayResponse::Json {
                status,
                body: parsed,
            } if status < 400 => GatewayResponse::json(
                status,
                openai_completion_to_anthropic(&parsed, &model, &body),
            ),
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
                NvidiaRefresh
                    .maybe_refresh(&self.view, account_id.to_string())
                    .await;
                let models = {
                    let mut pool = self.view.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = AccountStatus::Available;
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
                    ..Default::default()
                }
            }
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.view.pool.lock().await;
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

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let mut pool = self.view.pool.lock().await;
            if let Some(acc) = pool.find_mut(account_id) {
                acc.state.models_cached_at = 0;
            } else {
                anyhow::bail!("Account not found");
            }
        }
        NvidiaRefresh
            .maybe_refresh(&self.view, account_id.to_string())
            .await;
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
        status: AccountStatus,
        reason: Option<String>,
    ) -> anyhow::Result<()> {
        self.view
            .pool
            .lock()
            .await
            .set_account_status(account_id, status, reason)
    }

    fn status(&self) -> ProviderStatus {
        let (accounts, models) = self
            .view
            .pool
            .try_lock()
            .map(|p| (p.accounts.len(), p.list_models()))
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

fn nvidia_settings(settings: &JsonMap) -> CompatSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    CompatSettings {
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

/// `classifyNvidiaError` port.
pub fn classify_nvidia_error(status: u16, body: &str) -> ClassifiedError {
    let msg = body.to_lowercase();
    let is = |pats: &[&str]| pats.iter().any(|p| msg.contains(p));
    if status == 401
        || status == 403
        || (is(&["http 401", "http 403"])
            || (is(&["invalid"]) && is(&["key"]))
            || is(&["unauthorized"]))
    {
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
