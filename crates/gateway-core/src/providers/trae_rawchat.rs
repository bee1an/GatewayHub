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

// --- tool-call accumulation (openai + anthropic event shapes) ---------------

#[derive(Default)]
struct ToolCallAcc {
    entries: Vec<(String, ToolCallEntry)>,
}

#[derive(Default, Clone)]
struct ToolCallEntry {
    id: Option<String>,
    index: Option<u64>,
    name: Option<String>,
    arguments_text: String,
    input: Option<Value>,
}

impl ToolCallAcc {
    fn get_mut(&mut self, key: &str) -> &mut ToolCallEntry {
        if !self.entries.iter().any(|(k, _)| k == key) {
            self.entries
                .push((key.to_string(), ToolCallEntry::default()));
        }
        &mut self.entries.iter_mut().find(|(k, _)| k == key).unwrap().1
    }
    fn resolve_key(&self, id: &str, index: Option<u64>) -> String {
        if !id.is_empty() {
            return id.to_string();
        }
        if let Some(i) = index {
            for (key, item) in &self.entries {
                if item.index == Some(i) {
                    return key.clone();
                }
            }
            return format!("index:{i}");
        }
        format!("item:{}", self.entries.len())
    }
}

fn merge_tool_calls_from_payload(payload: &Value, acc: &mut ToolCallAcc) {
    if !payload.is_object() {
        return;
    }
    for choice in as_array(payload.get("choices")) {
        merge_openai_tool_calls(choice.pointer("/delta/tool_calls"), acc, false);
        merge_openai_tool_calls(choice.pointer("/message/tool_calls"), acc, true);
    }
    merge_openai_tool_calls(payload.get("tool_calls"), acc, true);
    merge_openai_tool_calls(payload.pointer("/data/tool_calls"), acc, true);
    merge_anthropic_tool_uses(payload.get("content"), acc);
    merge_anthropic_tool_uses(payload.pointer("/message/content"), acc);
    merge_anthropic_tool_uses(payload.pointer("/data/content"), acc);
    merge_anthropic_tool_event(payload, acc);
    if let Some(data) = payload.get("data") {
        merge_anthropic_tool_event(data, acc);
    }
}

fn merge_openai_tool_calls(value: Option<&Value>, acc: &mut ToolCallAcc, complete: bool) {
    for item in as_array(value) {
        if !item.is_object() {
            continue;
        }
        let index = item.get("index").and_then(Value::as_u64);
        let id = pick_str(&item, &["id", "tool_call_id"]);
        let key = acc.resolve_key(&id, index);
        let entry = acc.get_mut(&key);
        if !id.is_empty() {
            entry.id = Some(id);
        }
        if let Some(i) = index {
            entry.index = Some(i);
        }
        let name = pick_str(&item, &["name"]);
        let name = if name.is_empty() {
            item.pointer("/function/name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        } else {
            name
        };
        if !name.is_empty() {
            entry.name = Some(name);
        }
        let args = item
            .pointer("/function/arguments")
            .or_else(|| item.get("arguments"))
            .or_else(|| item.get("input"));
        if let Some(args) = args {
            let text = stringify_arguments(args);
            if complete {
                entry.arguments_text = text;
            } else {
                entry.arguments_text.push_str(&text);
            }
            if args.is_object() {
                entry.input = Some(args.clone());
            }
        }
    }
}

fn merge_anthropic_tool_uses(value: Option<&Value>, acc: &mut ToolCallAcc) {
    for item in as_array(value) {
        if item.get("type").and_then(Value::as_str) != Some("tool_use") {
            continue;
        }
        let id = pick_str(&item, &["id", "tool_use_id"]);
        let key = if id.is_empty() {
            format!("item:{}", acc.entries.len())
        } else {
            id.clone()
        };
        let entry = acc.get_mut(&key);
        entry.id = (!id.is_empty()).then_some(id);
        entry.name = Some(pick_str(&item, &["name"]));
        entry.arguments_text = stringify_arguments(item.get("input").unwrap_or(&json!({})));
        entry.input = Some(item.get("input").cloned().unwrap_or(json!({})));
    }
}

fn merge_anthropic_tool_event(payload: &Value, acc: &mut ToolCallAcc) {
    if !payload.is_object() {
        return;
    }
    let ty = payload
        .get("type")
        .or_else(|| payload.get("event"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    let index = payload.get("index").and_then(Value::as_u64);
    if ty == "content_block_start"
        && payload
            .pointer("/content_block/type")
            .and_then(Value::as_str)
            == Some("tool_use")
    {
        let block = &payload["content_block"];
        let id = pick_str(&block.clone(), &["id", "tool_use_id"]);
        let key = acc.resolve_key(&id, index);
        let entry = acc.get_mut(&key);
        if !id.is_empty() {
            entry.id = Some(id);
        }
        if let Some(i) = index {
            entry.index = Some(i);
        }
        let name = pick_str(&block.clone(), &["name"]);
        if !name.is_empty() {
            entry.name = Some(name);
        }
        if let Some(input) = block.get("input")
            && has_meaningful_input(input)
        {
            entry.input = Some(input.clone());
            entry.arguments_text = stringify_arguments(input);
        }
    } else if ty == "content_block_delta"
        && payload.pointer("/delta/type").and_then(Value::as_str) == Some("input_json_delta")
    {
        let key = acc.resolve_key("", index);
        let entry = acc.get_mut(&key);
        if let Some(i) = index {
            entry.index = Some(i);
        }
        entry.input = None;
        entry.arguments_text.push_str(&pick_str(
            payload.get("delta").unwrap_or(&Value::Null),
            &["partial_json"],
        ));
    }
}

fn has_meaningful_input(input: &Value) -> bool {
    match input {
        Value::Null => false,
        Value::Object(o) => !o.is_empty(),
        _ => true,
    }
}

fn finalize_tool_calls(acc: ToolCallAcc) -> Vec<GatewayToolCall> {
    let mut entries = acc.entries;
    entries.sort_by_key(|(_, e)| e.index.unwrap_or(0));
    entries
        .into_iter()
        .filter(|(_, e)| e.name.as_deref().is_some_and(|n| !n.is_empty()))
        .map(|(_, e)| GatewayToolCall {
            id: e.id,
            name: e.name.unwrap_or_default(),
            input: e
                .input
                .unwrap_or_else(|| parse_arguments(&e.arguments_text)),
        })
        .collect()
}

fn as_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(arr)) => arr.clone(),
        Some(v) if !v.is_null() => vec![v.clone()],
        _ => Vec::new(),
    }
}

