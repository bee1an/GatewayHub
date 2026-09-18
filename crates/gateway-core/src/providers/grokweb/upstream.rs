//! Upstream internals for `grokweb.rs` — cookies/headers, model fetch, WS stream.

use super::*;

// ---------------------------------------------------------------------------
// http.ts — REST + WS conversation
// ---------------------------------------------------------------------------

pub(crate) fn cookie_field(account: &AccountFile, key: &str) -> String {
    account
        .fields
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(crate) fn build_headers(
    account: &AccountFile,
    base_url: &str,
    json_body: bool,
) -> Vec<(String, String)> {
    let origin = build_origin(base_url);
    vec![
        (
            "accept".into(),
            if json_body {
                "application/json, text/plain, */*".into()
            } else {
                "*/*".into()
            },
        ),
        ("accept-language".into(), "en-US,en;q=0.9".into()),
        ("user-agent".into(), GROK_WEB_USER_AGENT.into()),
        ("origin".into(), origin.clone()),
        ("referer".into(), format!("{origin}/")),
        ("cookie".into(), cookie_field(account, "cookieHeader")),
    ]
}

pub(crate) fn build_origin(base_url: &str) -> String {
    let base = if base_url.is_empty() {
        DEFAULT_GROK_WEB_BASE_URL
    } else {
        base_url
    };
    match base.find("://") {
        Some(i) => {
            let rest = &base[i + 3..];
            let end = rest.find('/').unwrap_or(rest.len());
            format!("{}://{}", &base[..i], &rest[..end])
        }
        None => base.to_string(),
    }
}

pub(crate) fn build_ws_url(ws_url: &str, account: &AccountFile) -> String {
    let base = if ws_url.is_empty() {
        DEFAULT_GROK_WEB_WS_URL
    } else {
        ws_url
    };
    let uid = {
        let u = cookie_field(account, "userId");
        if u.is_empty() {
            extract_cookie_value(&cookie_field(account, "cookieHeader"), "x-userid")
                .unwrap_or_default()
        } else {
            u
        }
    };
    if uid.is_empty() {
        base.to_string()
    } else {
        let joiner = if base.contains('?') { '&' } else { '?' };
        format!("{base}{joiner}uid={uid}")
    }
}

pub(crate) fn extract_cookie_value(cookie_header: &str, name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        if eq == 0 {
            continue;
        }
        if trimmed[..eq].trim().to_lowercase() == lower {
            return Some(trimmed[eq + 1..].trim().to_string());
        }
    }
    None
}

pub(crate) fn normalize_model_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = GROK_WEB_KNOWN_MODELS
        .iter()
        .map(|s| s.to_string())
        .collect();
    for id in ids {
        let t = id.trim().to_string();
        if !t.is_empty() && !seen.contains(&t) {
            seen.push(t);
        }
    }
    seen
}

