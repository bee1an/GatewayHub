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

impl WorkBuddyCore {
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
            provider: Some("workbuddy".into()),
            account_id: account.map(|a| {
                a.config
                    .label
                    .clone()
                    .or_else(|| a.config.email.clone())
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

    async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<WorkBuddyAuth>> {
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
        let on_change: Arc<dyn Fn(&str, &WorkBuddyTokenSnapshot) + Send + Sync> =
            Arc::new(move |acc_id: &str, snap: &WorkBuddyTokenSnapshot| {
                if let Ok(mut pool) = pool_ref.try_lock()
                    && let Some(acc) = pool.find_mut(acc_id)
                {
                    let fields = &mut acc.config.fields;
                    if !snap.access_token.is_empty() {
                        fields.insert("accessToken".into(), json!(snap.access_token));
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
                    if !snap.domain.is_empty() {
                        fields.insert("domain".into(), json!(snap.domain));
                    }
                    let config = acc.config.clone();
                    if let Some(persist) = &persist {
                        persist(&config);
                    }
                }
            });
        let auth = Arc::new(WorkBuddyAuth::new(
            &config,
            &self.settings.backend,
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
            Ok(auth) => match auth.get_access_token().await {
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

    /// workbuddy ordering: availability → auth (all accounts serve all models).
    async fn get_account_for_model(
        &self,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<WorkBuddyAuth>)> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
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

    /// `refreshAccountModels` — catalog is the bundled cli/product.json.
    async fn refresh_models(&self, account_id: &str) {
        let models = {
            let path = self.settings.product_json_path.clone();
            tokio::task::spawn_blocking(move || load_workbuddy_product_models(&path))
                .await
                .unwrap_or_default()
        };
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.model_ids = if models.is_empty() {
                WORKBUDDY_BUILT_IN_MODELS
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            } else {
                let mut m = models;
                m.sort();
                m
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

    /// `fetchUpstream` — POST /v2/chat/completions.
    async fn fetch_upstream(
        &self,
        account: &AccountWithState,
        auth: &Arc<WorkBuddyAuth>,
        body: &Value,
    ) -> anyhow::Result<reqwest::Response> {
        let token = auth.get_access_token().await?;
        let url = format!(
            "{}{}",
            self.settings.backend.trim_end_matches('/'),
            WORKBUDDY_CHAT_PATH
        );
        let timeout = self.settings.first_token_timeout + self.settings.streaming_read_timeout;
        let mut req = self.http.client().post(&url).timeout(timeout).json(body);
        for (k, v) in build_workbuddy_headers(&account.config, &token) {
            req = req.header(k, v);
        }
        Ok(req.send().await?)
    }

    fn report_usage(
        &self,
        parsed: &Value,
        model: &str,
        account_id: &str,
        ctx: &GatewayRequestContext,
    ) {
        let Some(sink) = &ctx.on_usage else { return };
        let Some(u) = parsed.get("usage") else { return };
        sink(
            UsageStats {
                input_tokens: u.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                output_tokens: u
                    .get("completion_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                ..Default::default()
            },
            UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("workbuddy".into()),
            },
        );
    }

    /// `nonStreamProxy` — collect SSE into one chat.completion.
    async fn non_stream(
        &self,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.pool.lock().await.accounts.len().max(1);
        let attempts = (total as u32).clamp(1, self.settings.max_retries + 1);
        for attempt in 0..attempts {
            let Some((account, auth)) = self.get_account_for_model(&excluded).await else {
                break;
            };
            let started = now_ms();
            match self.fetch_upstream(&account, &auth, body).await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status >= 400 {
                        let err_body = res.text().await.unwrap_or_default();
                        let err =
                            format!("HTTP {status}: {}", &err_body[..err_body.len().min(500)]);
                        let classified = classify_workbuddy_error(&err);
                        self.pool.lock().await.report_failure(
                            &account.config.id,
                            &err,
                            &classified,
                        );
                        excluded.insert(account.config.id.clone());
                        last_error = err;
                        if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                        continue;
                    }
                    let collected = collect_sse_chat(res).await;
                    self.report_usage(&collected, model, &account.config.id, ctx);
                    self.pool.lock().await.report_success(&account.config.id);
                    self.log_entry(
                        LogLevel::Info,
                        "WorkBuddy upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    return GatewayResponse::json(200, collected);
                }
                Err(e) => {
                    if ctx.cancel.is_cancelled() {
                        return GatewayResponse::error(
                            499,
                            "Client aborted request",
                            "client_aborted",
                        );
                    }
                    last_error = e.to_string();
                    let classified = classify_workbuddy_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.log_entry(
                        LogLevel::Warn,
                        format!("WorkBuddy upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                }
            }
        }
        GatewayResponse::error(
            502,
            format!(
                "{}",
                if last_error.is_empty() {
                    "No available WorkBuddy accounts".to_string()
                } else {
                    last_error
                }
            ),
            "gateway_error",
        )
    }

    /// `streamProxy` — relay SSE verbatim; buffer until first parseable data
    /// frame so early upstream errors can fail over.
    fn stream(
        self: &Arc<Self>,
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
            let attempts = (total as u32).clamp(1, view.settings.max_retries + 1);
            'outer: for attempt in 0..attempts {
                let Some((account, auth)) = view.get_account_for_model(&excluded).await else {
                    break;
                };
                let started = now_ms();
                let res = match view.fetch_upstream(&account, &auth, &body).await {
                    Ok(r) => r,
                    Err(e) => {
                        if cancel.is_cancelled() {
                            return;
                        }
                        last_error = e.to_string();
                        let classified = classify_workbuddy_error(&last_error);
                        view.pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                        excluded.insert(account.config.id.clone());
                        if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                        continue;
                    }
                };
                let status = res.status().as_u16();
                if status >= 400 {
                    let err_body = res.text().await.unwrap_or_default();
                    let err = format!("HTTP {status}: {}", &err_body[..err_body.len().min(500)]);
                    let classified = classify_workbuddy_error(&err);
                    view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                    excluded.insert(account.config.id.clone());
                    last_error = err;
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                    continue;
                }
                use futures::StreamExt;
                let mut byte_stream = res.bytes_stream();
                let mut buffered = String::new();
                let mut saw_data = false;
                let mut usage_chunk: Option<Value> = None;
                let mut stream_failed: Option<String> = None;
                loop {
                    if cancel.is_cancelled() {
                        return;
                    }
                    let item = tokio::time::timeout(
                        view.settings.streaming_read_timeout,
                        byte_stream.next(),
                    )
                    .await;
                    match item {
                        Ok(Some(Ok(bytes))) => {
                            let text = String::from_utf8_lossy(&bytes).to_string();
                            if !saw_data {
                                buffered.push_str(&text);
                                if buffered.contains("data:") && buffered.contains('\n') {
                                    saw_data = true;
                                    yield std::mem::take(&mut buffered);
                                }
                            } else {
                                yield text.clone();
                            }
                            if let Some(u) = extract_usage_chunk(&text) {
                                usage_chunk = Some(u);
                            }
                        }
                        Ok(Some(Err(e))) => {
                            if !saw_data {
                                stream_failed = Some(e.to_string());
                            } else {
                                yield format!(
                                    "data: {}\n\ndata: [DONE]\n\n",
                                    serde_json::to_string(&json!({
                                        "error": {"message": e.to_string(), "type": "upstream_error"},
                                    }))
                                    .unwrap_or_default()
                                );
                            }
                            break;
                        }
                        Ok(None) => break,
                        Err(_) => {
                            if !saw_data {
                                stream_failed = Some("WorkBuddy stream read timeout".into());
                            } else {
                                yield format!(
                                    "data: {}\n\ndata: [DONE]\n\n",
                                    serde_json::to_string(&json!({
                                        "error": {"message": "WorkBuddy stream read timeout", "type": "timeout"},
                                    }))
                                    .unwrap_or_default()
                                );
                            }
                            break;
                        }
                    }
                }
                if !buffered.is_empty() && !saw_data {
                    // nothing parseable arrived — treat as failure
                    stream_failed = stream_failed.or(Some("WorkBuddy stream ended without data".into()));
                }
                if !buffered.is_empty() && saw_data {
                    yield std::mem::take(&mut buffered);
                }
                if let Some(err) = stream_failed {
                    let classified = classify_workbuddy_error(&err);
                    view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                    excluded.insert(account.config.id.clone());
                    last_error = err;
                    if matches!(classified.kind, ResponseKind::Auth | ResponseKind::Quota) {
                        break 'outer;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                    continue;
                }
                if !saw_data {
                    let err = "WorkBuddy stream ended without data".to_string();
                    view.pool.lock().await.report_failure(
                        &account.config.id,
                        &err,
                        &ClassifiedError { kind: ResponseKind::ServerError, cooldown_ms: 30_000, reset_at_iso: None },
                    );
                    excluded.insert(account.config.id.clone());
                    last_error = err;
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                    continue;
                }
                if let Some(chunk) = &usage_chunk
                    && let Some(sink) = &on_usage
                {
                    let u = chunk.get("usage").cloned().unwrap_or(Value::Null);
                    sink(
                        UsageStats {
                            input_tokens: u.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
                            output_tokens: u.get("completion_tokens").and_then(Value::as_u64).unwrap_or(0),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some("workbuddy".into()),
                        },
                    );
                }
                view.pool.lock().await.report_success(&account.config.id);
                view.log_entry(
                    LogLevel::Info,
                    "WorkBuddy stream success",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }
            let message = format!(
                "WorkBuddy stream failed: {}",
                if last_error.is_empty() { "No available accounts".to_string() } else { last_error }
            );
            yield format!(
                "data: {}\n\ndata: [DONE]\n\n",
                serde_json::to_string(&json!({
                    "error": {"message": message, "type": "gateway_error", "code": "workbuddy_error"},
                }))
                .unwrap_or_default()
            );
        }
    }

    /// `checkinAccounts` — (claimed, already, skipped, failed, results, ok).
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
                let token = auth.get_access_token().await?;
                let account = {
                    let pool = self.pool.lock().await;
                    pool.find(id).map(|a| a.config.clone())
                }
                .ok_or_else(|| anyhow::anyhow!("Account not found"))?;
                let status = get_checkin_status(
                    &self.http.client(),
                    &account,
                    &token,
                    &self.settings.backend,
                    &self.settings.billing_hosts,
                )
                .await?;
                if !status.checked_in && status.active {
                    let _ = claim_checkin(
                        &self.http.client(),
                        &account,
                        &token,
                        &self.settings.backend,
                        &self.settings.billing_hosts,
                    )
                    .await?;
                }
                let final_status = if status.checked_in {
                    status.clone()
                } else {
                    get_checkin_status(
                        &self.http.client(),
                        &account,
                        &token,
                        &self.settings.backend,
                        &self.settings.billing_hosts,
                    )
                    .await?
                };
                Ok::<WorkBuddyStatusRun, anyhow::Error>(WorkBuddyStatusRun {
                    status,
                    final_status,
                })
            };
            match run.await {
                Ok(run) => {
                    let total = run.final_status.total_credits;
                    {
                        let mut pool = self.pool.lock().await;
                        if let Some(acc) = pool.find_mut(id) {
                            acc.state.checkin = Some(CheckinState {
                                last_day: Some(today.clone()),
                                last_at: Some(now_ms()),
                                last_credits: total.map(|t| t as f64),
                                last_error: None,
                                extra: Default::default(),
                            });
                        }
                    }
                    if !run.status.active {
                        skipped += 1;
                        results.push(json!({
                            "accountId": id,
                            "ok": true,
                            "message": "Check-in activity not active for this account",
                        }));
                    } else {
                        if run.status.checked_in {
                            already += 1
                        } else {
                            claimed += 1
                        }
                        results.push(json!({
                            "accountId": id,
                            "ok": true,
                            "checkedIn": run.final_status.checked_in,
                            "credits": total,
                        }));
                    }
                    self.log_entry(
                        LogLevel::Info,
                        "WorkBuddy check-in done",
                        None,
                        None,
                        None,
                        None,
                        Some(json!({
                            "account": id,
                            "checkedIn": run.final_status.checked_in,
                            "active": run.status.active,
                            "credits": total,
                            "streakDays": run.final_status.streak_days,
                        })),
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
                        format!("WorkBuddy check-in failed: {message}"),
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
}

struct WorkBuddyStatusRun {
    status: crate::providers::workbuddy_checkin::WorkBuddyCheckinStatus,
    final_status: crate::providers::workbuddy_checkin::WorkBuddyCheckinStatus,
}
impl
    From<(
        crate::providers::workbuddy_checkin::WorkBuddyCheckinStatus,
        crate::providers::workbuddy_checkin::WorkBuddyCheckinStatus,
    )> for WorkBuddyStatusRun
{
    fn from(
        v: (
            crate::providers::workbuddy_checkin::WorkBuddyCheckinStatus,
            crate::providers::workbuddy_checkin::WorkBuddyCheckinStatus,
        ),
    ) -> Self {
        Self {
            status: v.0,
            final_status: v.1,
        }
    }
}

/// `prepareUpstreamBody` — force stream:true, developer→system, default
/// stream_options.
fn prepare_upstream_body(body: &Value) -> Value {
    let mut out = body.clone();
    out["stream"] = json!(true);
    if let Some(messages) = out.get("messages").and_then(Value::as_array).cloned() {
        out["messages"] = Value::Array(
            messages
                .into_iter()
                .map(|m| {
                    if m.get("role").and_then(Value::as_str) == Some("developer") {
                        let mut m = m;
                        m["role"] = json!("system");
                        m
                    } else {
                        m
                    }
                })
                .collect(),
        );
    }
    if out.get("stream_options").is_none() {
        out["stream_options"] = json!({ "include_usage": true });
    }
    out
}

/// `collectSseChat` — fold SSE into one chat.completion.
async fn collect_sse_chat(res: reqwest::Response) -> Value {
    let text = res.text().await.unwrap_or_default();
    let mut message = json!({"role": "assistant", "content": ""});
    let mut model = String::new();
    let mut id = String::new();
    let mut created = 0u64;
    let mut usage: Option<Value> = None;
    let mut finish_reason: Option<String> = None;
    let mut tool_calls: HashMap<u64, Value> = HashMap::new();
    for line in text.split('\n') {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        let data = data.trim();
        if data == "[DONE]" {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else {
            continue;
        };
        if let Some(v) = chunk.get("id").and_then(Value::as_str) {
            id = v.to_string();
        }
        if let Some(v) = chunk.get("model").and_then(Value::as_str) {
            model = v.to_string();
        }
        if let Some(v) = chunk.get("created").and_then(Value::as_u64) {
            created = v;
        }
        if chunk.get("usage").is_some() {
            usage = chunk.get("usage").cloned();
        }
        let Some(choice) = chunk.get("choices").and_then(|c| c.get(0)) else {
            continue;
        };
        let delta = choice.get("delta").cloned().unwrap_or(json!({}));
        if let Some(content) = delta.get("content").and_then(Value::as_str) {
            let cur = message["content"].as_str().unwrap_or("").to_string();
            message["content"] = json!(cur + content);
        }
        if let Some(rc) = delta.get("reasoning_content").and_then(Value::as_str) {
            let cur = message["reasoning_content"]
                .as_str()
                .unwrap_or("")
                .to_string();
            message["reasoning_content"] = json!(cur + rc);
        }
        for tc in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let idx = tc.get("index").and_then(Value::as_u64).unwrap_or(0);
            let mut existing = tool_calls.get(&idx).cloned().unwrap_or_else(|| {
                json!({
                    "id": tc.get("id"),
                    "type": "function",
                    "function": {"name": "", "arguments": ""},
                })
            });
            if let Some(id_v) = tc.get("id") {
                existing["id"] = id_v.clone();
            }
            if let Some(name) = tc.pointer("/function/name").and_then(Value::as_str) {
                let cur = existing
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                existing["function"]["name"] = json!(cur + name);
            }
            if let Some(args) = tc.pointer("/function/arguments").and_then(Value::as_str) {
                let cur = existing
                    .pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                existing["function"]["arguments"] = json!(cur + args);
            }
            tool_calls.insert(idx, existing);
        }
        if let Some(fr) = choice.get("finish_reason").and_then(Value::as_str) {
            finish_reason = Some(fr.to_string());
        }
    }
    if !tool_calls.is_empty() {
        let mut calls: Vec<Value> = tool_calls.into_values().collect();
        // restore index ordering by sorting on original index is lost; keep
        // insertion-sorted (HashMap iteration is unordered — sort by index key)
        calls.sort_by_key(|c| c.get("index").and_then(Value::as_u64).unwrap_or(0));
        message["tool_calls"] = Value::Array(calls);
    }
    json!({
        "id": if id.is_empty() { "chatcmpl-workbuddy".into() } else { id },
        "object": "chat.completion",
        "created": if created > 0 { created } else { crate::responses_api::now_secs() as u64 },
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": finish_reason.unwrap_or_else(|| "stop".into()),
        }],
        "usage": usage.unwrap_or_else(|| json!({"prompt_tokens":0,"completion_tokens":0,"total_tokens":0})),
    })
}

/// `extractUsageChunk` — find a data frame carrying usage.
fn extract_usage_chunk(text: &str) -> Option<Value> {
    for line in text.split('\n') {
        if line.starts_with("data: ")
            && line.contains("\"usage\"")
            && let Ok(parsed) = serde_json::from_str::<Value>(&line[6..])
            && parsed.get("usage").is_some()
        {
            return Some(parsed);
        }
    }
    None
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
