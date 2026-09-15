//! Qoder chat — port of `client.ts`: buildQoderChatPayload, parseQoderSse
//! (legacy wrapper normalization + partial-chunk recovery), stream + collect.

use std::time::Duration;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::protocol::SseParser;

#[derive(Debug, Clone, Default)]
pub struct QoderChatStreamEvent {
    pub raw: Option<Value>,
    pub done: bool,
    pub text: Option<String>,
    pub finish_reason: Option<String>,
    pub usage: Option<Value>,
}

/// `buildQoderChatPayload`.
pub fn build_qoder_chat_payload(
    body: &Value,
    model: &str,
    max_output_tokens: &str,
    request_id: &str,
) -> Value {
    let mut payload = json!({
        "model": model,
        "messages": normalize_openai_messages(body.get("messages")),
        "stream": true,
        "stream_options": { "include_usage": true },
        "metadata": {
            "context": {
                "request_id": request_id,
                "request_set_id": request_id,
                "session_id": format!("ghub-{request_id}"),
                "task_id": request_id,
                "client_type": "gatewayhub",
            },
        },
    });
    let max_tokens =
        body.get("max_tokens")
            .and_then(Value::as_f64)
            .unwrap_or(if max_output_tokens == "32k" {
                32768.0
            } else {
                16384.0
            });
    payload["max_tokens"] = json!(max_tokens);
    for key in [
        "temperature",
        "top_p",
        "presence_penalty",
        "frequency_penalty",
        "seed",
    ] {
        if let Some(v) = body.get(key).and_then(Value::as_f64) {
            payload[key] = json!(v);
        }
    }
    for key in [
        "stop",
        "response_format",
        "tool_choice",
        "parallel_tool_calls",
        "context_length",
        "user",
        "reasoning_effort",
    ] {
        if let Some(v) = body.get(key) {
            payload[key] = v.clone();
        }
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        payload["tools"] = Value::Array(normalize_openai_tools(tools));
    }
    payload
}

fn normalize_openai_messages(messages: Option<&Value>) -> Value {
    let source = messages
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let normalized: Vec<Value> = source
        .iter()
        .filter(|m| m.is_object())
        .filter_map(|message| {
            let role = message.get("role").and_then(Value::as_str)?;
            if !["system", "user", "assistant", "tool"].contains(&role) {
                return None;
            }
            let mut item = json!({ "role": role });
            let content = normalize_openai_content(
                message.get("content").or_else(|| message.get("contents")),
            );
            if let Some(c) = content {
                item["content"] = c;
            }
            if let Some(name) = message.get("name").and_then(Value::as_str) {
                item["name"] = json!(name);
            }
            if let Some(tc) = message.get("tool_calls").and_then(Value::as_array) {
                item["tool_calls"] = Value::Array(tc.clone());
            }
            if let Some(id) = message.get("tool_call_id").and_then(Value::as_str) {
                item["tool_call_id"] = json!(id);
            }
            if let Some(rc) = message.get("reasoning_content").and_then(Value::as_str) {
                item["reasoning_content"] = json!(rc);
            }
            if let Some(ri) = message.get("reasoning_item") {
                item["reasoning_item"] = ri.clone();
            }
            Some(item)
        })
        .collect();
    if normalized.is_empty() {
        json!([{ "role": "user", "content": "Hello" }])
    } else {
        Value::Array(normalized)
    }
}

