//! TraeWork chat pipeline — port of `converters.ts`, `rawChat.ts` and
//! `streaming.ts`: message/tool payload conversion, llm_utils_chat SSE
//! stream, and output converters to OpenAI/Anthropic shapes.

use std::collections::HashMap;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::protocol::{SseParser, extract_text};
use crate::providers::kiro_convert::estimate_tokens;
use crate::providers::traework_auth::{DEFAULT_TRAEWORK_FUNCTION, DEFAULT_TRAEWORK_VERSION_CODE};
use crate::providers::traework_auth::{
    TraeWorkHeaderSettings, build_traework_headers, normalize_traework_model,
};
use crate::types::{AccountFile, UsageMeta};
use crate::types::{UsageSink, UsageStats};

mod out;
pub use out::*;

// ---------------------------------------------------------------------------
// converters.ts
// ---------------------------------------------------------------------------

fn text_parts(text: &str) -> Value {
    json!([{ "type": "text", "text": text }])
}

fn stringify_args(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
    }
}

fn pick_string_v(values: &[Option<&Value>]) -> String {
    values
        .iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

fn as_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(arr)) => arr.clone(),
        Some(v) if !v.is_null() => vec![v.clone()],
        _ => Vec::new(),
    }
}

pub fn openai_to_traework_messages(body: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for msg in body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = match msg.get("role").and_then(Value::as_str) {
            Some("system" | "developer") => "system",
            Some(r @ ("user" | "assistant" | "tool")) => r,
            _ => continue,
        };
        let text = extract_message_text(msg.get("content").unwrap_or(&Value::Null));
        if role == "tool" {
            let mut m = json!({ "role": "tool", "content": text_parts(&text) });
            let id = pick_string_v(&[msg.get("tool_call_id")]);
            if !id.is_empty() {
                m["tool_call_id"] = json!(id);
            }
            out.push(m);
            continue;
        }
        let tool_calls = to_upstream_tool_calls(msg.get("tool_calls"));
        if text.is_empty() && tool_calls.is_none() {
            continue;
        }
        let mut m = json!({ "role": role, "content": text_parts(&text) });
        if let Some(tc) = tool_calls {
            m["tool_calls"] = tc;
        }
        out.push(m);
    }
    out
}

pub fn anthropic_to_traework_messages(body: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let system = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        other => extract_text(other.unwrap_or(&Value::Null)),
    };
    if !system.is_empty() {
        out.push(json!({ "role": "system", "content": text_parts(&system) }));
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
        let mut text_parts_out: Vec<String> = Vec::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        for block in as_array(msg.get("content")) {
            match &block {
                Value::String(s) => text_parts_out.push(s.clone()),
                Value::Object(_) => match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            text_parts_out.push(t.to_string());
                        }
                    }
                    Some("tool_use") => {
                        tool_calls.push(json!({
                            "id": pick_string_v(&[block.get("id")]),
                            "type": "function",
                            "function_call": {
                                "name": pick_string_v(&[block.get("name")]),
                                "arguments": stringify_args(block.get("input").unwrap_or(&json!({}))),
                            },
                        }));
                    }
                    Some("tool_result") => {
                        if !text_parts_out.is_empty() {
                            out.push(json!({
                                "role": "user",
                                "content": text_parts(&text_parts_out.join("\n")),
                            }));
                            text_parts_out.clear();
                        }
                        let mut m = json!({
                            "role": "tool",
                            "content": text_parts(&anthropic_tool_result_text(block.get("content").unwrap_or(&Value::Null))),
                        });
                        let id = pick_string_v(&[block.get("tool_use_id")]);
                        if !id.is_empty() {
                            m["tool_call_id"] = json!(id);
                        }
                        out.push(m);
                    }
                    Some("image") => text_parts_out.push("[image]".into()),
                    _ => {}
                },
                _ => {}
            }
        }
        let text = text_parts_out
            .iter()
            .filter(|s| !s.is_empty())
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() || !tool_calls.is_empty() {
            let mut m = json!({ "role": role, "content": text_parts(&text) });
            if !tool_calls.is_empty() {
                m["tool_calls"] = Value::Array(tool_calls);
            }
            out.push(m);
        }
    }
    out
}