/// `fetchModes` + `fetchModels` — modes preferred.
pub(crate) async fn fetch_grok_models(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<Vec<String>> {
    if let Ok(modes) = fetch_grok_modes(client, base_url, account).await
        && !modes.is_empty()
    {
        return Ok(normalize_model_ids(modes));
    }
    let mut req = client
        .post(format!("{}/rest/models", base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .json(&json!({ "locale": "en" }));
    for (k, v) in build_headers(account, base_url, true) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    if status >= 400 {
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "Grok Web models error {status}: {}",
            body.chars().take(200).collect::<String>()
        );
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    let mut ids: Vec<String> = Vec::new();
    for k in ["defaultFreeMode", "defaultFreeModel"] {
        if let Some(v) = data.get(k).and_then(Value::as_str) {
            ids.push(v.to_string());
        }
    }
    for m in data
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        for k in ["modelId", "name", "modeName"] {
            if let Some(v) = m.get(k).and_then(Value::as_str)
                && !v.is_empty()
            {
                ids.push(v.to_string());
                break;
            }
        }
    }
    Ok(normalize_model_ids(ids))
}

pub(crate) async fn fetch_grok_modes(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<Vec<String>> {
    let mut req = client
        .post(format!("{}/rest/modes", base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .json(&json!({ "locale": "en" }));
    for (k, v) in build_headers(account, base_url, true) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    if res.status().as_u16() >= 400 {
        anyhow::bail!("Grok Web modes error {}", res.status().as_u16());
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    let mut ids: Vec<String> = Vec::new();
    if let Some(v) = data.get("defaultModeId").and_then(Value::as_str) {
        ids.push(v.to_string());
    }
    for m in data
        .get("modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if m.pointer("/availability/available")
            .and_then(Value::as_bool)
            == Some(false)
        {
            continue;
        }
        if let Some(v) = m.get("id").and_then(Value::as_str) {
            ids.push(v.to_string());
        }
    }
    Ok(ids)
}

/// `fetchUser` — /rest/auth/get-user.
pub(crate) async fn fetch_grok_user(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<Value> {
    let mut req = client
        .get(format!(
            "{}/rest/auth/get-user",
            base_url.trim_end_matches('/')
        ))
        .timeout(Duration::from_secs(20));
    for (k, v) in build_headers(account, base_url, false) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    if status >= 400 {
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "Grok Web user error {status}: {}",
            body.chars().take(200).collect::<String>()
        );
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(data.get("user").cloned().unwrap_or(data))
}

// ---------------------------------------------------------------------------
pub(crate) fn build_session(model: &str) -> Value {
    json!({
        "model": if model.is_empty() { "auto".to_string() } else { model.to_string() },
        "x_grok": {
            "keep_context": false,
            "is_temporary": true,
            "enable_image_generation": true,
            "image_generation_count": 1,
            "disable_text_follow_ups": false,
            "supported_fast_tools": { "calculatorTool": "1", "unitConversionTool": "1" },
            "disable_artifact": true,
            "force_concise": false,
            "enable_side_by_side": true,
        },
    })
}

/// `streamGrokConversation` → raw gateway events.
pub(crate) fn stream_grok_conversation(
    ws_url: String,
    base_url: String,
    account: AccountFile,
    model: String,
    prompt: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
) -> impl Stream<Item = Result<Value, anyhow::Error>> + Send {
    async_stream::stream! {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let url = build_ws_url(&ws_url, &account);
        let mut request = match url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => { yield Err(anyhow::anyhow!("Grok WS url error: {e}")); return; }
        };
        for (k, v) in build_headers(&account, &base_url, false) {
            use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&v),
            ) {
                request.headers_mut().insert(name, value);
            }
        }
        let (mut ws, _) = match tokio_tungstenite::connect_async(request).await {
            Ok(x) => x,
            Err(e) => { yield Err(anyhow::anyhow!("Grok WebSocket connect failed: {e}")); return; }
        };
        if let Err(e) = ws
            .send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::to_string(&json!({
                    "type": "session.create",
                    "event_id": "evt_init",
                    "session": build_session(&model),
                }))
                .unwrap_or_default()
                .into(),
            ))
            .await
        {
            yield Err(anyhow::anyhow!("Grok WebSocket send failed: {e}"));
            return;
        }
        let mut turn_sent = false;
        let mut saw_first_content = false;
        let mut heartbeat = tokio::time::interval(Duration::from_millis(1500));
        heartbeat.tick().await; // skip immediate
        loop {
            let timeout = if saw_first_content { streaming_read_timeout } else { first_token_timeout };
            let next = tokio::time::timeout(timeout, async {
                tokio::select! {
                    msg = ws.next() => msg,
                    _ = heartbeat.tick() => {
                        let _ = ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                json!({"type":"ping","event_id":format!("evt_hb_{}", crate::pool::now_ms())})
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                        ws.next().await
                    }
                }
            })
            .await;
            let msg = match next {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(e))) => { yield Err(anyhow::anyhow!("Grok WebSocket error: {e}")); return; }
                Ok(None) => {
                    yield Err(anyhow::anyhow!("Grok WebSocket closed before response completed"));
                    return;
                }
                Err(_) => { yield Err(anyhow::anyhow!("Grok WebSocket timed out")); return; }
            };
            let text = match msg {
                tokio_tungstenite::tungstenite::Message::Text(t) => t.to_string(),
                tokio_tungstenite::tungstenite::Message::Binary(b) => {
                    String::from_utf8_lossy(&b).to_string()
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => {
                    yield Err(anyhow::anyhow!("Grok WebSocket closed before response completed"));
                    return;
                }
                _ => continue,
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
            if parsed.get("type").and_then(Value::as_str) == Some("pong") {
                continue;
            }
            if parsed.get("type").and_then(Value::as_str) == Some("session.created") && !turn_sent {
                turn_sent = true;
                let now = crate::pool::now_ms();
                let turn = serde_json::to_string(&json!({
                    "type": "conversation.item.create",
                    "event_id": format!("evt_action_{now}"),
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": prompt}],
                        "x_grok": { "client_message_id": uuid::Uuid::new_v4().to_string() },
                    },
                }))
                .unwrap_or_default();
                let _ = ws
                    .send(tokio_tungstenite::tungstenite::Message::Text(turn.into()))
                    .await;
                let _ = ws
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        json!({"type":"response.create","event_id":format!("evt_resp_{now}")})
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            if parsed.get("type").and_then(Value::as_str) == Some("response.output_text.delta")
                && parsed.get("delta").and_then(Value::as_str).is_some_and(|d| !d.is_empty())
            {
                saw_first_content = true;
            }
            let is_done = matches!(
                parsed.get("type").and_then(Value::as_str),
                Some("response.done" | "error")
            );
            yield Ok(parsed);
            if is_done {
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// streaming.ts — prompt conversion + event parser
// ---------------------------------------------------------------------------

const IGNORED_MESSAGE_TAGS: &[&str] = &[
    "summary",
    "header",
    "tool_partial_output",
    "tool_usage_card",
];

pub(crate) fn convert_openai_to_grok_prompt(messages: &[Value]) -> String {
    let normalized: Vec<String> = messages
        .iter()
        .filter_map(|message| {
            let text = extract_text(message.get("content").unwrap_or(&Value::Null));
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            let role = match message.get("role").and_then(Value::as_str) {
                Some("assistant") => "assistant",
                Some("system") => "system",
                _ => "user",
            };
            Some(if role == "user" {
                text.to_string()
            } else {
                format!("[{role}]\n{text}")
            })
        })
        .collect();
    if normalized.is_empty() {
        "Hello".into()
    } else {
        normalized.join("\n\n")
    }
}

pub(crate) fn extract_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                let ty = part.get("type").and_then(Value::as_str).unwrap_or("");
                if !ty.is_empty() && ty != "text" && ty != "input_text" {
                    return String::new();
                }
                part.get("text")
                    .or_else(|| part.get("input_text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[derive(Default)]
pub(crate) struct GrokStreamingState {
    pub(crate) response_id: String,
    pub(crate) item_id: String,
    pub(crate) model: String,
    pub(crate) content: String,
    pub(crate) finished: bool,
}

/// `parseGrokGatewayEvent`.
pub(crate) fn parse_grok_gateway_event(
    event: &Value,
    state: &mut GrokStreamingState,
) -> anyhow::Result<(Option<String>, bool)> {
    let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "response.created" => {
            if let Some(id) = event
                .pointer("/response/id")
                .or_else(|| event.get("response_id"))
                .and_then(Value::as_str)
            {
                state.response_id = id.to_string();
            }
            Ok((None, false))
        }
        "response.output_item.added" => {
            if let Some(id) = event.pointer("/item/id").and_then(Value::as_str) {
                state.item_id = id.to_string();
            }
            Ok((None, false))
        }
        "response.output_text.delta" => {
            let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
            if delta.is_empty() || should_ignore_delta(event) {
                return Ok((None, false));
            }
            state.content.push_str(delta);
            Ok((Some(build_openai_chunk(state, delta, None)), false))
        }
        "response.done" => {
            if let Some(id) = event
                .pointer("/response/id")
                .or_else(|| event.get("response_id"))
                .and_then(Value::as_str)
            {
                state.response_id = id.to_string();
            }
            state.finished = true;
            Ok((Some(build_openai_chunk(state, "", Some("stop"))), true))
        }
        "error" => {
            let message = event
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Grok Web returned an error");
            anyhow::bail!("{message}")
        }
        _ => Ok((None, false)),
    }
}

pub(crate) fn should_ignore_delta(event: &Value) -> bool {
    if event
        .pointer("/x_grok/is_thinking")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    event
        .pointer("/x_grok/message_tag")
        .and_then(Value::as_str)
        .is_some_and(|t| IGNORED_MESSAGE_TAGS.contains(&t))
}

pub(crate) fn build_openai_chunk(
    state: &GrokStreamingState,
    content: &str,
    finish: Option<&str>,
) -> String {
    let id = if !state.response_id.is_empty() {
        state.response_id.clone()
    } else if !state.item_id.is_empty() {
        state.item_id.clone()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let chunk = json!({
        "id": format!("chatcmpl-{id}"),
        "object": "chat.completion.chunk",
        "created": crate::responses_api::now_secs(),
        "model": if state.model.is_empty() { "auto".to_string() } else { state.model.clone() },
        "choices": [{
            "index": 0,
            "delta": if content.is_empty() { json!({}) } else { json!({"content": content}) },
            "finish_reason": finish,
        }],
    });
    format!(
        "data: {}\n\n",
        serde_json::to_string(&chunk).unwrap_or_default()
    )
}
