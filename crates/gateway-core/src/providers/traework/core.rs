//! Upstream internals for `traework.rs` — core request/auth/stream logic.

use super::*;

impl TraeWorkCore {
    pub(crate) fn log_entry(
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

    pub(crate) async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<TraeWorkAuth>> {
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

    pub(crate) async fn try_ensure_auth(&self, account_id: &str) -> bool {
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
    pub(crate) async fn get_account_for_model(
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

    pub(crate) async fn refresh_models(&self, account_id: &str) {
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

    pub(crate) async fn maybe_refresh_models(&self, account_id: &str) {
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

    pub(crate) async fn non_stream(
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
            let payload = build_traework_chat_payload(
                model,
                body,
                format,
                &self.settings.function,
                &self.settings.header,
            );
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
    pub(crate) fn stream(
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
                let payload = build_traework_chat_payload(
                    &model,
                    &body,
                    format,
                    &view.settings.function,
                    &view.settings.header,
                );
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
                    view.log_entry(
                        LogLevel::Warn,
                        format!("TraeWork stream failed: {last_error}"),
                        Some(&account),
                        Some(&request_id),
                        Some(&model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
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
                    view.log_entry(
                        LogLevel::Warn,
                        format!("TraeWork stream failed: {last_error}"),
                        Some(&account),
                        Some(&request_id),
                        Some(&model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"attempt": attempt + 1})),
                    );
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
            view.log_entry(
                LogLevel::Error,
                &message,
                None,
                Some(&request_id),
                Some(&model),
                None,
                None,
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