/// `buildTraeWorkTools` — upstream Go struct wants parameters as a JSON
/// *string*, not an object.
pub fn build_traework_tools(body: &Value, format: &str) -> Option<Value> {
    let mut tools = Vec::new();
    for tool in body
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if !tool.is_object() {
            continue;
        }
        let fnv = if format == "openai" {
            tool.get("function").unwrap_or(&tool)
        } else {
            &tool
        };
        let name = pick_string_v(&[fnv.get("name"), tool.get("name")]);
        if name.is_empty() {
            continue;
        }
        let schema = fnv
            .get("parameters")
            .or_else(|| tool.get("input_schema"))
            .or_else(|| tool.get("parameters"))
            .cloned()
            .unwrap_or(json!({}));
        tools.push(json!({
            "type": "function",
            "function": {
                "name": name,
                "description": pick_string_v(&[fnv.get("description"), tool.get("description")]),
                "parameters": stringify_args(&schema),
            },
        }));
    }
    (!tools.is_empty()).then(|| Value::Array(tools))
}

/// `buildTraeWorkChatPayload`.
pub fn build_traework_chat_payload(
    model: &str,
    body: &Value,
    format: &str,
    function: &str,
    header: &TraeWorkHeaderSettings,
) -> Value {
    let config_name = normalize_traework_model(model);
    let messages = if format == "openai" {
        openai_to_traework_messages(body)
    } else {
        anthropic_to_traework_messages(body)
    };
    // Upstream binds required body fields: usage/app_id/app_version_code.
    // Chat configs in the catalog carry usage="chat_completion"; the version
    // code must unmarshal into an int64 — settings carry it as a string.
    let app_version_code = header
        .version_code
        .parse::<i64>()
        .unwrap_or_else(|_| DEFAULT_TRAEWORK_VERSION_CODE.parse().unwrap_or(0));
    let mut payload = json!({
        "messages": messages,
        "function": if function.is_empty() { DEFAULT_TRAEWORK_FUNCTION } else { function },
        "usage": "chat_completion",
        "app_id": header.app_id,
        "app_version_code": app_version_code,
        "stream": true,
        "config_name": config_name,
        "model": config_name,
        "max_tokens": body.get("max_tokens").or_else(|| body.get("max_completion_tokens")),
        "temperature": body.get("temperature"),
        "top_p": body.get("top_p"),
        "presence_penalty": body.get("presence_penalty"),
        "frequency_penalty": body.get("frequency_penalty"),
        "stop": body.get("stop").or_else(|| body.get("stop_sequences")),
        "seed": body.get("seed"),
        "n": body.get("n"),
    });
    if let Some(tools) = build_traework_tools(body, format) {
        payload["tools"] = tools;
    }
    prune_undefined(payload)
}

fn to_upstream_tool_calls(value: Option<&Value>) -> Option<Value> {
    let items = as_array(value);
    if items.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if !item.is_object() {
            continue;
        }
        let name = pick_string_v(&[
            item.pointer("/function_call/name"),
            item.pointer("/function/name"),
            item.get("name"),
        ]);
        if name.is_empty() {
            continue;
        }
        let args = item
            .pointer("/function_call/arguments")
            .or_else(|| item.pointer("/function/arguments"))
            .or_else(|| item.get("arguments"))
            .cloned()
            .unwrap_or(json!({}));
        out.push(json!({
            "index": item.get("index").and_then(Value::as_u64).unwrap_or(i as u64),
            "id": pick_string_v(&[item.get("id"), item.get("tool_call_id")]),
            "type": "function",
            "function_call": { "name": name, "arguments": stringify_args(&args) },
        }));
    }
    (!out.is_empty()).then(|| Value::Array(out))
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
                    _ => extract_text(part),
                },
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => extract_text(other),
    }
}