fn pick_str(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|k| v.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

fn stringify_arguments(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
    }
}

fn parse_arguments(value: &str) -> Value {
    if value.is_empty() {
        return json!({});
    }
    serde_json::from_str(value).unwrap_or_else(|_| json!({ "arguments": value }))
}

fn extract_usage(payload: &Value) -> Option<UsageStats> {
    let raw = payload
        .get("usage")
        .or_else(|| payload.get("token_usage"))
        .or_else(|| payload.get("tokenUsage"))
        .or_else(|| payload.pointer("/data/usage"))
        .or_else(|| payload.pointer("/data/token_usage"))
        .or_else(|| payload.pointer("/metadata/usage"))?;
    if !raw.is_object() {
        return None;
    }
    let num = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| raw.get(*k))
            .filter_map(|v| {
                v.as_f64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            })
            .find(|n| *n > 0.0)
            .map(|n| n as u64)
    };
    let input = num(&[
        "input_tokens",
        "prompt_tokens",
        "inputTokens",
        "promptTokens",
    ])
    .unwrap_or(0);
    let output = num(&[
        "output_tokens",
        "completion_tokens",
        "outputTokens",
        "completionTokens",
    ])
    .unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    Some(UsageStats {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: num(&["cache_read_tokens", "cached_tokens"]),
        cache_write5m_tokens: num(&["cache_write_5m_tokens"]),
        cache_write1h_tokens: num(&["cache_write_1h_tokens"]),
        credits: raw
            .get("credits")
            .or_else(|| raw.get("fee_usage"))
            .or_else(|| raw.get("feeUsage"))
            .and_then(Value::as_f64),
        estimated: Some(false),
    })
}

fn stringify_payload(payload: &Value) -> String {
    payload
        .get("rawText")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(payload).unwrap_or_else(|_| "null".into()))
}

// ---------------------------------------------------------------------------
// text → output converters (streaming.ts) — trae "stream" collects first,
// then emits one text blob through these.
// ---------------------------------------------------------------------------

