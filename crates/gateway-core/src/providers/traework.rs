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
    DEFAULT_TRAEWORK_IDE_VERSION, DEFAULT_TRAEWORK_MODEL, DEFAULT_TRAEWORK_PACKAGE_TYPE,
    DEFAULT_TRAEWORK_RAW_CHAT_PATH, DEFAULT_TRAEWORK_VERSION_CODE, TraeWorkAuth,
    TraeWorkHeaderSettings, TraeWorkTokenSnapshot, describe_traework_model,
    normalize_traework_model,
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
        vec![DEFAULT_TRAEWORK_MODEL.to_string()]
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
}

impl TraeWorkProvider {
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

impl TraeWorkCore {
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
            provider: Some("traework".into()),
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

    async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<TraeWorkAuth>> {
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
        let on_change: Arc<dyn Fn(&str, &TraeWorkTokenSnapshot) + Send + Sync> =
            Arc::new(move |acc_id: &str, snap: &TraeWorkTokenSnapshot| {
                if let Ok(mut pool) = pool_ref.try_lock()
                    && let Some(acc) = pool.find_mut(acc_id)
                {
                    let fields = &mut acc.config.fields;
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
                    let config = acc.config.clone();
                    if let Some(persist) = &persist {
                        persist(&config);
                    }
                }
            });
        let auth = Arc::new(TraeWorkAuth::new(
            &config,
            &self.settings.auth_base_url,
            &self.settings.core_base_url,
            &self.settings.client_id,
            &self.settings.detail_param_path,
            self.settings.header.clone(),
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
                    let mut pool = self.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.last_error = Some(e.to_string());
                        acc.state.last_failure_at = now_ms();
                        acc.state.status = AccountStatus::AuthFailed;
                        acc.state.status_reason = Some(e.to_string().chars().take(200).collect());
                        acc.state.status_updated_at = now_ms();
                        acc.state.cooldown_until = None;
                    }
                    false
                }
            },
            Err(e) => {
                let mut pool = self.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.last_error = Some(e.to_string());
                    acc.state.last_failure_at = now_ms();
                    acc.state.status = AccountStatus::AuthFailed;
                    acc.state.status_reason = Some(e.to_string().chars().take(200).collect());
                    acc.state.status_updated_at = now_ms();
                }
                false
            }
        }
    }

    /// traework ordering: availability → model → auth.
    async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<TraeWorkAuth>)> {
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

    async fn refresh_models(&self, account_id: &str) {
        let auth = match self.ensure_auth(account_id).await {
            Ok(a) => a,
            Err(e) => {
                self.log_entry(
                    LogLevel::Warn,
                    format!("TraeWork model list refresh failed: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
                return;
            }
        };
        let config = {
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let models = match config {
            Some(c) => auth.get_model_list(&c).await.unwrap_or_else(|e| {
                self.log_entry(
                    LogLevel::Warn,
                    format!("TraeWork model list refresh failed: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
                Vec::new()
            }),
            None => Vec::new(),
        };
        let usable: Vec<String> = models
            .iter()
            .map(|m| normalize_traework_model(m))
            .filter(|m| !m.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.model_ids = if usable.is_empty() {
                vec![DEFAULT_TRAEWORK_MODEL.to_string()]
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

    /// `checkinAccounts` — returns (claimed, failed); full per-account detail
    /// is exposed through `checkin_result`.
    pub async fn checkin_accounts(&self, account_id: Option<&str>, force: bool) -> (u64, u64) {
        let r = self.checkin_result(account_id, force).await;
        (r.0, r.3)
    }

    /// Full ProviderCheckinResult: (claimed, already, skipped, failed, results, ok).
    pub async fn checkin_result(
        &self,
        account_id: Option<&str>,
        force: bool,
    ) -> (u64, u64, u64, u64, Vec<Value>, bool) {
        let today = cn_day_key(now_ms());
        let ids = {
            let pool = self.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| {
                    if let Some(id) = account_id {
                        a.config.id == id
                    } else {
                        a.config.enabled
                    }
                })
                .map(|a| a.config.id.clone())
                .collect::<Vec<_>>()
        };
        let mut claimed = 0u64;
        let mut already = 0u64;
        let mut skipped = 0u64;
        let mut failed = 0u64;
        let mut results: Vec<Value> = Vec::new();
        let mut ok = true;

        for id in &ids {
            let existing = {
                let pool = self.pool.lock().await;
                pool.find(id).and_then(|a| a.state.checkin.clone())
            };
            if !force
                && existing.as_ref().and_then(|c| c.last_day.as_deref()) == Some(today.as_str())
            {
                skipped += 1;
                results.push(json!({
                    "accountId": id,
                    "ok": true,
                    "checkedIn": true,
                    "credits": existing.and_then(|c| c.last_credits),
                }));
                continue;
            }
            let run = async {
                let auth = self.ensure_auth(id).await?;
                let token = auth.get_jwt_token().await?;
                let account = {
                    let pool = self.pool.lock().await;
                    pool.find(id).map(|a| a.config.clone())
                }
                .ok_or_else(|| anyhow::anyhow!("Account not found"))?;
                let mut status = get_checkin_status(
                    &self.http.client(),
                    &account,
                    &token,
                    &self.settings.auth_base_url,
                )
                .await?;
                let mut did_claim = false;
                if !status.checked_in && status.enable {
                    let _ = claim_checkin(
                        &self.http.client(),
                        &account,
                        &token,
                        &self.settings.auth_base_url,
                    )
                    .await?;
                    did_claim = true;
                    status = get_checkin_status(
                        &self.http.client(),
                        &account,
                        &token,
                        &self.settings.auth_base_url,
                    )
                    .await?;
                }
                Ok::<(crate::providers::traework_checkin::CheckinStatus, bool), anyhow::Error>((
                    status, did_claim,
                ))
            };
            match run.await {
                Ok((status, did_claim)) => {
                    let total = status.credits + status.extra_credits;
                    {
                        let mut pool = self.pool.lock().await;
                        if let Some(acc) = pool.find_mut(id) {
                            acc.state.checkin = Some(CheckinState {
                                last_day: Some(today.clone()),
                                last_at: Some(now_ms()),
                                last_credits: Some(total as f64),
                                last_error: None,
                                extra: Default::default(),
                            });
                        }
                    }
                    if !status.enable {
                        skipped += 1;
                        results.push(json!({
                            "accountId": id,
                            "ok": true,
                            "credits": total,
                            "message": "Check-in not enabled for this account",
                        }));
                    } else {
                        if did_claim {
                            claimed += 1
                        } else {
                            already += 1
                        }
                        results.push(json!({
                            "accountId": id,
                            "ok": true,
                            "checkedIn": status.checked_in,
                            "credits": total,
                        }));
                    }
                    self.log_entry(
                        LogLevel::Info,
                        "TraeWork check-in done",
                        None,
                        None,
                        None,
                        None,
                        Some(json!({"account": id, "claimed": did_claim, "credits": total, "enable": status.enable})),
                    );
                }
                Err(e) => {
                    let message = e.to_string();
                    {
                        let mut pool = self.pool.lock().await;
                        if let Some(acc) = pool.find_mut(id) {
                            let mut state = acc.state.checkin.clone().unwrap_or_default();
                            state.last_at = Some(now_ms());
                            state.last_error = Some(message.chars().take(300).collect());
                            acc.state.checkin = Some(state);
                        }
                    }
                    failed += 1;
                    ok = false;
                    results.push(json!({"accountId": id, "ok": false, "message": message}));
                    self.log_entry(
                        LogLevel::Warn,
                        format!("TraeWork check-in failed: {message}"),
                        None,
                        None,
                        None,
                        None,
                        None,
                    );
                }
            }
        }
        (claimed, already, skipped, failed, results, ok)
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
            let payload = build_traework_chat_payload(model, body, format, &self.settings.function);
            let token = match auth.get_jwt_token().await {
                Ok(t) => t,
                Err(e) => {
                    last_error = e.to_string();
                    excluded.insert(account.config.id.clone());
                    continue;
                }
            };
            let events = {
                let core_base = account
                    .config
                    .fields
                    .get("coreBaseUrl")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| self.settings.core_base_url.clone());
                stream_traework_chat(
                    self.http.client(),
                    core_base,
                    self.settings.raw_chat_path.clone(),
                    auth.header_settings().clone(),
                    Some(account.config.clone()),
                    token,
                    payload,
                    self.settings.first_token_timeout,
                    self.settings.streaming_read_timeout,
                )
            };
            match collect_traework_chat(events).await {
                Ok(result) => {
                    let out = if format == "openai" {
                        openai_json_from_result(
                            &result,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            &account.config.id,
                        )
                    } else {
                        anthropic_json_from_result(
                            &result,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            &account.config.id,
                        )
                    };
                    self.pool.lock().await.report_success(&account.config.id);
                    self.log_entry(
                        LogLevel::Info,
                        "TraeWork upstream success",
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
                    let classified = classify_traework_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.log_entry(
                        LogLevel::Warn,
                        format!("TraeWork upstream failed: {last_error}"),
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
            "TraeWork request failed: {}",
            if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            }
        )
    }

    /// `streamWithFailover` — buffer until first content event so early
    /// upstream errors still rotate accounts.
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
        async_stream::stream! {
            let mut excluded = HashSet::new();
            let mut last_error = String::new();
            let total = view.pool.lock().await.accounts.len().max(1);
            'outer: for attempt in 0..total {
                let Some((account, auth)) = view.get_account_for_model(&model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let payload = build_traework_chat_payload(&model, &body, format, &view.settings.function);
                let token = match auth.get_jwt_token().await {
                    Ok(t) => t,
                    Err(e) => {
                        last_error = e.to_string();
                        excluded.insert(account.config.id.clone());
                        continue;
                    }
                };
                let core_base = account
                    .config
                    .fields
                    .get("coreBaseUrl")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| view.settings.core_base_url.clone());
                let mut events = Box::pin(stream_traework_chat(
                    view.http.client(),
                    core_base,
                    view.settings.raw_chat_path.clone(),
                    auth.header_settings().clone(),
                    Some(account.config.clone()),
                    token,
                    payload,
                    view.settings.first_token_timeout,
                    view.settings.streaming_read_timeout,
                ));
                use futures::StreamExt;
                // buffer until first output/done/error event
                let mut buffered: Vec<TraeWorkStreamEvent> = Vec::new();
                let mut saw_content = false;
                let mut early_error: Option<String> = None;
                while let Some(item) = events.next().await {
                    match item {
                        Ok(ev) => {
                            if ev.event == "error" {
                                early_error = Some(format!(
                                    "TraeWork upstream error {}: {}",
                                    ev.data.get("code").map(|c| c.to_string()).unwrap_or_default(),
                                    ev.data.get("message").and_then(Value::as_str)
                                        .map(str::to_string)
                                        .unwrap_or_else(|| ev.data.to_string())
                                ));
                                break;
                            }
                            buffered.push(ev.clone());
                            if ev.event == "output" || ev.event == "done" {
                                saw_content = true;
                                break;
                            }
                        }
                        Err(e) => {
                            early_error = Some(e.to_string());
                            break;
                        }
                    }
                }
                if let Some(err) = early_error {
                    let classified = classify_traework_error(&err);
                    view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                    excluded.insert(account.config.id.clone());
                    last_error = err;
                    if !matches!(
                        classified.kind,
                        ResponseKind::Timeout | ResponseKind::Network | ResponseKind::ServerError
                    ) {
                        break 'outer;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
                if !saw_content {
                    let err = "TraeWork stream ended without content".to_string();
                    view.pool.lock().await.report_failure(
                        &account.config.id,
                        &err,
                        &ClassifiedError { kind: ResponseKind::ServerError, cooldown_ms: 30_000, reset_at_iso: None },
                    );
                    excluded.insert(account.config.id.clone());
                    last_error = err;
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
                // concat buffered + remaining events
                let buffered_clone = buffered.clone();
                let events = futures::stream::iter(buffered_clone.into_iter().map(Ok)).chain(events);
                let sink = on_usage.clone();
                let account_id = account.config.id.clone();
                let mut inner: std::pin::Pin<Box<dyn Stream<Item = String> + Send>> =
                    if format == "openai" {
                        Box::pin(openai_sse_from_events(events, model.clone(), body.clone(), sink, account_id.clone()))
                    } else {
                        Box::pin(anthropic_sse_from_events(events, model.clone(), body.clone(), sink, account_id.clone()))
                    };
                let mut emitted = false;
                while let Some(frame) = inner.next().await {
                    emitted = true;
                    yield frame;
                }
                let _ = emitted;
                view.pool.lock().await.report_success(&account_id);
                view.log_entry(
                    LogLevel::Info,
                    "TraeWork stream success",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }
            let message = format!(
                "TraeWork stream failed: {}",
                if last_error.is_empty() { "No available accounts".to_string() } else { last_error }
            );
            if format == "openai" {
                yield format!(
                    "data: {}\n\ndata: [DONE]\n\n",
                    serde_json::to_string(&json!({
                        "error": {"message": message, "type": "gateway_error", "code": "traework_error"},
                    }))
                    .unwrap_or_default()
                );
            } else {
                yield format!(
                    "event: error\ndata: {}\n\n",
                    serde_json::to_string(&json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": message},
                    }))
                    .unwrap_or_default()
                );
            }
        }
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
        let mut models = self.core.pool.lock().await.list_models();
        if models.is_empty() {
            models = vec![DEFAULT_TRAEWORK_MODEL.to_string()];
        }
        models
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
        let model = normalize_traework_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAEWORK_MODEL),
        );
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
        let model = normalize_traework_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(DEFAULT_TRAEWORK_MODEL),
        );
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
            models: if models.is_empty() {
                vec![DEFAULT_TRAEWORK_MODEL.to_string()]
            } else {
                models
            },
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