fn anthropic_tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .map(|block| match block {
                Value::String(s) => s.clone(),
                _ if block.get("type").and_then(Value::as_str) == Some("text") => block
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                _ => extract_text(block),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => extract_text(other),
    }
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
// rawChat.ts — upstream event stream
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct TraeWorkStreamEvent {
    pub event: String,
    pub data: Value,
}

#[derive(Debug, Clone)]
pub struct TraeWorkToolCall {
    pub id: Option<String>,
    pub name: String,
    pub input: Value,
    pub arguments_text: Option<String>,
}

#[derive(Debug, Default)]
pub struct TraeWorkChatResult {
    pub text: String,
    pub reasoning: String,
    pub usage: Option<UsageStats>,
    pub tool_calls: Vec<TraeWorkToolCall>,
    pub finish_reason: Option<String>,
    pub session_id: Option<String>,
}

/// `streamTraeWorkChat` — POST llm_utils_chat → event stream.
pub fn stream_traework_chat(
    http: reqwest::Client,
    base_url: String,
    raw_chat_path: String,
    header_settings: TraeWorkHeaderSettings,
    account: Option<AccountFile>,
    token: String,
    payload: Value,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
) -> impl Stream<Item = Result<TraeWorkStreamEvent, anyhow::Error>> + Send {
    async_stream::stream! {
        // Upstream requires `usage` as a QUERY param. `function` must stay in
        // the body — a `function` query param overrides the body value and the
        // query layer only accepts `chat` (which selects the old model catalog
        // and rejects chat_v3/solo_work_lite models with 4023).
        let url = format!(
            "{}{}?usage=chat_completion",
            base_url.trim_end_matches('/'),
            raw_chat_path
        );
        let mut req = http
            .post(&url)
            .timeout(first_token_timeout)
            .json(&payload);
        for (k, v) in build_traework_headers(&token, &header_settings, account.as_ref()) {
            req = req.header(k, v);
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => { yield Err(e.into()); return; }
        };
        let status = res.status().as_u16();
        let content_type = res
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if status >= 400 {
            let text = res.text().await.unwrap_or_default();
            yield Err(anyhow::anyhow!(
                "TraeWork chat failed: HTTP {status} {}",
                text.chars().take(800).collect::<String>()
            ));
            return;
        }
        if !content_type.contains("text/event-stream") {
            let text = res.text().await.unwrap_or_default();
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::String(text.clone()));
            if is_error_payload(&parsed) {
                yield Err(anyhow::anyhow!(
                    "TraeWork chat error: {}",
                    stringify_payload(&parsed).chars().take(800).collect::<String>()
                ));
                return;
            }
            yield Ok(TraeWorkStreamEvent { event: "output".into(), data: parsed });
            return;
        }
        let mut stream = res.bytes_stream();
        let mut parser = SseParser::default();
        loop {
            match tokio::time::timeout(streaming_read_timeout, stream.next()).await {
                Ok(Some(Ok(bytes))) => {
                    for (event, data) in parser.feed_blocks(&String::from_utf8_lossy(&bytes)) {
                        yield Ok(TraeWorkStreamEvent {
                            event: event.unwrap_or_else(|| "message".into()),
                            data: serde_json::from_str(data.trim()).unwrap_or(Value::String(data.trim().into())),
                        });
                    }
                }
                Ok(Some(Err(e))) => { yield Err(e.into()); return; }
                Ok(None) => break,
                Err(_) => {
                    yield Err(anyhow::anyhow!(
                        "TraeWork stream idle timeout after {}s without data",
                        streaming_read_timeout.as_secs()
                    ));
                    return;
                }
            }
        }
    }
}

/// `collectTraeWorkChat`.
pub async fn collect_traework_chat<S>(events: S) -> anyhow::Result<TraeWorkChatResult>
where
    S: Stream<Item = Result<TraeWorkStreamEvent, anyhow::Error>> + Send,
{
    let mut result = TraeWorkChatResult::default();
    let mut last_error: Option<Value> = None;
    let mut tool_acc: HashMap<String, ToolCallAcc> = HashMap::new();
    let mut events = Box::pin(events);
    while let Some(item) = events.next().await {
        let item = item?;
        let payload = item.data.clone();
        if item.event == "error" || is_error_payload(&payload) {
            last_error = Some(payload);
            continue;
        }
        if item.event == "metadata" && payload.is_object() {
            if let Some(s) = payload.get("session_id").and_then(Value::as_str)
                && !s.is_empty()
            {
                result.session_id = Some(s.to_string());
            }
            continue;
        }
        if item.event == "output" {
            if let Some(chunk) = payload.get("response").and_then(Value::as_str) {
                result.text.push_str(chunk);
            }
            if let Some(chunk) = payload.get("reasoning_content").and_then(Value::as_str) {
                result.reasoning.push_str(chunk);
            }
            merge_tool_calls(payload.get("tool_calls"), &mut tool_acc);
            continue;
        }
        if item.event == "token_usage" {
            if let Some(u) = extract_usage_stats(&payload) {
                result.usage = Some(u);
            }
            continue;
        }
        if item.event == "done"
            && let Some(fr) = payload.get("finish_reason").and_then(Value::as_str)
            && !fr.is_empty()
        {
            result.finish_reason = Some(fr.to_string());
        }
    }
    result.tool_calls = finalize_tool_calls(tool_acc);
    if let Some(err) = last_error
        && result.text.is_empty()
        && result.tool_calls.is_empty()
    {
        anyhow::bail!(
            "TraeWork stream error: {}",
            stringify_payload(&err)
                .chars()
                .take(800)
                .collect::<String>()
        );
    }
    Ok(result)
}
