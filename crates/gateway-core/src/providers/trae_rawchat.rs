//! Trae converters + raw chat — port of `providers/trae/converters.ts` and
//! `rawChat.ts` (POST /api/ide/v2/llm_raw_chat; JSON or SSE response).

use std::time::Duration;

use futures::StreamExt;
use serde_json::{Value, json};

use crate::protocol::SseParser;
use crate::providers::kiro_convert::estimate_tokens;
use crate::providers::trae_auth::{TraeAuth, build_trae_ide_headers, normalize_trae_model};
use crate::providers::windsurf_stream::GatewayToolCall;
use crate::types::UsageStats;

mod stream;
pub use stream::*;

// ---------------------------------------------------------------------------
// converters.ts
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TraeMessage {
    pub role: String,
    pub content: String,
    pub tool_call_id: Option<String>,
}

impl TraeMessage {
    fn to_json(&self) -> Value {
        let mut v = json!({ "role": self.role, "content": self.content });
        if let Some(id) = &self.tool_call_id {
            v["tool_call_id"] = json!(id);
        }
        v
    }
}

pub fn openai_to_trae_messages(body: &Value) -> Vec<TraeMessage> {
    body.get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|msg| {
            let role = match msg.get("role").and_then(Value::as_str) {
                Some(r @ ("system" | "developer" | "user" | "assistant" | "tool")) => r,
                _ => return None,
            };
            let mut content = extract_message_text(msg.get("content").unwrap_or(&Value::Null));
            if content.is_empty() {
                content = openai_tool_calls_text(msg.get("tool_calls"));
            }
            if content.is_empty() {
                return None;
            }
            Some(TraeMessage {
                role: role.to_string(),
                content,
                tool_call_id: msg
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

pub fn anthropic_to_trae_messages(body: &Value) -> Vec<TraeMessage> {
    let mut out = Vec::new();
    let system = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        other => crate::protocol::extract_text(other.unwrap_or(&Value::Null)),
    };
    if !system.is_empty() {
        out.push(TraeMessage {
            role: "system".into(),
            content: system,
            tool_call_id: None,
        });
    }
    for msg in body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            "assistant"
        } else {
            "user"
        };
        let content = anthropic_content_text(msg.get("content").unwrap_or(&Value::Null));
        if !content.is_empty() {
            out.push(TraeMessage {
                role: role.into(),
                content,
                tool_call_id: None,
            });
        }
    }
    out
}

/// `buildTraeRawChatPayload`.
pub fn build_trae_raw_chat_payload(model: &str, body: &Value, format: &str) -> Value {
    let normalized = normalize_trae_model(model);
    let messages: Vec<Value> = (if format == "openai" {
        openai_to_trae_messages(body)
    } else {
        anthropic_to_trae_messages(body)
    })
    .iter()
    .map(TraeMessage::to_json)
    .collect();

    let max_tokens = body
        .get("max_tokens")
        .or_else(|| body.get("max_completion_tokens"))
        .cloned();
    let max_completion = body
        .get("max_completion_tokens")
        .or_else(|| body.get("max_tokens"))
        .cloned();
    let mut payload = json!({
        "model": normalized,
        "model_name": normalized,
        "model_info": { "model_name": normalized, "name": normalized },
        "messages": messages,
        "stream": true,
        "max_tokens": max_tokens,
        "max_completion_tokens": max_completion,
        "temperature": body.get("temperature"),
        "top_p": body.get("top_p"),
        "pass_back_reasoning": true,
        "request": {
            "model": normalized,
            "messages": messages,
            "stream": true,
            "max_tokens": max_tokens,
            "max_completion_tokens": max_completion,
            "temperature": body.get("temperature"),
            "top_p": body.get("top_p"),
        },
        "raw_chat_function": "chat",
        "function": "chat",
    });
    if body
        .get("tools")
        .and_then(Value::as_array)
        .is_some_and(|t| !t.is_empty())
    {
        payload["tools"] = body["tools"].clone();
    }
    if let Some(tc) = body.get("tool_choice") {
        payload["tool_choice"] = tc.clone();
    }
    if let Some(effort) = body.get("reasoning_effort") {
        payload["reasoning"] = json!({ "effort": effort });
    } else if let Some(r) = body.get("reasoning") {
        payload["reasoning"] = r.clone();
    }
    prune_undefined(payload)
}

fn extract_message_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(s) => s.clone(),
                _ => match part.get("type").and_then(Value::as_str) {
                    Some("text") | Some("input_text") => part
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    Some("image_url") | Some("image") => "[image]".into(),
                    _ => crate::protocol::extract_text(part),
                },
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => crate::protocol::extract_text(other),
    }
}