fn normalize_openai_content(content: Option<&Value>) -> Option<Value> {
    match content? {
        Value::String(_) | Value::Null => Some(content.cloned().unwrap_or(Value::Null)),
        Value::Array(parts) => Some(Value::Array(
            parts
                .iter()
                .filter(|p| p.is_object())
                .filter_map(|part| match part.get("type").and_then(Value::as_str) {
                    Some("text") => Some(json!({
                        "type": "text",
                        "text": part.get("text").and_then(Value::as_str).unwrap_or(""),
                    })),
                    Some("image_url") => part
                        .get("image_url")
                        .and_then(|iu| iu.get("url"))
                        .and_then(Value::as_str)
                        .map(|url| {
                            let mut iu = json!({ "url": url });
                            if let Some(d) = part.pointer("/image_url/detail") {
                                iu["detail"] = d.clone();
                            }
                            json!({ "type": "image_url", "image_url": iu })
                        }),
                    Some("input_audio") => part
                        .get("input_audio")
                        .and_then(|ia| ia.get("data"))
                        .and_then(Value::as_str)
                        .map(|data| json!({
                            "type": "input_audio",
                            "input_audio": {
                                "data": data,
                                "format": part.pointer("/input_audio/format").and_then(Value::as_str).unwrap_or("wav"),
                            },
                        })),
                    _ => None,
                })
                .collect(),
        )),
        _ => None,
    }
}

fn normalize_openai_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter(|t| t.get("type").and_then(Value::as_str) == Some("function"))
        .filter(|t| {
            t.pointer("/function/name")
                .and_then(Value::as_str)
                .is_some_and(|n| !n.is_empty())
        })
        .map(|tool| {
            let f = &tool["function"];
            let mut out = json!({ "name": f.get("name") });
            if let Some(d) = f.get("description") {
                out["description"] = d.clone();
            }
            if let Some(p) = f.get("parameters") {
                out["parameters"] = p.clone();
            }
            if let Some(s) = f.get("strict") {
                out["strict"] = s.clone();
            }
            json!({ "type": "function", "function": out })
        })
        .collect()
}

// ---------------------------------------------------------------------------
// parseQoderSse — legacy wrapper normalization + partial-chunk recovery
// ---------------------------------------------------------------------------

/// `normalizeSseEvent` → Result<Option<event>, error>. None = skip frame.
pub fn normalize_sse_event(
    event: &Option<String>,
    data: &str,
) -> anyhow::Result<Option<QoderChatStreamEvent>> {
    let data = data.trim();
    if data.is_empty() {
        return Ok(None);
    }
    if data == "[DONE]" {
        return Ok(Some(QoderChatStreamEvent {
            done: true,
            ..Default::default()
        }));
    }
    let mut raw = serde_json::from_str::<Value>(data).ok();
    if raw.is_none() {
        if let Some(json) = extract_first_json_value(data) {
            raw = serde_json::from_str::<Value>(&json).ok();
        }
        if raw.is_none() {
            raw = recover_partial_chunk(data);
        }
        if raw.is_none() {
            if event.as_deref() != Some("error") && is_likely_partial_qoder_chunk(data) {
                return Ok(None);
            }
            anyhow::bail!(
                "Qoder SSE payload is not JSON: {}",
                &data[..data.len().min(300)]
            );
        }
    }
    let raw = raw.unwrap();
    if let Some(legacy) = normalize_legacy_sse_wrapper(&raw, data)? {
        return Ok(Some(legacy));
    }
    if event.as_deref() == Some("error") || raw.get("error").is_some() {
        let err = raw.get("error").unwrap_or(&raw);
        anyhow::bail!(
            "{}",
            err.get("message")
                .or_else(|| err.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| serde_json::to_string(err).unwrap_or_default())
                .chars()
                .take(1000)
                .collect::<String>()
        );
    }
    Ok(Some(chunk_event(&raw)))
}

fn chunk_event(raw: &Value) -> QoderChatStreamEvent {
    let choice = raw.get("choices").and_then(|c| c.get(0));
    let delta = choice
        .and_then(|c| c.get("delta").or_else(|| c.get("message")))
        .cloned()
        .unwrap_or(Value::Null);
    QoderChatStreamEvent {
        raw: Some(raw.clone()),
        done: false,
        text: delta
            .get("content")
            .and_then(Value::as_str)
            .map(str::to_string),
        finish_reason: choice
            .and_then(|c| c.get("finish_reason"))
            .and_then(Value::as_str)
            .filter(|s| *s != "null")
            .map(str::to_string),
        usage: raw.get("usage").filter(|u| u.is_object()).cloned(),
    }
}

