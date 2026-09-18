//! Upstream internals for `trae.rs` — core request/auth/raw-chat logic.

use super::*;

impl TraeCore {
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
            provider: Some("trae".into()),
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

    /// `ensureAuth` — eagerly construct per-account auth (sync init in TS
    /// reload); lazily here on first access.
    pub(crate) async fn ensure_auth(&self, account_id: &str) -> anyhow::Result<Arc<TraeAuth>> {
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
        let on_change: Arc<dyn Fn(&str, &TraeTokenSnapshot) + Send + Sync> =
            Arc::new(move |acc_id: &str, snap: &TraeTokenSnapshot| {
                if let Ok(mut pool) = pool_ref.try_lock()
                    && let Some(acc) = pool.find_mut(acc_id)
                {
                    apply_token_snapshot(&mut acc.config, snap);
                    let config = acc.config.clone();
                    if let Some(persist) = &persist {
                        persist(&config);
                    }
                }
            });
        let auth = Arc::new(TraeAuth::new(
            &config,
            &self.settings.auth_base_url,
            &self.settings.core_base_url,
            &self.settings.client_id,
            &self.settings.ide_version,
            &self.settings.model_list_path,
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

    pub(crate) async fn mark_auth_failed(&self, account_id: &str, message: &str) {
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

    /// trae ordering: availability → model → auth.
    pub(crate) async fn get_account_for_model(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<(AccountWithState, Arc<TraeAuth>)> {
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

    /// `refreshAccountModels` — GetModelList → sanitize → fallback built-ins.
    pub(crate) async fn refresh_models(&self, account_id: &str) {
        let models = match self.ensure_auth(account_id).await {
            Ok(auth) => self
                .catalog
                .get_or_fetch("", MODELS_CACHE_TTL_MS, || auth.get_model_list())
                .await
                .unwrap_or_else(|e| {
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Trae model list refresh failed: {e}"),
                        None,
                        None,
                        None,
                        None,
                        None,
                    );
                    Vec::new()
                }),
            Err(e) => {
                self.log_entry(
                    LogLevel::Warn,
                    format!("Trae model list refresh failed: {e}"),
                    None,
                    None,
                    None,
                    None,
                    None,
                );
                Vec::new()
            }
        };
        let usable: Vec<String> = models
            .iter()
            .map(|m| normalize_trae_model(m))
            .filter(|m| !m.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.model_ids = usable;
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

    /// `callTrae` — rawChat via llm_raw_chat (the CDP local bridge was
    /// removed: CDP-driven agent calls are rejected).
    pub(crate) async fn call_trae(
        &self,
        account: &AccountWithState,
        auth: &Arc<TraeAuth>,
        format: &'static str,
        model: &str,
        body: &Value,
    ) -> anyhow::Result<(
        String,
        Option<crate::types::UsageStats>,
        Vec<crate::providers::windsurf_stream::GatewayToolCall>,
    )> {
        let core_base = account
            .config
            .fields
            .get("coreBaseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| self.settings.core_base_url.clone());
        let payload = build_trae_raw_chat_payload(model, body, format);
        let result = run_trae_raw_chat(
            auth,
            &self.http.client(),
            &core_base,
            &self.settings.raw_chat_path,
            &self.settings.ide_version,
            &payload,
            self.settings.first_token_timeout,
            self.settings.streaming_read_timeout,
        )
        .await?;
        if let Some(err) = result.text.strip_prefix("__TRAE_ERROR__:") {
            anyhow::bail!(
                "Trae stream error: {}",
                err.chars().take(800).collect::<String>()
            );
        }
        Ok((result.text, result.usage, result.tool_calls))
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
            match self.call_trae(&account, &auth, format, model, body).await {
                Ok((text, usage, tool_calls)) => {
                    // usage sink runs inside the output converters
                    let out = if format == "openai" {
                        openai_json(
                            &text,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            usage.as_ref(),
                            &tool_calls,
                            &account.config.id,
                            "trae",
                        )
                    } else {
                        anthropic_json(
                            &text,
                            model,
                            body,
                            ctx.on_usage.as_ref(),
                            usage.as_ref(),
                            &tool_calls,
                            &account.config.id,
                            "trae",
                        )
                    };
                    self.pool.lock().await.report_success(&account.config.id);
                    self.log_entry(
                        LogLevel::Info,
                        "Trae upstream success",
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
                    let classified = classify_trae_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Trae upstream failed: {last_error}"),
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
            "Trae request failed: {}",
            if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            }
        )
    }
}
