//! OpenRouter provider — port of `providers/openrouter/`.
//! Same OpenAI-compat pipeline as nvidia plus `/key` introspection:
//! free-tier keys are restricted to `:free` catalog models.

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

const OPENROUTER_BASE_URL: &str = "https://openrouter.ai/api/v1";
const OPENROUTER_KEY_PATH: &str = "/key";
const OPENROUTER_MODELS_PATH: &str = "/models";
const OPENROUTER_FREE_ROUTER_MODEL: &str = "openrouter/free";
const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

pub type OpenRouterView = CompatView<OpenRouterRefresh>;

pub struct OpenRouterProvider {
    view: Arc<OpenRouterView>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct OpenRouterRefresh;

impl OpenRouterProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: crate::types::LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = openrouter_settings(&provider_config.settings);
        let http = UpstreamHttp::new(settings.base_url.clone(), Some(proxy_url))?;

        let mut pool = AccountPool::new(DefaultBehavior("openrouter"));
        pool.set_on_changed(on_changed);
        let mut states = provider_state
            .accounts
            .iter()
            .map(|(k, v)| (k.clone(), AccountRuntimeState::from_value(v)))
            .collect();
        pool.reload(account_files, &mut states, provider_state.current_account_index);

        Ok(Self {
            view: Arc::new(CompatView {
                pool: Arc::new(Mutex::new(pool)),
                http: Arc::new(http),
                settings: Arc::new(settings),
                persist: persist_account,
                log,
                provider: "openrouter",
                classify: classify_openrouter_error,
                refresher: OpenRouterRefresh,
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
}

impl CompatRefresh for OpenRouterRefresh {
    /// `maybeRefreshAccountModels` — `/key` + `/models` + free-tier filter.
    fn maybe_refresh<'a>(
        &'a self,
        view: &'a OpenRouterView,
        account_id: &'a str,
    ) -> BoxFut<'a, ()> {
        Box::pin(async move {
            let (api_key, fresh) = {
                let pool = view.pool.lock().await;
                let Some(acc) = pool.find(account_id) else {
                    return;
                };
                let fresh = acc.state.models_cached_at > 0
                    && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
                    && !acc.state.model_ids.is_empty();
                (
                    acc.config.field_str("apiKey").map(str::to_string),
                    fresh,
                )
            };
            if fresh {
                return;
            }
            let Some(key) = api_key else { return };
            match refresh_account_models(view, account_id, &key).await {
                Ok(()) => {}
                Err(e) => {
                    let classified = classify_openrouter_error(0, &e.to_string());
                    if classified.kind == ResponseKind::Auth {
                        let mut pool = view.pool.lock().await;
                        if let Some(acc) = pool.find_mut(account_id) {
                            acc.state.status = AccountStatus::AuthFailed;
                            acc.state.status_reason =
                                Some(e.to_string().chars().take(200).collect());
                            acc.state.status_updated_at = now_ms();
                        }
                    }
                    view.log_entry(
                        crate::types::LogLevel::Warn,
                        format!("OpenRouter model refresh failed: {e}"),
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

/// `refreshAccountModels` port — key info → catalog → filtered ids →
/// persist key metadata back to the account file.
async fn refresh_account_models(
    view: &OpenRouterView,
    account_id: &str,
    api_key: &str,
) -> anyhow::Result<()> {
    let key_info = fetch_key_info(view, api_key).await?;
    let models = fetch_models(view, api_key).await?;
    let filtered = filter_models_for_key(&models, &key_info);

    let mut pool = view.pool.lock().await;
    let Some(acc) = pool.find_mut(account_id) else {
        return Ok(());
    };
    acc.state.model_ids = filtered;
    acc.state.models_cached_at = now_ms();
    apply_key_info(&mut acc.config, &key_info);
    let config = acc.config.clone();
    drop(pool);
    if let Some(persist) = &view.persist {
        persist(&config);
    }
    Ok(())
}

/// `/key` → `{ data: { label, limit, limit_remaining, usage, is_free_tier } }`
async fn fetch_key_info(view: &OpenRouterView, api_key: &str) -> anyhow::Result<Value> {
    let res = view
        .http
        .get(
            OPENROUTER_KEY_PATH,
            &[("authorization", &format!("Bearer {api_key}"))],
            Duration::from_secs(20),
        )
        .await?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status >= 400 || payload.get("error").is_some() {
        anyhow::bail!(
            "OpenRouter key check failed: HTTP {} {}",
            status,
            redact_secrets_in_text(&text).chars().take(500).collect::<String>()
        );
    }
    Ok(payload.get("data").cloned().unwrap_or(Value::Null))
}

async fn fetch_models(view: &OpenRouterView, api_key: &str) -> anyhow::Result<Vec<Value>> {
    let res = view
        .http
        .get(
            OPENROUTER_MODELS_PATH,
            &[("authorization", &format!("Bearer {api_key}"))],
            Duration::from_secs(30),
        )
        .await?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if status >= 400 || payload.get("error").is_some() {
        anyhow::bail!(
            "OpenRouter model list failed: HTTP {} {}",
            status,
            redact_secrets_in_text(&text).chars().take(500).collect::<String>()
        );
    }
    Ok(payload
        .get("data")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

/// `applyKeyInfo` port — write key metadata back onto the config fields.
fn apply_key_info(config: &mut AccountFile, key_info: &Value) {
    if let Some(label) = key_info.get("label").and_then(Value::as_str)
        && !label.is_empty()
    {
        config.fields.insert("keyLabel".into(), json!(label));
    }
    config.fields.insert(
        "isFreeTier".into(),
        json!(key_info.get("is_free_tier").and_then(Value::as_bool) == Some(true)),
    );
    config.fields.insert(
        "limit".into(),
        key_info.get("limit").cloned().unwrap_or(Value::Null),
    );
    config.fields.insert(
        "limitRemaining".into(),
        key_info.get("limit_remaining").cloned().unwrap_or(Value::Null),
    );
    config.fields.insert(
        "usage".into(),
        json!(key_info.get("usage").and_then(Value::as_f64).unwrap_or(0.0)),
    );
    config
        .fields
        .insert("lastKeyInfoAt".into(), json!(now_ms()));
}

/// `filterModelsForKey` port — free-tier keys only see `:free` ids plus the
/// free router alias.
fn filter_models_for_key(models: &[Value], key_info: &Value) -> Vec<String> {
    let is_free_tier = key_info.get("is_free_tier").and_then(Value::as_bool) == Some(true);
    let mut ids: Vec<String> = models
        .iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty() && (!is_free_tier || is_free_model_id(id)))
        .collect();
    if is_free_tier {
        ids.push(OPENROUTER_FREE_ROUTER_MODEL.into());
    }
    ids.sort();
    ids.dedup();
    ids
}

fn is_free_model_id(id: &str) -> bool {
    id.ends_with(":free") || id == OPENROUTER_FREE_ROUTER_MODEL || id == "openrouter/auto:free"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_tier_filters_to_free_models() {
        let models = vec![
            json!({"id": "openai/gpt-5"}),
            json!({"id": "meta/llama-3.1-8b:free"}),
            json!({"id": "qwen/qwen3-32b:free"}),
            json!({"id": "anthropic/claude-opus"}),
        ];
        let free = filter_models_for_key(&models, &json!({"is_free_tier": true}));
        assert_eq!(
            free,
            vec!["meta/llama-3.1-8b:free", "openrouter/free", "qwen/qwen3-32b:free"]
        );
        let paid = filter_models_for_key(&models, &json!({"is_free_tier": false}));
        assert_eq!(paid.len(), 4);
        assert!(!paid.contains(&"openrouter/free".to_string()));
    }

    #[test]
    fn classify_maps_status_and_body() {
        assert_eq!(classify_openrouter_error(401, "").kind, ResponseKind::Auth);
        assert_eq!(
            classify_openrouter_error(200, "insufficient credit").kind,
            ResponseKind::Quota
        );
        assert_eq!(classify_openrouter_error(429, "").kind, ResponseKind::RateLimit);
        assert_eq!(
            classify_openrouter_error(0, "upstream timeout").kind,
            ResponseKind::Timeout
        );
        assert_eq!(
            classify_openrouter_error(503, "boom").kind,
            ResponseKind::ServerError
        );
    }

    #[test]
    fn apply_key_info_writes_fields() {
        let mut file = AccountFile::default();
        apply_key_info(
            &mut file,
            &json!({
                "label": "personal", "is_free_tier": true,
                "limit": 10.0, "limit_remaining": 8.5, "usage": 1.5,
            }),
        );
        assert_eq!(file.fields["keyLabel"], "personal");
        assert_eq!(file.fields["isFreeTier"], true);
        assert_eq!(file.fields["limitRemaining"], 8.5);
        assert!(file.fields["lastKeyInfoAt"].as_i64().unwrap_or(0) > 0);
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for OpenRouterProvider {
    fn name(&self) -> &'static str {
        "openrouter"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        self.view
            .list_models_fresh()
            .await
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "openrouter".into(),
                owned_by: Some("openrouter".into()),
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
            GatewayResponse::Json { status, body: parsed } if status < 400 => {
                GatewayResponse::json(
                    status,
                    openai_completion_to_anthropic(&parsed, &model, &body),
                )
            }
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
        match refresh_account_models(&self.view, account_id, &key).await {
            Ok(()) => {
                let (models, is_free) = {
                    let mut pool = self.view.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_reason = None;
                        acc.state.status_updated_at = now_ms();
                        (
                            acc.state.model_ids.clone(),
                            acc.config
                                .fields
                                .get("isFreeTier")
                                .and_then(Value::as_bool)
                                .unwrap_or(false),
                        )
                    } else {
                        (Vec::new(), false)
                    }
                };
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: format!(
                        "OpenRouter key valid, {} {} model(s) available",
                        models.len(),
                        if is_free { "free-tier" } else { "paid" }
                    ),
                    models: models.into_iter().take(50).collect(),
                    auth_type: Some("openrouter-api-key".into()),
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

    /// `getAccountInfo` port — subscription/tier/models + live `/key` info.
    async fn get_account_info(&self, account_id: &str) -> anyhow::Result<Value> {
        let (api_key, is_free, limit_remaining) = {
            let pool = self.view.pool.lock().await;
            let Some(acc) = pool.find(account_id) else {
                anyhow::bail!("Account not found");
            };
            (
                acc.config.field_str("apiKey").map(str::to_string),
                acc.config
                    .fields
                    .get("isFreeTier")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                acc.config.fields.get("limitRemaining").cloned(),
            )
        };
        OpenRouterRefresh
            .maybe_refresh(&self.view, account_id)
            .await;
        let mut key_info = Value::Null;
        if let Some(key) = &api_key
            && let Ok(info) = fetch_key_info(&self.view, key).await
        {
            key_info = info;
        }
        let models = self
            .view
            .pool
            .lock()
            .await
            .find(account_id)
            .map(|a| a.state.model_ids.clone())
            .unwrap_or_default();
        Ok(json!({
            "subscription": {
                "title": "OpenRouter",
                "type": key_info.get("label").and_then(Value::as_str).unwrap_or("api-key"),
            },
            "keyInfo": key_info,
            "tier": if is_free { "free" } else { "paid" },
            "limitRemaining": limit_remaining,
            "models": models.iter().take(100).map(|m| json!({
                "modelId": m, "modelName": m, "rateMultiplier": 1, "rateUnit": "request",
            })).collect::<Vec<_>>(),
        }))
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
        OpenRouterRefresh
            .maybe_refresh(&self.view, account_id)
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
            name: "openrouter".into(),
            provider_type: "openrouter".into(),
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
                Some("No OpenRouter keys configured".into())
            },
            models,
            use_proxy: None,
            accounts,
        }
    }
}

fn openrouter_settings(settings: &JsonMap) -> CompatSettings {
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
            .unwrap_or(OPENROUTER_BASE_URL)
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 120)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 300)),
        max_retries: settings
            .get("maxRetries")
            .and_then(Value::as_u64)
            .unwrap_or(2) as usize,
    }
}

/// `classifyOpenRouterError` port.
pub fn classify_openrouter_error(status: u16, body: &str) -> ClassifiedError {
    let msg = body.to_lowercase();
    let is = |pats: &[&str]| pats.iter().any(|p| msg.contains(p));
    if status == 401
        || status == 403
        || is(&["http 401", "http 403", "unauthorized"])
        || (is(&["invalid"]) && is(&["key"]))
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