/// `normalizeLegacySseWrapper` — {statusCode, body} envelopes.
fn normalize_legacy_sse_wrapper(
    raw: &Value,
    event_data: &str,
) -> anyhow::Result<Option<QoderChatStreamEvent>> {
    if !raw.is_object() || raw.get("body").is_none() {
        return Ok(None);
    }
    if raw.get("statusCodeValue").is_none()
        && raw.get("statusCode").is_none()
        && raw.get("status").is_none()
    {
        return Ok(None);
    }
    let status = raw
        .get("statusCodeValue")
        .or_else(|| raw.get("statusCode"))
        .or_else(|| raw.get("status"))
        .and_then(Value::as_i64);
    let body_text = match raw.get("body") {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(other) => serde_json::to_string(other).unwrap_or_default(),
    };
    if body_text == "[EXCEED_QUOTA]" {
        anyhow::bail!("Qoder legacy quota exceeded");
    }
    if is_legacy_terminal_payload(&body_text) {
        return Ok(Some(QoderChatStreamEvent {
            done: body_text == "[DONE]",
            ..Default::default()
        }));
    }
    if let Some(s) = status
        && s >= 400
    {
        anyhow::bail!(
            "Qoder legacy HTTP {s}: {}",
            if body_text.is_empty() {
                event_data.to_string()
            } else {
                body_text.clone()
            }
        );
    }
    if body_text.is_empty() {
        return Ok(None);
    }
    let mut inner = serde_json::from_str::<Value>(&body_text).ok();
    if inner.is_none() {
        if let Some(json) = extract_first_json_value(&body_text) {
            inner = serde_json::from_str::<Value>(&json).ok();
        }
        if inner.is_none() {
            inner = recover_partial_chunk(&body_text);
        }
        if inner.is_none() {
            if is_likely_partial_qoder_chunk(&body_text) {
                return Ok(None);
            }
            anyhow::bail!(
                "Qoder legacy SSE body is not JSON: {}",
                &body_text[..body_text.len().min(300)]
            );
        }
    }
    let inner = inner.unwrap();
    if let Some(err) = inner.get("error") {
        anyhow::bail!(
            "{}",
            err.get("message")
                .or_else(|| err.get("error"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| serde_json::to_string(err).unwrap_or_default())
                .chars()
                .take(1000)
                .collect::<String>()
        );
    }
    Ok(Some(chunk_event(&inner)))
}

fn is_legacy_terminal_payload(value: &str) -> bool {
    value.is_empty()
        || value == "[DONE]"
        || value == "[NOT_EXCEED_QUOTA]"
        || value == "[NOTIFICATIONS]"
}

/// `recoverPartialChunk` — salvage finish_reason/content/reasoning_content
/// from a truncated JSON chunk.
fn recover_partial_chunk(value: &str) -> Option<Value> {
    let mut base = partial_chunk_base(value)?;
    if let Some(fr) = match_json_string(value, "finish_reason") {
        base["choices"] = json!([{"index": 0, "delta": {}, "finish_reason": fr}]);
        return Some(base);
    }
    if let Some(content) = match_json_string(value, "content") {
        base["choices"] =
            json!([{"index": 0, "delta": {"content": content}, "finish_reason": null}]);
        return Some(base);
    }
    if let Some(rc) = match_json_string(value, "reasoning_content") {
        base["choices"] =
            json!([{"index": 0, "delta": {"reasoning_content": rc}, "finish_reason": null}]);
        return Some(base);
    }
    None
}

fn partial_chunk_base(value: &str) -> Option<Value> {
    let trimmed = value.trim_start();
    if !is_likely_partial_qoder_chunk(trimmed) {
        return None;
    }
    Some(json!({
        "id": match_json_string(trimmed, "id").unwrap_or_else(|| format!("chatcmpl-{}", uuid::Uuid::new_v4().simple())),
        "object": match_json_string(trimmed, "object").unwrap_or_else(|| "chat.completion.chunk".into()),
        "created": regex::Regex::new(r#""created"\s*:\s*(\d+)"#)
            .unwrap()
            .captures(trimmed)
            .and_then(|c| c.get(1).unwrap().as_str().parse::<u64>().ok())
            .unwrap_or_else(|| crate::responses_api::now_secs() as u64),
        "model": match_json_string(trimmed, "model").unwrap_or_else(|| "unknown".into()),
    }))
}

fn match_json_string(value: &str, key: &str) -> Option<String> {
    let escaped = regex::escape(key);
    let re = regex::Regex::new(&format!(r#""{escaped}"\s*:\s*"([^"]+)""#)).ok()?;
    re.captures(value)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

fn is_likely_partial_qoder_chunk(value: &str) -> bool {
    let trimmed = value.trim_start();
    trimmed.starts_with('{')
        && !trimmed.contains("\"error\":")
        && (regex::Regex::new(r#""id"\s*:\s*""#)
            .unwrap()
            .is_match(trimmed)
            || trimmed.contains("chat.completion")
            || trimmed.contains("\"choices\"")
            || trimmed.contains("\"delta\""))
}

/// `extractFirstJsonValue` — balanced-brace scan.
fn extract_first_json_value(value: &str) -> Option<String> {
    let bytes: Vec<char> = value.chars().collect();
    let start = bytes.iter().position(|c| *c == '{' || *c == '[')?;
    let mut stack: Vec<char> = Vec::new();
    let mut in_string = false;
    let mut escaped = false;
    for i in start..bytes.len() {
        let ch = bytes[i];
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '{' => stack.push('}'),
            '[' => stack.push(']'),
            '}' | ']' => {
                if stack.pop() != Some(ch) {
                    return None;
                }
                if stack.is_empty() {
                    return Some(
                        value.chars().take(i + 1).collect::<String>()[start..].to_string(),
                    );
                }
            }
            _ => {}
        }
    }
    None
}

// ---------------------------------------------------------------------------
// stream + collect
// ---------------------------------------------------------------------------

/// `streamQoderChatCompletion` — direct API path only. Legacy (WASM-signed)
/// requests return the same "requires qodercli auth bundle" error the TS
/// throws when the account lacks qoderCliHome; the WASM signer is not ported.
pub fn stream_qoder_chat(
    client: reqwest::Client,
    api_base: String,
    token: String,
    payload: Value,
    request_id: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
) -> impl Stream<Item = Result<QoderChatStreamEvent, anyhow::Error>> + Send {
    async_stream::stream! {
        let session_id = format!("ghub-{request_id}");
        let url = format!("{}{}", api_base.trim_end_matches('/'), super::qoder_auth::MODEL_CHAT_PATH);
        let res = match client
            .post(&url)
            .header("accept", "text/event-stream")
            .header("content-type", "application/json")
            .header("authorization", format!("Bearer {token}"))
            .header("x-request-id", &request_id)
            .header("x-session-id", &session_id)
            .header("user-agent", super::qoder_auth::QODER_CLI_USER_AGENT)
            .timeout(first_token_timeout.max(Duration::from_secs(30)))
            .json(&payload)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => { yield Err(e.into()); return; }
        };
        let status = res.status().as_u16();
        if status >= 400 {
            let body = res.text().await.unwrap_or_default();
            yield Err(anyhow::anyhow!("Qoder HTTP {status}: {}", &body[..body.len().min(1000)]));
            return;
        }
        let mut byte_stream = res.bytes_stream();
        let mut parser = SseParser::default();
        let mut saw_frame = false;
        loop {
            let timeout = if saw_frame { streaming_read_timeout } else { first_token_timeout };
            match tokio::time::timeout(timeout, byte_stream.next()).await {
                Ok(Some(Ok(bytes))) => {
                    for (event, data) in parser.feed_blocks(&String::from_utf8_lossy(&bytes)) {
                        saw_frame = true;
                        match normalize_sse_event(&event, &data) {
                            Ok(Some(ev)) => yield Ok(ev),
                            Ok(None) => {}
                            Err(e) => { yield Err(e); return; }
                        }
                    }
                }
                Ok(Some(Err(e))) => { yield Err(e.into()); return; }
                Ok(None) => break,
                Err(_) => {
                    yield Err(anyhow::anyhow!(
                        "Qoder stream timeout after {}ms",
                        timeout.as_millis()
                    ));
                    return;
                }
            }
        }
    }
}

/// `collectQoderChatCompletion`.
pub async fn collect_qoder_chat<S>(events: S, model: &str) -> anyhow::Result<Value>
where
    S: Stream<Item = Result<QoderChatStreamEvent, anyhow::Error>> + Send,
{
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = crate::responses_api::now_secs();
    let mut text = String::new();
    let mut finish_reason = "stop".to_string();
    let mut usage: Option<Value> = None;
    let mut tool_calls: std::collections::HashMap<u64, Value> = std::collections::HashMap::new();
    let mut events = Box::pin(events);
    while let Some(item) = events.next().await {
        let event = item?;
        if let Some(u) = &event.usage {
            usage = Some(u.clone());
        }
        if let Some(fr) = &event.finish_reason {
            finish_reason = normalize_finish_reason(fr).to_string();
        }
        if let Some(t) = &event.text {
            text.push_str(t);
        }
        let choice = event
            .raw
            .as_ref()
            .and_then(|r| r.get("choices"))
            .and_then(|c| c.get(0))
            .cloned()
            .unwrap_or(Value::Null);
        let delta = choice
            .get("delta")
            .or_else(|| choice.get("message"))
            .cloned()
            .unwrap_or(Value::Null);
        for item in delta
            .get("tool_calls")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
        {
            let index = item
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(tool_calls.len() as u64);
            let mut current = tool_calls.get(&index).cloned().unwrap_or_else(|| {
                json!({
                    "id": item.get("id").cloned().unwrap_or_else(|| json!(format!("call_{}", uuid::Uuid::new_v4().simple()))),
                    "type": item.get("type").cloned().unwrap_or_else(|| json!("function")),
                    "function": {"name": "", "arguments": ""},
                })
            });
            if let Some(name) = item.pointer("/function/name").and_then(Value::as_str) {
                let cur = current
                    .pointer("/function/name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                current["function"]["name"] = json!(cur + name);
            }
            if let Some(args) = item.pointer("/function/arguments").and_then(Value::as_str) {
                let cur = current
                    .pointer("/function/arguments")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                current["function"]["arguments"] = json!(cur + args);
            }
            tool_calls.insert(index, current);
        }
    }
    let mut message = json!({
        "role": "assistant",
        "content": if text.is_empty() && !tool_calls.is_empty() { Value::Null } else { json!(text) },
    });
    if !tool_calls.is_empty() {
        let mut calls: Vec<Value> = tool_calls.into_values().collect();
        calls.sort_by_key(|c| c.get("index").and_then(Value::as_u64).unwrap_or(0));
        message["tool_calls"] = Value::Array(calls);
    }
    let completion = json!({
        "id": id,
        "object": "chat.completion",
        "created": created,
        "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish_reason}],
    });
    let mut completion = completion;
    if let Some(u) = usage {
        completion["usage"] = u;
    }
    Ok(completion)
}

pub fn normalize_finish_reason(value: &str) -> &str {
    match value {
        "tool_calls" | "length" | "content_filter" => value,
        _ => "stop",
    }
}
