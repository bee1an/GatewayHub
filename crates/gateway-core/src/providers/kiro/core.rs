//! Upstream internals for `kiro.rs` — CodeWhisperer stream + failover.

use super::*;

impl KiroCore {
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
            provider: Some("kiro".into()),
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

    /// `ensureInitialized` — build the per-account auth manager and seed
    /// fallback models (TS sets modelsCachedAt=now — remote refresh only
    /// happens on explicit listAvailableModels).
    pub(crate) async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<KiroAuth>> {
        if let Some(auth) = self.auths.lock().await.get(account_id) {
            return Ok(auth.clone());
        }
        let Some(config) = ({
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        }) else {
            anyhow::bail!("Account not found: {account_id}");
        };
        {
            let mut pool = self.pool.lock().await;
            if let Some(acc) = pool.find_mut(account_id)
                && acc.state.model_ids.is_empty()
            {
                acc.state.model_ids = FALLBACK_MODELS.iter().map(|s| s.to_string()).collect();
                acc.state.models_cached_at = now_ms();
            }
        }
        let persist = self.persist_account.clone();
        let pool_ref = self.pool.clone();
        let on_change: Arc<dyn Fn(&str, &KiroSnapshot) + Send + Sync> =
            Arc::new(move |acc_id: &str, snap: &KiroSnapshot| {
                if let Ok(mut pool) = pool_ref.try_lock()
                    && let Some(acc) = pool.find_mut(acc_id)
                {
                    apply_snapshot(&mut acc.config, snap);
                    let config = acc.config.clone();
                    if let Some(persist) = &persist {
                        persist(&config);
                    }
                }
            });
        let auth = Arc::new(KiroAuth::new(
            &config,
            &self.settings.region,
            self.settings.api_region.as_deref(),
            self.settings.runtime_base_url.clone(),
            self.http.client(),
            Some(on_change),
        )?);
        self.auths
            .lock()
            .await
            .insert(account_id.to_string(), auth.clone());
        Ok(auth)
    }

    pub(crate) async fn try_ensure_auth(&self, account_id: &str) -> bool {
        match self.ensure_auth(account_id).await {
            Ok(_) => true,
            Err(e) => {
                let message = e.to_string();
                let mut pool = self.pool.lock().await;
                if let Some(acc) = pool.find_mut(account_id) {
                    acc.state.failures += 1;
                    acc.state.last_failure_at = now_ms();
                    acc.state.last_error = Some(message.clone());
                    acc.state.last_response_kind = Some("auth".into());
                    acc.state.status = AccountStatus::AuthFailed;
                    acc.state.status_reason = Some(message.chars().take(200).collect());
                    acc.state.status_updated_at = now_ms();
                }
                false
            }
        }
    }