/// `openAiSseFromText` — single-blob SSE emission.
pub fn openai_sse_from_text(
    text: &str,
    model: &str,
    _input_body: &Value,
    upstream_usage: Option<&UsageStats>,
    tool_calls: &[GatewayToolCall],
) -> String {
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = crate::responses_api::now_secs();
    let mut out = String::new();
    let mut first_delta = json!({ "role": "assistant" });
    if !text.is_empty() {
        first_delta["content"] = json!(text);
    }
    if !tool_calls.is_empty() {
        first_delta["tool_calls"] = Value::Array(
            crate::providers::windsurf_stream::to_openai_tool_calls(tool_calls),
        );
    }
    out.push_str(&format!(
        "data: {}\n\n",
        serde_json::to_string(&json!({
            "id": id, "object": "chat.completion.chunk", "created": created,
            "model": model,
            "choices": [{"index": 0, "delta": first_delta, "finish_reason": null}],
        }))
        .unwrap_or_default()
    ));
    let usage = upstream_usage.cloned().unwrap_or_else(|| UsageStats {
        input_tokens: estimate_tokens(_input_body),
        output_tokens: estimate_tokens(&json!(text)),
        estimated: Some(true),
        ..Default::default()
    });
    out.push_str(&format!(
        "data: {}\n\n",
        serde_json::to_string(&json!({
            "id": id, "object": "chat.completion.chunk", "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" },
            }],
            "usage": to_openai_usage(&usage),
        }))
        .unwrap_or_default()
    ));
    out.push_str("data: [DONE]\n\n");
    out
}

/// `anthropicSseFromText`.
pub fn anthropic_sse_from_text(
    text: &str,
    model: &str,
    input_body: &Value,
    upstream_usage: Option<&UsageStats>,
    tool_calls: &[GatewayToolCall],
) -> String {
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let mut out = String::new();
    let push = |out: &mut String, event: &str, data: &Value| {
        out.push_str(&format!(
            "event: {event}\ndata: {}\n\n",
            serde_json::to_string(data).unwrap_or_default()
        ));
    };
    push(
        &mut out,
        "message_start",
        &json!({
            "type": "message_start",
            "message": {
                "id": id, "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        }),
    );
    let blocks = crate::providers::windsurf_stream::to_anthropic_content_blocks(text, tool_calls);
    for (i, block) in blocks.iter().enumerate() {
        push(
            &mut out,
            "content_block_start",
            &json!({
                "type": "content_block_start", "index": i,
                "content_block": if block["type"] == "tool_use" {
                    json!({"type":"tool_use","id":block["id"],"name":block["name"],"input":{}})
                } else {
                    json!({"type":"text","text":""})
                },
            }),
        );
        if block["type"] == "text" && block["text"].as_str().is_some_and(|t| !t.is_empty()) {
            push(
                &mut out,
                "content_block_delta",
                &json!({
                    "type": "content_block_delta", "index": i,
                    "delta": {"type":"text_delta","text":block["text"]},
                }),
            );
        } else if block["type"] == "tool_use" {
            push(
                &mut out,
                "content_block_delta",
                &json!({
                    "type": "content_block_delta", "index": i,
                    "delta": {"type":"input_json_delta","partial_json":serde_json::to_string(&block["input"]).unwrap_or_else(|_|"{}".into())},
                }),
            );
        }
        push(
            &mut out,
            "content_block_stop",
            &json!({
                "type": "content_block_stop", "index": i,
            }),
        );
    }
    let usage = upstream_usage.cloned().unwrap_or_else(|| UsageStats {
        input_tokens: estimate_tokens(input_body),
        output_tokens: estimate_tokens(&json!(text)),
        estimated: Some(true),
        ..Default::default()
    });
    push(
        &mut out,
        "message_delta",
        &json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": if tool_calls.is_empty() { "end_turn" } else { "tool_use" },
                "stop_sequence": null,
            },
            "usage": to_anthropic_usage(&usage),
        }),
    );
    push(&mut out, "message_stop", &json!({"type":"message_stop"}));
    out
}

fn to_openai_usage(u: &UsageStats) -> Value {
    let cached = u.cache_read_tokens.unwrap_or(0);
    let cache_write = u.cache_write5m_tokens.unwrap_or(0) + u.cache_write1h_tokens.unwrap_or(0);
    let prompt = u.input_tokens + cached + cache_write;
    let completion = u.output_tokens;
    let mut out = json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    });
    if cached > 0 {
        out["prompt_tokens_details"] = json!({ "cached_tokens": cached });
    }
    out
}

fn to_anthropic_usage(u: &UsageStats) -> Value {
    let mut out = json!({
        "input_tokens": u.input_tokens,
        "output_tokens": u.output_tokens,
    });
    if let Some(c) = u.cache_read_tokens {
        out["cache_read_input_tokens"] = json!(c);
    }
    let cache_write = u.cache_write5m_tokens.unwrap_or(0) + u.cache_write1h_tokens.unwrap_or(0);
    if cache_write > 0 {
        out["cache_creation_input_tokens"] = json!(cache_write);
    }
    out
}