fn anthropic_content_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| match block.get("type").and_then(Value::as_str) {
                Some("text") => block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                Some("image") => "[image]".into(),
                Some("tool_use") => format!(
                    "[tool_use {}] {}",
                    block
                        .get("name")
                        .or_else(|| block.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    serde_json::to_string(block.get("input").unwrap_or(&json!({})))
                        .unwrap_or_else(|_| "{}".into())
                ),
                Some("tool_result") => format!(
                    "[tool_result {}] {}",
                    block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                    crate::protocol::extract_text(block.get("content").unwrap_or(&Value::Null))
                ),
                _ => crate::protocol::extract_text(block),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => crate::protocol::extract_text(other),
    }
}

fn openai_tool_calls_text(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|t| t.is_object())
                .map(|tc| {
                    let name = tc
                        .pointer("/function/name")
                        .or_else(|| tc.get("name"))
                        .or_else(|| tc.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let input = tc
                        .pointer("/function/arguments")
                        .or_else(|| tc.get("arguments"))
                        .or_else(|| tc.get("input"))
                        .cloned()
                        .unwrap_or(json!({}));
                    let input_str = match &input {
                        Value::String(s) => s.clone(),
                        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
                    };
                    format!("[tool_call {name}] {input_str}")
                })
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

fn prune_undefined(value: Value) -> Value {
    match value {
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(_, v)| !v.is_null())
                .map(|(k, v)| (k, prune_undefined(v)))
                .collect(),
        ),
        Value::Array(arr) => Value::Array(arr.into_iter().map(prune_undefined).collect()),
        other => other,
    }
}

// ---------------------------------------------------------------------------
// rawChat.ts
// ---------------------------------------------------------------------------

pub struct TraeRawChatResult {
    pub text: String,
    pub usage: Option<UsageStats>,
    pub tool_calls: Vec<GatewayToolCall>,
}

/// `runTraeRawChat` — POST raw_chat; response is either a JSON body or an
/// SSE stream; both paths funnel into the same text/usage/tool merge.
pub async fn run_trae_raw_chat(
    auth: &TraeAuth,
    http: &reqwest::Client,
    core_base_url: &str,
    raw_chat_path: &str,
    ide_version: &str,
    payload: &Value,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
) -> anyhow::Result<TraeRawChatResult> {
    let token = auth.get_jwt_token().await?;
    let url = format!("{}{}", core_base_url.trim_end_matches('/'), raw_chat_path);
    let mut req = http
        .post(&url)
        .header("accept", "text/event-stream, application/json")
        .header("content-type", "application/json")
        .header("x-app-function", "chat")
        .header("x-ide-function", "chat")
        .timeout(first_token_timeout)
        .json(payload);
    for (k, v) in build_trae_ide_headers(&token, ide_version) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let content_type = res
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if status >= 400 {
        let text = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "Trae raw chat failed: HTTP {status} {}",
            text.chars().take(800).collect::<String>()
        );
    }
    if !content_type.contains("text/event-stream") {
        let text = res.text().await.unwrap_or_default();
        let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
        if is_error_payload(&parsed) {
            anyhow::bail!(
                "Trae raw chat error: {}",
                stringify_payload(&parsed)
                    .chars()
                    .take(800)
                    .collect::<String>()
            );
        }
        let mut acc = ToolCallAcc::default();
        merge_tool_calls_from_payload(&parsed, &mut acc);
        return Ok(TraeRawChatResult {
            text: extract_text_from_payload(&parsed)
                .or_else(|| parsed.as_str().map(str::to_string))
                .unwrap_or_default(),
            usage: extract_usage(&parsed),
            tool_calls: finalize_tool_calls(acc),
        });
    }
    // SSE stream — collect all blocks with first-token + idle timeouts
    let mut stream = res.bytes_stream();
    let mut parser = SseParser::default();
    let mut events: Vec<(Option<String>, Value)> = Vec::new();
    let mut first = true;
    loop {
        let timeout = if first {
            first_token_timeout
        } else {
            streaming_read_timeout
        };
        let item = tokio::time::timeout(timeout, stream.next()).await;
        match item {
            Ok(Some(Ok(bytes))) => {
                first = false;
                for (event, data) in parser.feed_blocks(&String::from_utf8_lossy(&bytes)) {
                    let data = data.trim().to_string();
                    if data == "[DONE]" {
                        continue;
                    }
                    events.push((
                        event,
                        serde_json::from_str(&data).unwrap_or(Value::String(data)),
                    ));
                }
            }
            Ok(Some(Err(e))) => return Err(e.into()),
            Ok(None) => break,
            Err(_) => {
                anyhow::bail!(if first {
                    format!("No Trae token within {}s", timeout.as_secs())
                } else {
                    format!(
                        "Trae stream idle timeout after {}s without data",
                        timeout.as_secs()
                    )
                });
            }
        }
    }
    Ok(parse_trae_sse(events, status))
}

