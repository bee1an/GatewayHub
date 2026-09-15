//! TraeWork chat pipeline — port of `converters.ts`, `rawChat.ts` and
//! `streaming.ts`: message/tool payload conversion, llm_utils_chat SSE
//! stream, and output converters to OpenAI/Anthropic shapes.

use std::collections::HashMap;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::protocol::{SseParser, extract_text};
use crate::providers::kiro_convert::estimate_tokens;
use crate::providers::traework_auth::DEFAULT_TRAEWORK_FUNCTION;
use crate::providers::traework_auth::{
    TraeWorkHeaderSettings, build_traework_headers, normalize_traework_model,
};
use crate::types::{AccountFile, UsageMeta};
use crate::types::{UsageSink, UsageStats};

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
) -> Value {
    let config_name = normalize_traework_model(model);
    let messages = if format == "openai" {
        openai_to_traework_messages(body)
    } else {
        anthropic_to_traework_messages(body)
    };
    let mut payload = json!({
        "messages": messages,
        "function": if function.is_empty() { DEFAULT_TRAEWORK_FUNCTION } else { function },
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
        let url = format!("{}{}", base_url.trim_end_matches('/'), raw_chat_path);
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

// ---------------------------------------------------------------------------
// tool-call accumulator (rawChat.ts mergeToolCalls)
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ToolCallAcc {
    id: Option<String>,
    index: Option<u64>,
    name: Option<String>,
    arguments_text: String,
    input: Option<Value>,
}

fn merge_tool_calls(value: Option<&Value>, acc: &mut HashMap<String, ToolCallAcc>) {
    for item in as_array(value) {
        if !item.is_object() {
            continue;
        }
        let index = item.get("index").and_then(Value::as_u64);
        let id = pick_string_v(&[item.get("id"), item.get("tool_call_id")]);
        let key = if !id.is_empty() {
            id.clone()
        } else if let Some(i) = index {
            format!("index:{i}")
        } else {
            format!("item:{}", acc.len())
        };
        let entry = acc.entry(key).or_default();
        if !id.is_empty() {
            entry.id = Some(id);
        }
        if let Some(i) = index {
            entry.index = Some(i);
        }
        let name = pick_string_v(&[
            item.pointer("/function_call/name"),
            item.pointer("/function/name"),
            item.get("name"),
        ]);
        if !name.is_empty() {
            entry.name = Some(name);
        }
        let args = item
            .pointer("/function_call/arguments")
            .or_else(|| item.pointer("/function/arguments"))
            .or_else(|| item.get("arguments"));
        if let Some(args) = args
            && !args.is_null()
        {
            let arg_text = stringify_args(args);
            if item
                .pointer("/function_call/partial")
                .and_then(Value::as_bool)
                == Some(false)
                || entry.arguments_text.is_empty()
            {
                entry.arguments_text = arg_text;
            } else {
                entry.arguments_text.push_str(&arg_text);
            }
            if args.is_object() {
                entry.input = Some(args.clone());
            }
        }
    }
}

fn finalize_tool_calls(acc: HashMap<String, ToolCallAcc>) -> Vec<TraeWorkToolCall> {
    let mut entries: Vec<ToolCallAcc> = acc.into_values().collect();
    entries.sort_by_key(|e| e.index.unwrap_or(0));
    entries
        .into_iter()
        .filter(|e| e.name.as_deref().is_some_and(|n| !n.is_empty()))
        .map(|e| TraeWorkToolCall {
            id: e.id,
            name: e.name.unwrap_or_default(),
            input: e.input.unwrap_or_else(|| parse_args(&e.arguments_text)),
            arguments_text: (!e.arguments_text.is_empty()).then_some(e.arguments_text),
        })
        .collect()
}

fn parse_args(value: &str) -> Value {
    if value.is_empty() {
        return json!({});
    }
    serde_json::from_str(value).unwrap_or_else(|_| json!({ "arguments": value }))
}

fn extract_usage_stats(payload: &Value) -> Option<UsageStats> {
    if !payload.is_object() {
        return None;
    }
    let raw = payload
        .get("token_usage")
        .or_else(|| payload.get("usage"))
        .unwrap_or(payload);
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
    let input = num(&["prompt_tokens", "input_tokens", "promptTokens"]).unwrap_or(0);
    let output = num(&["completion_tokens", "output_tokens", "completionTokens"]).unwrap_or(0);
    if input == 0 && output == 0 {
        return None;
    }
    Some(UsageStats {
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: num(&["cache_read_input_tokens", "cache_read_tokens"]),
        cache_write5m_tokens: num(&["cache_creation_input_tokens"]),
        estimated: Some(false),
        ..Default::default()
    })
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
    payload.get("error").is_some_and(|e| e.is_object()) && payload.get("choices").is_none()
}

fn stringify_payload(payload: &Value) -> String {
    payload
        .get("rawText")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(payload).unwrap_or_else(|_| "null".into()))
}

fn format_upstream_error(payload: &Value) -> String {
    if payload.is_object() {
        let code = payload
            .get("code")
            .or_else(|| payload.pointer("/error/code"));
        let message = payload
            .get("message")
            .or_else(|| payload.pointer("/error/message"))
            .or_else(|| payload.get("error"))
            .and_then(Value::as_str)
            .unwrap_or("");
        return format!(
            "TraeWork upstream error{}: {}",
            code.map(|c| format!(" {}", c.to_string().trim_matches('"')))
                .unwrap_or_default(),
            message
        );
    }
    format!("TraeWork upstream error: {payload}")
}

// ---------------------------------------------------------------------------
// streaming.ts — output converters
// ---------------------------------------------------------------------------

fn sse_data(v: &Value) -> String {
    format!(
        "data: {}\n\n",
        serde_json::to_string(v).unwrap_or_else(|_| "{}".into())
    )
}
fn sse_event(event: &str, data: &Value) -> String {
    format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(data).unwrap_or_else(|_| "{}".into())
    )
}
fn to_openai_usage(u: &UsageStats) -> Value {
    let prompt = u.input_tokens;
    let completion = u.output_tokens;
    json!({ "prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion })
}
fn to_anthropic_usage(u: &UsageStats) -> Value {
    json!({ "input_tokens": u.input_tokens, "output_tokens": u.output_tokens })
}
fn estimated_usage(input_body: &Value, output: &str) -> UsageStats {
    UsageStats {
        input_tokens: estimate_tokens(input_body),
        output_tokens: estimate_tokens(&json!(output)),
        estimated: Some(true),
        ..Default::default()
    }
}
fn normalize_tool_input(input: &Value) -> Value {
    match input {
        Value::Null => json!({}),
        Value::Object(_) => input.clone(),
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({ "arguments": s })),
        other => json!({ "value": other }),
    }
}

/// `openAiSseFromEvents`.
pub fn openai_sse_from_events<S>(
    events: S,
    model: String,
    input_body: Value,
    on_usage: Option<UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<TraeWorkStreamEvent, anyhow::Error>> + Send,
{
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = crate::responses_api::now_secs();
    async_stream::stream! {
        let chunk = |delta: Value, finish: Option<&str>, usage: Option<Value>| {
            let mut v = json!({
                "id": id, "object": "chat.completion.chunk", "created": created,
                "model": model,
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            });
            if let Some(u) = usage {
                v["usage"] = u;
            }
            sse_data(&v)
        };
        yield chunk(json!({"role":"assistant"}), None, None);
        let mut usage: Option<UsageStats> = None;
        let mut finish_reason = "stop".to_string();
        let mut saw_tool_calls = false;
        let mut text = String::new();
        let mut events = Box::pin(events);
        while let Some(item) = events.next().await {
            let Ok(item) = item else {
                let e = item.err().unwrap();
                yield sse_data(&json!({"error":{"message":e.to_string(),"type":"gateway_error","code":"traework_error"}}));
                yield "data: [DONE]\n\n".to_string();
                return;
            };
            let payload = item.data;
            if item.event == "output" && payload.is_object() {
                let mut delta = json!({});
                if let Some(content) = payload.get("response").and_then(Value::as_str)
                    && !content.is_empty()
                {
                    delta["content"] = json!(content);
                    text.push_str(content);
                }
                if let Some(r) = payload.get("reasoning_content").and_then(Value::as_str)
                    && !r.is_empty()
                {
                    delta["reasoning_content"] = json!(r);
                }
                let tcs = to_openai_tool_call_deltas(payload.get("tool_calls"));
                if let Some(tcs) = tcs
                    && !tcs.is_empty()
                {
                    delta["tool_calls"] = Value::Array(tcs);
                    saw_tool_calls = true;
                }
                if !delta.as_object().unwrap().is_empty() {
                    yield chunk(delta, None, None);
                }
                continue;
            }
            if item.event == "token_usage" {
                usage = extract_usage_stats(&payload).or(usage);
                continue;
            }
            if item.event == "done" {
                if let Some(fr) = payload.get("finish_reason").and_then(Value::as_str)
                    && !fr.is_empty()
                {
                    finish_reason = fr.to_string();
                }
                continue;
            }
            if item.event == "error" {
                yield sse_data(&json!({"error":{"message":format_upstream_error(&payload),"type":"upstream_error","code":"traework_error"}}));
                yield "data: [DONE]\n\n".to_string();
                return;
            }
        }
        let final_usage = usage.unwrap_or_else(|| estimated_usage(&input_body, &text));
        if let Some(sink) = &on_usage {
            sink(final_usage.clone(), UsageMeta {
                account_id: Some(account_id),
                model: Some(model.clone()),
                provider: Some("traework".into()),
            });
        }
        yield chunk(
            json!({}),
            Some(if saw_tool_calls { "tool_calls" } else { &finish_reason }),
            Some(to_openai_usage(&final_usage)),
        );
        yield "data: [DONE]\n\n".to_string();
    }
}

/// `anthropicSseFromEvents` — thinking/text/tool_use block sequencing.
#[allow(unused_assignments)]
pub fn anthropic_sse_from_events<S>(
    events: S,
    model: String,
    input_body: Value,
    on_usage: Option<UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<TraeWorkStreamEvent, anyhow::Error>> + Send,
{
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    async_stream::stream! {
        yield sse_event("message_start", &json!({
            "type": "message_start",
            "message": {
                "id": id, "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        }));
        let mut usage: Option<UsageStats> = None;
        let mut finish_reason = "end_turn".to_string();
        let mut block_index: i64 = -1;
        let mut open_kind = "";
        let mut open_tool_blocks: HashMap<u64, i64> = HashMap::new();
        let mut text = String::new();
        let mut events = Box::pin(events);

        macro_rules! close_block {
            () => {{
                if !open_kind.is_empty() {
                    yield sse_event("content_block_stop", &json!({
                        "type": "content_block_stop", "index": block_index,
                    }));
                    open_kind = "";
                }
            }};
        }

        while let Some(item) = events.next().await {
            let Ok(item) = item else {
                let e = item.err().unwrap();
                yield sse_event("error", &json!({
                    "type": "error",
                    "error": {"type":"api_error","message":e.to_string()},
                }));
                return;
            };
            let payload = item.data;
            if item.event == "output" && payload.is_object() {
                if let Some(reasoning) = payload.get("reasoning_content").and_then(Value::as_str)
                    && !reasoning.is_empty()
                {
                    if open_kind != "thinking" {
                        close_block!();
                        block_index += 1;
                        open_kind = "thinking";
                        yield sse_event("content_block_start", &json!({
                            "type": "content_block_start", "index": block_index,
                            "content_block": {"type":"thinking","thinking":"","signature":""},
                        }));
                    }
                    yield sse_event("content_block_delta", &json!({
                        "type": "content_block_delta", "index": block_index,
                        "delta": {"type":"thinking_delta","thinking":reasoning},
                    }));
                }
                if let Some(content) = payload.get("response").and_then(Value::as_str)
                    && !content.is_empty()
                {
                    if open_kind != "text" {
                        close_block!();
                        block_index += 1;
                        open_kind = "text";
                        yield sse_event("content_block_start", &json!({
                            "type": "content_block_start", "index": block_index,
                            "content_block": {"type":"text","text":""},
                        }));
                    }
                    text.push_str(content);
                    yield sse_event("content_block_delta", &json!({
                        "type": "content_block_delta", "index": block_index,
                        "delta": {"type":"text_delta","text":content},
                    }));
                }
                for call in as_array(payload.get("tool_calls")) {
                    if !call.is_object() {
                        continue;
                    }
                    let upstream_index = call.get("index").and_then(Value::as_u64).unwrap_or(0);
                    let name = pick_string_v(&[
                        call.pointer("/function_call/name"),
                        call.pointer("/function/name"),
                        call.get("name"),
                    ]);
                    let args = call
                        .pointer("/function_call/arguments")
                        .or_else(|| call.pointer("/function/arguments"))
                        .or_else(|| call.get("arguments"));
                    let assigned = match open_tool_blocks.get(&upstream_index) {
                        Some(i) => *i,
                        None => {
                            close_block!();
                            block_index += 1;
                            open_tool_blocks.insert(upstream_index, block_index);
                            let call_id = pick_string_v(&[call.get("id")]);
                            yield sse_event("content_block_start", &json!({
                                "type": "content_block_start", "index": block_index,
                                "content_block": {
                                    "type": "tool_use",
                                    "id": if call_id.is_empty() {
                                        format!("toolu_{}", uuid::Uuid::new_v4().simple())
                                    } else { call_id },
                                    "name": if name.is_empty() { "unknown".to_string() } else { name.clone() },
                                    "input": {},
                                },
                            }));
                            block_index
                        }
                    };
                    if let Some(args) = args
                        && !args.is_null()
                    {
                        let arg_text = stringify_args(args);
                        if !arg_text.is_empty() {
                            yield sse_event("content_block_delta", &json!({
                                "type": "content_block_delta", "index": assigned,
                                "delta": {"type":"input_json_delta","partial_json":arg_text},
                            }));
                        }
                    }
                }
                continue;
            }
            if item.event == "token_usage" {
                usage = extract_usage_stats(&payload).or(usage);
                continue;
            }
            if item.event == "done" {
                if let Some(fr) = payload.get("finish_reason").and_then(Value::as_str)
                    && !fr.is_empty()
                {
                    finish_reason = if fr == "stop" { "end_turn".into() } else { fr.to_string() };
                }
                continue;
            }
            if item.event == "error" {
                yield sse_event("error", &json!({
                    "type": "error",
                    "error": {"type":"api_error","message":format_upstream_error(&payload)},
                }));
                return;
            }
        }
        close_block!();
        let final_usage = usage.unwrap_or_else(|| estimated_usage(&input_body, &text));
        if let Some(sink) = &on_usage {
            sink(final_usage.clone(), UsageMeta {
                account_id: Some(account_id),
                model: Some(model.clone()),
                provider: Some("traework".into()),
            });
        }
        yield sse_event("message_delta", &json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": if !open_tool_blocks.is_empty() { "tool_use" } else { &finish_reason },
                "stop_sequence": null,
            },
            "usage": to_anthropic_usage(&final_usage),
        }));
        yield sse_event("message_stop", &json!({"type":"message_stop"}));
    }
}

fn to_openai_tool_call_deltas(value: Option<&Value>) -> Option<Vec<Value>> {
    let items = as_array(value);
    if items.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if !item.is_object() {
            continue;
        }
        let index = item
            .get("index")
            .and_then(Value::as_u64)
            .unwrap_or(i as u64);
        let name = pick_string_v(&[
            item.pointer("/function_call/name"),
            item.pointer("/function/name"),
            item.get("name"),
        ]);
        let args = item
            .pointer("/function_call/arguments")
            .or_else(|| item.pointer("/function/arguments"))
            .or_else(|| item.get("arguments"));
        let mut entry = json!({ "index": index, "type": "function" });
        let id = pick_string_v(&[item.get("id"), item.get("tool_call_id")]);
        if !id.is_empty() {
            entry["id"] = json!(id);
        }
        let mut f = json!({});
        if !name.is_empty() {
            f["name"] = json!(name);
        }
        if let Some(args) = args
            && !args.is_null()
        {
            f["arguments"] = match args {
                Value::String(s) => json!(s),
                other => json!(serde_json::to_string(other).unwrap_or_else(|_| "{}".into())),
            };
        }
        entry["function"] = f;
        out.push(entry);
    }
    (!out.is_empty()).then_some(out)
}

/// `openAiJsonFromResult`.
pub fn openai_json_from_result(
    result: &TraeWorkChatResult,
    model: &str,
    input_body: &Value,
    on_usage: Option<&UsageSink>,
    account_id: &str,
) -> Value {
    let usage = result
        .usage
        .clone()
        .unwrap_or_else(|| estimated_usage(input_body, &result.text));
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("traework".into()),
            },
        );
    }
    let has_tool_calls = !result.tool_calls.is_empty();
    let mut message = json!({
        "role": "assistant",
        "content": if result.text.is_empty() && has_tool_calls { Value::Null } else { json!(result.text) },
    });
    if !result.reasoning.is_empty() {
        message["reasoning_content"] = json!(result.reasoning);
    }
    if has_tool_calls {
        message["tool_calls"] = Value::Array(
            result
                .tool_calls
                .iter()
                .enumerate()
                .map(|(index, tc)| {
                    json!({
                        "index": index,
                        "id": tc.id.clone().unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple())),
                        "type": "function",
                        "function": {
                            "name": tc.name,
                            "arguments": tc.arguments_text.clone().unwrap_or_else(|| match &tc.input {
                                Value::String(s) => s.clone(),
                                other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
                            }),
                        },
                    })
                })
                .collect(),
        );
    }
    json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": crate::responses_api::now_secs(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": if has_tool_calls { "tool_calls" } else { result.finish_reason.as_deref().unwrap_or("stop") },
        }],
        "usage": to_openai_usage(&usage),
    })
}

