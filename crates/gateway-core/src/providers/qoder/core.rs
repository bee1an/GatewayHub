//! Upstream internals for `qoder.rs` — direct API + stream normalization.

use super::*;

impl QoderCore {
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
            provider: Some("qoder".into()),
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

    pub(crate) fn has_direct_accounts(&self) -> bool {
        self.pool
            .try_lock()
            .map(|p| {
                p.accounts
                    .iter()
                    .any(|a| a.config.enabled && qoder_account_uses_direct_api(&a.config))
            })
            .unwrap_or(false)
    }

    /// `getAccount`: availability → direct-api → legacy gate → model.
    pub(crate) async fn get_account(
        &self,
        model: &str,
        excluded: &HashSet<String>,
    ) -> Option<AccountWithState> {
        let normalized = normalize_qoder_model(model);
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                let mut pool = self.pool.lock().await;
                let Some(acc) = pool.find(&id).cloned() else {
                    continue;
                };
                if !qoder_account_uses_direct_api(&acc.config) {
                    continue;
                }
                if is_qoder_legacy_model(&normalized)
                    && acc
                        .config
                        .fields
                        .get("qoderCliHome")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .is_none_or(|s| s.is_empty())
                {
                    continue;
                }
                if !pool.has_model(&id, &normalized) {
                    continue;
                }
                pool.commit(&id);
                return pool.find(&id).cloned();
            }
        }
        None
    }

    /// `refreshAccountModels` — no server-side /models; per-account
    /// capability list (legacy needs the cli bundle).
    pub(crate) async fn refresh_models(&self, account_id: &str) -> Vec<String> {
        let models: Vec<String> = {
            let pool = self.pool.lock().await;
            pool.find(account_id)
                .map(|a| {
                    if qoder_account_uses_direct_api(&a.config) {
                        let has_cli = a
                            .config
                            .fields
                            .get("qoderCliHome")
                            .and_then(Value::as_str)
                            .is_some_and(|s| !s.trim().is_empty());
                        if has_cli {
                            QODER_KNOWN_MODELS
                                .iter()
                                .map(|(id, ..)| id.to_string())
                                .collect()
                        } else {
                            QODER_DIRECT_MODEL_IDS
                                .iter()
                                .map(|s| s.to_string())
                                .collect()
                        }
                    } else {
                        QODER_KNOWN_MODELS
                            .iter()
                            .map(|(id, ..)| id.to_string())
                            .collect()
                    }
                })
                .unwrap_or_else(|| {
                    QODER_KNOWN_MODELS
                        .iter()
                        .map(|(id, ..)| id.to_string())
                        .collect()
                })
        };
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            acc.state.model_ids = models.clone();
            acc.state.models_cached_at = now_ms();
        }
        models
    }

    pub(crate) async fn maybe_refresh_models(&self, account_id: &str) {
        {
            let pool = self.pool.lock().await;
            if let Some(acc) = pool.find(account_id)
                && acc.state.models_cached_at > 0
                && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
            {
                return;
            }
        }
        let _ = self.refresh_models(account_id).await;
    }

    pub(crate) fn report_usage(
        &self,
        body: &Value,
        output: &str,
        model: &str,
        account_id: &str,
        ctx: &GatewayRequestContext,
        upstream_usage: Option<&Value>,
    ) {
        let Some(sink) = &ctx.on_usage else { return };
        let input = upstream_usage
            .and_then(|u| u.get("prompt_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or_else(|| estimate_tokens(body.get("messages").unwrap_or(body)));
        let output_tokens = upstream_usage
            .and_then(|u| u.get("completion_tokens"))
            .and_then(Value::as_u64)
            .unwrap_or_else(|| (output.len() as u64 + 3) / 4);
        sink(
            UsageStats {
                input_tokens: input,
                output_tokens,
                estimated: Some(upstream_usage.is_none()),
                ..Default::default()
            },
            UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("qoder".into()),
            },
        );
    }

    pub(crate) async fn non_stream(
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
            let Some(account) = self.get_account(model, &excluded).await else {
                break;
            };
            let started = now_ms();
            match self.run_request(&account, model, body, ctx).await {
                Ok((completion, text, usage)) => {
                    self.pool.lock().await.report_success(&account.config.id);
                    self.report_usage(body, &text, model, &account.config.id, ctx, usage.as_ref());
                    self.log_entry(
                        LogLevel::Info,
                        "Qoder upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    return GatewayResponse::json(200, completion);
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
                    let classified = classify_qoder_error(&last_error);
                    self.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    self.log_entry(
                        LogLevel::Warn,
                        format!("Qoder upstream failed: {last_error}"),
                        Some(&account),
                        Some(&ctx.request_id),
                        Some(model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                }
            }
        }
        GatewayResponse::error(
            502,
            if last_error.is_empty() {
                "No available Qoder direct credential accounts".to_string()
            } else {
                last_error
            },
            "gateway_error",
        )
    }

    /// Resolve token → payload → collect stream.
    pub(crate) async fn run_request(
        &self,
        account: &AccountWithState,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> anyhow::Result<(Value, String, Option<Value>)> {
        let token = self.resolver.resolve(&account.config).await?;
        let payload = build_qoder_chat_payload(
            body,
            model,
            &self.settings.max_output_tokens,
            &ctx.request_id,
        );
        let events = stream_qoder_chat(
            self.http.client(),
            self.settings.api_base_url.clone(),
            token,
            payload,
            ctx.request_id.clone(),
            self.settings
                .first_token_timeout
                .max(Duration::from_secs(30)),
            self.settings.streaming_read_timeout,
        );
        let mut full_text = String::new();
        let mut usage: Option<Value> = None;
        let mut finish = "stop".to_string();
        use futures::StreamExt;
        let mut events = Box::pin(events);
        let mut raw_events: Vec<crate::providers::qoder_chat::QoderChatStreamEvent> = Vec::new();
        while let Some(item) = events.next().await {
            let ev = item?;
            raw_events.push(ev);
        }
        let completion = collect_qoder_chat(
            futures::stream::iter(raw_events.iter().cloned().map(Ok)),
            model,
        )
        .await?;
        for ev in &raw_events {
            if let Some(u) = &ev.usage {
                usage = Some(u.clone());
            }
            if let Some(fr) = &ev.finish_reason {
                finish = normalize_finish_reason(fr).to_string();
            }
            if let Some(t) = &ev.text {
                full_text.push_str(t);
            }
        }
        let _ = finish;
        Ok((completion, full_text, usage))
    }

    /// `streamWithFailover` — relay upstream chunks (normalized to
    /// chat.completion.chunk), failover only before first emitted chunk.
    pub(crate) fn stream(
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
                let Some(account) = view.get_account(&model, &excluded).await else {
                    break;
                };
                let started = now_ms();
                let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
                let mut emitted = false;
                let mut full_text = String::new();
                let mut finish_reason = "stop".to_string();
                let mut usage: Option<Value> = None;
                let mut saw_terminal_chunk = false;

                let run = async {
                    let token = view.resolver.resolve(&account.config).await?;
                    let payload = build_qoder_chat_payload(
                        &body,
                        &model,
                        &view.settings.max_output_tokens,
                        &request_id,
                    );
                    Ok::<_, anyhow::Error>(stream_qoder_chat(
                        view.http.client(),
                        view.settings.api_base_url.clone(),
                        token,
                        payload,
                        request_id.clone(),
                        view.settings.first_token_timeout.max(Duration::from_secs(30)),
                        view.settings.streaming_read_timeout,
                    ))
                };
                let events = match run.await {
                    Ok(e) => e,
                    Err(e) => {
                        if cancel.is_cancelled() {
                            return;
                        }
                        last_error = e.to_string();
                        let classified = classify_qoder_error(&last_error);
                        view.pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                        excluded.insert(account.config.id.clone());
                        tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                        continue;
                    }
                };
                use futures::StreamExt;
                let mut events = Box::pin(events);
                let mut stream_error: Option<String> = None;
                while let Some(item) = events.next().await {
                    match item {
                        Ok(event) => {
                            if event.done {
                                break;
                            }
                            if let Some(u) = &event.usage {
                                usage = Some(u.clone());
                            }
                            if let Some(fr) = &event.finish_reason {
                                finish_reason = normalize_finish_reason(fr).to_string();
                            }
                            if let Some(t) = &event.text {
                                full_text.push_str(t);
                            }
                            let Some(raw) = &event.raw else { continue };
                            let chunk = normalize_openai_chunk(raw, &id, &model);
                            if chunk.get("choices").and_then(Value::as_array).is_some_and(|c| {
                                c.iter().any(|ch| ch.get("finish_reason").is_some())
                            }) {
                                saw_terminal_chunk = true;
                            }
                            emitted = true;
                            yield format!("data: {}\n\n", serde_json::to_string(&chunk).unwrap_or_default());
                        }
                        Err(e) => {
                            stream_error = Some(e.to_string());
                            break;
                        }
                    }
                }
                if let Some(err) = stream_error {
                    if cancel.is_cancelled() {
                        return;
                    }
                    last_error = err;
                    let classified = classify_qoder_error(&last_error);
                    view.pool.lock().await.report_failure(&account.config.id, &last_error, &classified);
                    excluded.insert(account.config.id.clone());
                    view.log_entry(
                        LogLevel::Warn,
                        format!("Qoder stream failed: {last_error}"),
                        Some(&account),
                        Some(&request_id),
                        Some(&model),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1, "emitted": emitted})),
                    );
                    if emitted {
                        break 'outer;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt))).await;
                    continue;
                }
                if !saw_terminal_chunk {
                    yield format!(
                        "data: {}\n\n",
                        serde_json::to_string(&json!({
                            "id": id,
                            "object": "chat.completion.chunk",
                            "created": crate::responses_api::now_secs(),
                            "model": model,
                            "choices": [{"index": 0, "delta": {}, "finish_reason": finish_reason}],
                        }))
                        .unwrap_or_default()
                    );
                }
                yield "data: [DONE]\n\n".to_string();
                view.pool.lock().await.report_success(&account.config.id);
                if let Some(sink) = &on_usage {
                    let input = usage
                        .as_ref()
                        .and_then(|u| u.get("prompt_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or_else(|| estimate_tokens(body.get("messages").unwrap_or(&body)));
                    let output = usage
                        .as_ref()
                        .and_then(|u| u.get("completion_tokens"))
                        .and_then(Value::as_u64)
                        .unwrap_or_else(|| (full_text.len() as u64 + 3) / 4);
                    sink(
                        UsageStats {
                            input_tokens: input,
                            output_tokens: output,
                            estimated: Some(usage.is_none()),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some("qoder".into()),
                        },
                    );
                }
                view.log_entry(
                    LogLevel::Info,
                    "Qoder upstream success (stream)",
                    Some(&account),
                    Some(&request_id),
                    Some(&model),
                    Some((now_ms() - started) as u64),
                    None,
                );
                return;
            }
            let message = if last_error.is_empty() {
                "No available Qoder direct credential accounts".to_string()
            } else {
                last_error
            };
            yield format!(
                "data: {}\n\n",
                serde_json::to_string(&json!({
                    "error": {"message": message, "type": "server_error"},
                }))
                .unwrap_or_default()
            );
        }
    }

    /// `fetchQoderAccountProfile` — quota + plan + status.
    pub(crate) async fn account_profile(&self, account: &AccountFile) -> Option<Value> {
        let token = self.resolver.resolve(account).await.ok()?;
        let fetch = |path: String| {
            let client = self.http.client();
            let base = self.settings.openapi_base_url.clone();
            let token = token.clone();
            async move {
                client
                    .get(format!("{base}{path}"))
                    .header("authorization", format!("Bearer {token}"))
                    .header("accept", "application/json")
                    .header(
                        "user-agent",
                        crate::providers::qoder_auth::QODER_CLI_USER_AGENT,
                    )
                    .timeout(Duration::from_secs(15))
                    .send()
                    .await
                    .ok()?
                    .json::<Value>()
                    .await
                    .ok()
            }
        };
        let (quota, plan, status) = futures::join!(
            fetch(crate::providers::qoder_auth::QUOTA_USAGE_PATH.to_string()),
            fetch(crate::providers::qoder_auth::USER_PLAN_PATH.to_string()),
            fetch(crate::providers::qoder_auth::USER_STATUS_PATH.to_string()),
        );
        let quota = quota.unwrap_or(Value::Null);
        let plan = plan.unwrap_or(Value::Null);
        let status = status.unwrap_or(Value::Null);
        let pick = |v: &Value, keys: &[&str]| {
            keys.iter().filter_map(|k| v.get(*k)).find_map(|v| {
                v.as_str()
                    .map(str::to_string)
                    .or_else(|| v.as_i64().map(|n| n.to_string()))
            })
        };
        let quota_info = quota
            .get("userQuota")
            .filter(|q| q.is_object())
            .cloned()
            .unwrap_or(quota.clone());
        let used = quota_info
            .get("used")
            .or_else(|| quota.get("used"))
            .and_then(Value::as_f64);
        let limit = quota_info
            .get("total")
            .or_else(|| quota.get("total"))
            .or_else(|| quota.get("limit"))
            .and_then(Value::as_f64);
        let remaining = quota_info
            .get("remaining")
            .or_else(|| quota.get("remaining"))
            .and_then(Value::as_f64);
        let usage = match (used, limit) {
            (Some(used), Some(limit)) if limit > 0.0 => Some(json!({
                "used": used,
                "limit": limit,
                "remaining": remaining.unwrap_or((limit - used).max(0.0)),
                "isQuotaExceeded": used >= limit,
            })),
            _ => None,
        };
        Some(json!({
            "email": pick(&status, &["email"]).or_else(|| pick(&plan, &["email"])).or_else(|| account.email.clone()),
            "name": pick(&status, &["name"]),
            "subscription": {
                "title": pick(&plan, &["plan_tier_name", "planTierName"])
                    .or_else(|| pick(&status, &["userTag", "plan"]))
                    .unwrap_or_else(|| "Qoder".into()),
                "type": pick(&plan, &["user_type", "userType"])
                    .or_else(|| pick(&status, &["userType", "plan"]))
                    .unwrap_or_else(|| "qoder".into()),
            },
            "usage": usage,
            "keyInfo": {
                "quota": quota,
                "plan": plan,
                "userStatus": status,
            },
        }))
    }
}

pub(crate) fn normalize_openai_chunk(raw: &Value, id: &str, model: &str) -> Value {
    let mut chunk = json!({
        "id": raw.get("id").and_then(Value::as_str).unwrap_or(id),
        "object": raw.get("object").and_then(Value::as_str).unwrap_or("chat.completion.chunk"),
        "created": raw.get("created").and_then(Value::as_u64).unwrap_or_else(|| crate::responses_api::now_secs() as u64),
        "model": raw.get("model").and_then(Value::as_str).unwrap_or(model),
    });
    if let Some(obj) = raw.as_object() {
        for (k, v) in obj {
            chunk[k] = v.clone();
        }
    }
    chunk["choices"] = raw.get("choices").cloned().unwrap_or_else(|| json!([]));
    chunk
}