/// `parseTraeSse` — fold SSE payloads into text + usage + tool calls.
fn parse_trae_sse(events: Vec<(Option<String>, Value)>, status: u16) -> TraeRawChatResult {
    let mut text = String::new();
    let mut usage: Option<UsageStats> = None;
    let mut last_error: Option<Value> = None;
    let mut acc = ToolCallAcc::default();
    for (event_name, data) in &events {
        let name = event_name
            .clone()
            .or_else(|| event_name_from_payload(data))
            .unwrap_or_default();
        if name == "error" || is_error_payload(data) {
            last_error = Some(data.clone());
            continue;
        }
        merge_tool_calls_from_payload(data, &mut acc);
        if let Some(u) = extract_usage(data) {
            usage = Some(u);
        }
        if let Some(chunk) = extract_text_from_payload(data) {
            text = append_delta(&text, &chunk);
        }
    }
    if let Some(err) = last_error
        && text.is_empty()
    {
        let _ = status;
        // caller converts to error via text-empty check; keep parity by
        // embedding the error message in text
        return TraeRawChatResult {
            text: String::new(),
            usage: None,
            tool_calls: Vec::new(),
        }
        .with_error(stringify_payload(&err));
    }
    TraeRawChatResult {
        text,
        usage,
        tool_calls: finalize_tool_calls(acc),
    }
}

impl TraeRawChatResult {
    fn with_error(self, message: String) -> Self {
        // TS throws TraeUpstreamError; the Rust caller checks `error_message`
        self.with_error_message(message)
    }
    fn with_error_message(mut self, message: String) -> Self {
        self.text = format!("__TRAE_ERROR__:{message}");
        self
    }
}

fn event_name_from_payload(payload: &Value) -> Option<String> {
    payload
        .get("event")
        .or_else(|| payload.get("type"))
        .or_else(|| payload.get("name"))
        .and_then(Value::as_str)
        .map(|s| s.to_lowercase())
}

fn is_error_payload(payload: &Value) -> bool {
    if payload.is_null() {
        return false;
    }
    if let Value::String(s) = payload {
        return regex::Regex::new(r"(?i)unauthorized|auth|error|quota|rate limit")
            .unwrap()
            .is_match(s);
    }
    let code = payload
        .get("code")
        .or_else(|| payload.get("Code"))
        .or_else(|| payload.pointer("/error/code"));
    if let Some(c) = code
        && !c.is_null()
        && !(c.as_i64() == Some(0) || c.as_str().is_some_and(|s| matches!(s, "0" | "OK" | "ok")))
    {
        return true;
    }
    let ty = payload
        .get("type")
        .or_else(|| payload.get("event"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    ty == "error" || (payload.get("error").is_some() && payload.get("choices").is_none())
}

fn extract_text_from_payload(payload: &Value) -> Option<String> {
    if payload.is_null() || payload.is_string() {
        return None;
    }
    let candidates = [
        payload.get("text"),
        payload.get("content"),
        payload.get("delta"),
        payload.get("answer"),
        payload.get("output"),
        payload.get("response"),
        payload.pointer("/delta/content"),
        payload.pointer("/delta/text"),
        payload.pointer("/delta/message/content"),
        payload.pointer("/message/content"),
        payload.pointer("/data/text"),
        payload.pointer("/data/content"),
        payload.pointer("/data/delta"),
        payload.pointer("/data/delta/content"),
        payload.pointer("/data/delta/text"),
        payload.pointer("/data/answer"),
        payload.pointer("/data/output"),
        payload.pointer("/data/response"),
        payload.pointer("/choices/0/delta/content"),
        payload.pointer("/choices/0/message/content"),
        payload.pointer("/Result/text"),
        payload.pointer("/Result/content"),
        payload.pointer("/result/text"),
        payload.pointer("/result/content"),
    ];
    candidates
        .iter()
        .flatten()
        .find_map(|v| stringify_content(v))
}

fn stringify_content(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Array(arr) => {
            let joined: String = arr
                .iter()
                .filter_map(|item| match item {
                    Value::String(s) => Some(s.clone()),
                    _ => item
                        .get("text")
                        .or_else(|| item.get("content"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
                .collect();
            (!joined.is_empty()).then_some(joined)
        }
        _ => None,
    }
}

fn append_delta(current: &str, chunk: &str) -> String {
    if current.is_empty() {
        return chunk.to_string();
    }
    if chunk.starts_with(current) && chunk.len() > current.len() {
        return chunk.to_string();
    }
    format!("{current}{chunk}")
}