    /// kiro ordering: model → availability → auth init.
    pub(crate) async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<KiroAuth>)> {
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

    /// `callKiro` — POST {apiHost}/generateAssistantResponse; 403 → force
    /// refresh once; 429/5xx backoff; other 4xx non-retryable.
    pub(crate) async fn call_kiro(
        &self,
        auth: &Arc<KiroAuth>,
        payload: &Value,
    ) -> anyhow::Result<reqwest::Response> {
        let url = format!("{}/generateAssistantResponse", auth.api_host());
        let mut last_error = String::new();
        let max = self.settings.max_retries.max(1);
        for attempt in 0..max {
            let token = auth.get_access_token().await?;
            let mut req = self
                .http
                .client()
                .post(&url)
                .header("connection", "close")
                .json(payload)
                .timeout(self.settings.first_token_timeout);
            for (k, v) in auth.build_headers(&token) {
                req = req.header(k, v);
            }
            match req.send().await {
                Ok(res) => {
                    let status = res.status().as_u16();
                    if status == 403 && attempt == 0 {
                        let _ = auth.force_refresh().await;
                        continue;
                    }
                    if status < 400 {
                        return Ok(res);
                    }
                    let text = res.text().await.unwrap_or_default();
                    last_error = format!(
                        "Kiro HTTP {status}: {}",
                        text.chars().take(1000).collect::<String>()
                    );
                    if status == 429 || status >= 500 {
                        tokio::time::sleep(Duration::from_millis(500 * 2_u64.pow(attempt as u32)))
                            .await;
                        continue;
                    }
                    anyhow::bail!(NonRetryable(last_error));
                }
                Err(e) => {
                    last_error = e.to_string();
                    if attempt + 1 < max {
                        tokio::time::sleep(Duration::from_millis(500 * 2_u64.pow(attempt as u32)))
                            .await;
                    }
                }
            }
        }
        anyhow::bail!(last_error)
    }

    pub(crate) fn build_payload(
        &self,
        format: &'static str,
        body: &Value,
        model: &str,
        profile_arn: &str,
    ) -> anyhow::Result<Value> {
        if format == "openai" {
            build_kiro_payload_from_openai(body, model, profile_arn)
        } else {
            build_kiro_payload_from_anthropic(body, model, profile_arn)
        }
    }

    pub(crate) async fn non_stream(
        &self,
        format: &'static str,
        model: &str,
        kiro_model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        let _permits = self.limiter.acquire(body).await;
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.pool.lock().await.accounts.len().max(1);
        for _ in 0..total {
            let Some((account, auth)) = self.get_account_for_model(kiro_model, &excluded).await
            else {
                break;
            };
            let started = now_ms();
            let profile_arn = auth.profile_arn().await;
            let payload = match self.build_payload(format, body, kiro_model, &profile_arn) {
                Ok(p) => p,
                Err(e) => {
                    last_error = e.to_string();
                    break;
                }
            };
            match self.call_kiro(&auth, &payload).await {
                Ok(res) => {
                    let events = parse_kiro_stream(
                        res,
                        self.settings.first_token_timeout,
                        self.settings.streaming_read_timeout,
                    );
                    let result = if format == "openai" {
                        openai_json_from_kiro(
                            events,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            &account.config.id,
                        )
                        .await
                    } else {
                        anthropic_json_from_kiro(
                            events,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            &account.config.id,
                        )
                        .await
                    };
                    match result {
                        Ok(parsed) => {
                            self.pool.lock().await.report_success(&account.config.id);
                            self.log_entry(
                                LogLevel::Info,
                                "Upstream success",
                                Some(&account),
                                Some(&ctx.request_id),
                                Some(model),
                                Some((now_ms() - started) as u64),
                                None,
                            );
                            return GatewayResponse::json(200, parsed);
                        }
                        Err(e) => {
                            last_error = e.to_string();
                            let classified = classify_kiro_error(&last_error);
                            if classified.kind != ResponseKind::ModelError {
                                self.pool.lock().await.report_failure(
                                    &account.config.id,
                                    &last_error,
                                    &classified,
                                );
                                excluded.insert(account.config.id.clone());
                            }
                            if classified.kind == ResponseKind::ModelError {
                                break;
                            }
                        }
                    }
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
                    let classified = classify_kiro_error(&last_error);
                    if classified.kind != ResponseKind::ModelError {
                        self.pool.lock().await.report_failure(
                            &account.config.id,
                            &last_error,
                            &classified,
                        );
                        excluded.insert(account.config.id.clone());
                    }
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    if classified.kind == ResponseKind::ModelError {
                        break;
                    }
                }
            }
        }
        let message = format!(
            "Kiro request failed: {}",
            if last_error.is_empty() {
                "No available accounts".into()
            } else {
                last_error
            }
        );
        GatewayResponse::error(502, message, "gateway_error")
    }

    pub(crate) fn stream(
        self: &Arc<Self>,
        format: &'static str,
        model: String,
        kiro_model: String,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> impl Stream<Item = String> + Send + 'static {
        let view = self.clone();
        let request_id = ctx.request_id.clone();
        let on_usage = ctx.on_usage.clone();
        let cancel = ctx.cancel.clone();
        async_stream::stream! {
            let _permits = view.limiter.acquire(&body).await;
            let mut excluded = HashSet::new();
            let mut last_error = String::new();
            let total = view.pool.lock().await.accounts.len().max(1);

            'outer: for _ in 0..total {
                let Some((account, auth)) = view.get_account_for_model(&kiro_model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let profile_arn = auth.profile_arn().await;
                let payload = match view.build_payload(format, &body, &kiro_model, &profile_arn) {
                    Ok(p) => p,
                    Err(e) => {
                        last_error = e.to_string();
                        break;
                    }
                };
                let res = match view.call_kiro(&auth, &payload).await {
                    Ok(r) => r,
                    Err(e) => {
                        if cancel.is_cancelled() {
                            break 'outer;
                        }
                        last_error = e.to_string();
                        let classified = classify_kiro_error(&last_error);
                        if classified.kind != ResponseKind::ModelError {
                            view.pool.lock().await.report_failure(
                                &account.config.id,
                                &last_error,
                                &classified,
                            );
                            excluded.insert(account.config.id.clone());
                        }
                        if classified.kind == ResponseKind::ModelError {
                            break 'outer;
                        }
                        continue;
                    }
                };

                let events = parse_kiro_stream(
                    res,
                    view.settings.first_token_timeout,
                    view.settings.streaming_read_timeout,
                );
                let account_id = account.config.id.clone();
                let sink = on_usage.clone();
                let inner: std::pin::Pin<Box<dyn Stream<Item = String> + Send>> = if format == "openai" {
                    Box::pin(openai_sse_from_kiro(events, model.clone(), body.clone(), sink, account_id.clone()))
                } else {
                    Box::pin(anthropic_sse_from_kiro(events, model.clone(), body.clone(), sink, account_id.clone()))
                };
                let mut inner = inner;
                use futures::StreamExt;
                while let Some(frame) = inner.next().await {
                    yield frame;
                }
                view.pool.lock().await.report_success(&account_id);
                view.log_entry(
                    LogLevel::Info,
                    "Upstream stream success",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }

            let message = format!(
                "Kiro stream failed: {}",
                if last_error.is_empty() { "No available accounts".to_string() } else { last_error }
            );
            if format == "openai" {
                yield format!(
                    "data: {}\n\n",
                    serde_json::to_string(&json!({
                        "error": {"message": message, "type": "gateway_error", "code": "kiro_error"},
                    }))
                    .unwrap_or_else(|_| "{}".into())
                );
                yield "data: [DONE]\n\n".to_string();
            } else {
                yield format!(
                    "event: error\ndata: {}\n\n",
                    serde_json::to_string(&json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": message},
                    }))
                    .unwrap_or_else(|_| "{}".into())
                );
            }
        }
    }

    /// Refresh an account's model list from `/ListAvailableModels` unless
    /// the per-account cache is still fresh. Seed rows (fallback ids with
    /// `models_cached_at` set but no remote entry) always trigger a fetch.
    pub(crate) async fn maybe_refresh_models(&self, account_id: &str) {
        {
            let cache = self.models_cache.lock().await;
            if let Some((at, ids)) = cache.get(account_id)
                && now_ms() - *at < MODELS_CACHE_TTL_MS
                && !ids.is_empty()
            {
                return;
            }
        }
        let _ = self.list_available_models(account_id, false).await;
    }

    /// `listAvailableModels` — apiGet('/ListAvailableModels') with 15min cache.
    pub(crate) async fn list_available_models(
        &self,
        account_id: &str,
        force: bool,
    ) -> anyhow::Result<Value> {
        if !force
            && let Some((at, models)) = self.models_cache.lock().await.get(account_id)
            && now_ms() - *at < MODELS_CACHE_TTL_MS
        {
            return Ok(
                json!({ "models": models.iter().map(|m| json!({"modelId": m, "modelName": m})).collect::<Vec<_>>() }),
            );
        }
        let auth = self.ensure_auth(account_id).await?;
        let mut params = vec![("origin", "AI_EDITOR")];
        let arn = auth.profile_arn().await;
        if !arn.is_empty() {
            params.push(("profileArn", &arn));
        }
        // Accounts on the same entitlement (same profileArn) get identical
        // model lists — share one upstream call across them.
        let group = if arn.is_empty() {
            format!("acct:{account_id}")
        } else {
            format!("arn:{arn}")
        };
        let result = self
            .catalog
            .get_or_fetch(&group, if force { 0 } else { MODELS_CACHE_TTL_MS }, || {
                auth.api_get("/ListAvailableModels", &params)
            })
            .await;
        match result {
            Ok(data) => {
                let ids: Vec<String> = data
                    .get("models")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|m| m.get("modelId").and_then(Value::as_str))
                            .map(normalize_kiro_model_id)
                            .collect()
                    })
                    .unwrap_or_default();
                if !ids.is_empty() {
                    self.models_cache
                        .lock()
                        .await
                        .insert(account_id.to_string(), (now_ms(), ids.clone()));
                    let mut pool = self.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.model_ids = ids;
                        acc.state.models_cached_at = now_ms();
                    }
                }
                Ok(data)
            }
            Err(e) => {
                self.log_entry(
                    LogLevel::Warn,
                    format!("listAvailableModels failed for {account_id}: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
                Ok(
                    json!({ "models": FALLBACK_MODELS.iter().map(|m| json!({"modelId": m, "modelName": m})).collect::<Vec<_>>() }),
                )
            }
        }
    }
}

#[derive(Debug)]
pub(crate) struct NonRetryable(String);
impl std::fmt::Display for NonRetryable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for NonRetryable {}

pub(crate) fn apply_snapshot(config: &mut AccountFile, snap: &KiroSnapshot) {
    let fields = &mut config.fields;
    if !snap.access_token.is_empty() {
        fields.insert("accessToken".into(), json!(snap.access_token));
    }
    if !snap.refresh_token.is_empty() {
        fields.insert("refreshToken".into(), json!(snap.refresh_token));
    }
    if snap.expires_at_ms > 0
        && let Some(iso) = chrono::DateTime::from_timestamp_millis(snap.expires_at_ms)
    {
        fields.insert("expiresAt".into(), json!(iso.to_rfc3339()));
    }
    if !snap.profile_arn.is_empty() {
        fields.insert("profileArn".into(), json!(snap.profile_arn));
    }
}