/// `anthropicJsonFromResult`.
pub fn anthropic_json_from_result(
    result: &TraeWorkChatResult,
    model: &str,
    input_body: &Value,
    on_usage: Option<&UsageSink>,
    account_id: &str,
) -> Value {
    let usage = result
        .usage
        .clone()
        .unwrap_or_else(|| estimated_usage(input_body, &result.text));
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("traework".into()),
            },
        );
    }
    let mut content: Vec<Value> = Vec::new();
    if !result.reasoning.is_empty() {
        content.push(json!({"type":"thinking","thinking":result.reasoning,"signature":""}));
    }
    if !result.text.is_empty() {
        content.push(json!({"type":"text","text":result.text}));
    }
    for tc in &result.tool_calls {
        content.push(json!({
            "type": "tool_use",
            "id": tc.id.clone().unwrap_or_else(|| format!("toolu_{}", uuid::Uuid::new_v4().simple())),
            "name": tc.name,
            "input": normalize_tool_input(&tc.input),
        }));
    }
    if content.is_empty() {
        content.push(json!({"type":"text","text":""}));
    }
    json!({
        "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": if result.tool_calls.is_empty() { "end_turn" } else { "tool_use" },
        "stop_sequence": null,
        "usage": to_anthropic_usage(&usage),
    })
}
