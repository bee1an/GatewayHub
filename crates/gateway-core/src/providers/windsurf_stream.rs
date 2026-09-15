//! Windsurf output converters — port of `providers/windsurf/toolCalls.ts`
//! + `streaming.ts`. Cascade deltas → OpenAI/Anthropic SSE or JSON.

use futures::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::providers::kiro_convert::estimate_tokens;
use crate::providers::windsurf_cascade::WindsurfCascadeStreamEvent;
use crate::types::{UsageSink, UsageStats};

#[derive(Debug, Clone)]
pub struct GatewayToolCall {
    pub id: Option<String>,
    pub name: String,
    pub input: Value,
}

// ---------------------------------------------------------------------------
// toolCalls.ts
// ---------------------------------------------------------------------------

/// `splitInlineToolCalls` — pull `<tool_call>…</tool_call>` blocks out of
/// the model's plain-text response.
pub fn split_inline_tool_calls(text: &str) -> (String, Vec<GatewayToolCall>) {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let mut tool_calls = Vec::new();
    let cleaned = RE
        .get_or_init(|| regex::Regex::new(r"(?i)<tool_call>\s*([\s\S]*?)\s*</tool_call>").unwrap())
        .replace_all(text, |caps: &regex::Captures| {
            tool_calls.extend(normalize_inline_tool_calls(&caps[1]));
            ""
        });
    (cleaned.trim().to_string(), dedupe_tool_calls(tool_calls))
}

pub fn normalize_gateway_tool_calls(values: Vec<Value>) -> Vec<GatewayToolCall> {
    let mut out = Vec::new();
    for (i, v) in values.iter().enumerate() {
        out.extend(normalize_gateway_tool_call(v, i));
    }
    dedupe_tool_calls(out)
}

fn normalize_gateway_tool_call(value: &Value, index: usize) -> Vec<GatewayToolCall> {
    match value {
        Value::Null => vec![],
        Value::Array(arr) => arr
            .iter()
            .enumerate()
            .flat_map(|(i, v)| normalize_gateway_tool_call(v, i))
            .collect(),
        Value::String(s) => normalize_inline_tool_calls(s),
        Value::Object(_) => {
            if let Some(nested) = value
                .get("tool_calls")
                .or_else(|| value.get("toolCalls"))
                .and_then(Value::as_array)
            {
                return nested
                    .iter()
                    .enumerate()
                    .flat_map(|(i, v)| normalize_gateway_tool_call(v, i))
                    .collect();
            }
            let fnv = value
                .get("function")
                .or_else(|| value.get("tool"))
                .unwrap_or(value);
            let name = pick_string(&[
                fnv.get("name"),
                value.get("name"),
                value.get("tool_name"),
                value.get("toolName"),
                value.get("function_name"),
            ])
            .unwrap_or_else(|| format!("tool_{}", index + 1));
            let raw_input = fnv
                .get("arguments")
                .or_else(|| fnv.get("arguments_json"))
                .or_else(|| fnv.get("argumentsJson"))
                .or_else(|| value.get("arguments"))
                .or_else(|| value.get("arguments_json"))
                .or_else(|| value.get("argumentsJson"))
                .or_else(|| value.get("input"))
                .or_else(|| value.get("parameters"))
                .cloned()
                .unwrap_or(json!({}));
            vec![GatewayToolCall {
                id: pick_string(&[
                    value.get("id"),
                    value.get("tool_call_id"),
                    value.get("toolCallId"),
                    value.get("call_id"),
                    value.get("callId"),
                ]),
                name,
                input: normalize_tool_input(&raw_input),
            }]
        }
        _ => vec![],
    }
}

pub fn to_openai_tool_calls(tool_calls: &[GatewayToolCall]) -> Vec<Value> {
    tool_calls
        .iter()
        .enumerate()
        .map(|(index, t)| {
            json!({
                "index": index,
                "id": t.id.clone().unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple())),
                "type": "function",
                "function": {
                    "name": t.name,
                    "arguments": stringify_tool_input(&t.input),
                },
            })
        })
        .collect()
}

pub fn to_anthropic_content_blocks(text: &str, tool_calls: &[GatewayToolCall]) -> Vec<Value> {
    let mut blocks = Vec::new();
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    for t in tool_calls {
        blocks.push(json!({
            "type": "tool_use",
            "id": t.id.clone().unwrap_or_else(|| format!("toolu_{}", uuid::Uuid::new_v4().simple())),
            "name": t.name,
            "input": normalize_tool_input(&t.input),
        }));
    }
    if blocks.is_empty() {
        blocks.push(json!({ "type": "text", "text": "" }));
    }
    blocks
}

pub fn normalize_tool_input(input: &Value) -> Value {
    match input {
        Value::Null => json!({}),
        Value::Object(_) => input.clone(),
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({ "arguments": s })),
        other => json!({ "value": other }),
    }
}

pub fn stringify_tool_input(input: &Value) -> String {
    if let Value::String(s) = input {
        return s.clone();
    }
    serde_json::to_string(&normalize_tool_input(input)).unwrap_or_else(|_| "{}".into())
}

pub fn dedupe_tool_calls(tool_calls: Vec<GatewayToolCall>) -> Vec<GatewayToolCall> {
    let mut seen = std::collections::HashSet::new();
    tool_calls
        .into_iter()
        .filter(|c| !c.name.is_empty())
        .filter(|c| {
            let key = format!(
                "{}\0{}\0{}",
                c.id.as_deref().unwrap_or(""),
                c.name,
                stringify_tool_input(&c.input)
            );
            seen.insert(key)
        })
        .collect()
}

fn normalize_inline_tool_calls(raw: &str) -> Vec<GatewayToolCall> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return vec![];
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return normalize_gateway_tool_call(&parsed, 0);
    }
    let name = regex::Regex::new(
        r"(?m)(?:^|\n)\s*(?:name|tool_name|toolName)\s*[:=]\s*([A-Za-z0-9_.:-]+)",
    )
    .unwrap()
    .captures(trimmed)
    .map(|c| c[1].to_string())
    .or_else(|| {
        regex::Regex::new(r"^\s*([A-Za-z0-9_.:-]+)\s*(?:\n|$)")
            .unwrap()
            .captures(trimmed)
            .map(|c| c[1].to_string())
    });
    let Some(name) = name else { return vec![] };
    let args = regex::Regex::new(r"(?:arguments|input)\s*[:=]\s*([\s\S]+)$")
        .unwrap()
        .captures(trimmed)
        .map(|c| c[1].trim().to_string())
        .unwrap_or_default();
    vec![GatewayToolCall {
        id: None,
        name,
        input: normalize_tool_input(&Value::String(args)),
    }]
}

fn pick_string(values: &[Option<&Value>]) -> Option<String> {
    values
        .iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

fn merge_tool_calls(
    first: Vec<GatewayToolCall>,
    second: Vec<GatewayToolCall>,
) -> Vec<GatewayToolCall> {
    dedupe_tool_calls([first, second].concat())
}

// ---------------------------------------------------------------------------
// usage + sse helpers
// ---------------------------------------------------------------------------

fn estimated_usage(input_body: &Value, output: &str) -> UsageStats {
    UsageStats {
        input_tokens: estimate_tokens(input_body),
        output_tokens: estimate_tokens(&json!(output)),
        estimated: Some(true),
        ..Default::default()
    }
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

// ---------------------------------------------------------------------------
// streaming.ts — output converters
// ---------------------------------------------------------------------------

/// `openAiSseFromCascadeDeltas`.
pub fn openai_sse_from_cascade_deltas<S>(
    source: S,
    model: String,
    input_body: Value,
    on_usage: Option<UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<WindsurfCascadeStreamEvent, anyhow::Error>> + Send,
{
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = crate::responses_api::now_secs();
    async_stream::stream! {
        let mut source = Box::pin(source);
        let mut started = false;
        let mut emitted_text = String::new();
        let mut usage: Option<UsageStats> = None;
        let mut tool_calls: Vec<GatewayToolCall> = Vec::new();
        let mut failed = false;

        while let Some(item) = source.next().await {
            let Ok(event) = item else {
                let e = item.err().unwrap();
                yield sse_data(&json!({
                    "error": {"message": e.to_string(), "type": "gateway_error", "code": "windsurf_error"},
                }));
                yield "data: [DONE]\n\n".to_string();
                failed = true;
                break;
            };
            if let Some(u) = &event.usage {
                usage = Some(u.clone());
            }
            if !event.tool_calls.is_empty() {
                tool_calls = merge_tool_calls(tool_calls, event.tool_calls.clone());
            }
            let mut delta = event.text_delta.unwrap_or_default();
            if delta.is_empty() && event.done && event.text.starts_with(&emitted_text) {
                delta = event.text[emitted_text.len()..].to_string();
            }
            if !delta.is_empty() {
                emitted_text.push_str(&delta);
                yield sse_data(&json!({
                    "id": id, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": if started { json!({"content": delta}) } else { json!({"role":"assistant","content":delta}) },
                        "finish_reason": null,
                    }],
                }));
                started = true;
            }
            if event.done {
                break;
            }
        }
        if failed {
            return;
        }
        if !started && tool_calls.is_empty() {
            yield sse_data(&json!({
                "id": id, "object": "chat.completion.chunk", "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {"role":"assistant","content":""},
                    "finish_reason": null,
                }],
            }));
            started = true;
        }
        if !tool_calls.is_empty() {
            if !started {
                yield sse_data(&json!({
                    "id": id, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"role":"assistant"},
                        "finish_reason": null,
                    }],
                }));
            }
            for (index, t) in to_openai_tool_calls(&tool_calls).iter().enumerate() {
                yield sse_data(&json!({
                    "id": id, "object": "chat.completion.chunk", "created": created,
                    "model": model,
                    "choices": [{
                        "index": 0,
                        "delta": {"tool_calls": [t]},
                        "finish_reason": null,
                    }],
                }));
                let _ = index;
            }
        }
        let final_usage = usage.unwrap_or_else(|| estimated_usage(&input_body, &emitted_text));
        if let Some(sink) = &on_usage {
            sink(
                final_usage.clone(),
                crate::types::UsageMeta {
                    account_id: Some(account_id),
                    model: Some(model.clone()),
                    provider: Some("windsurf".into()),
                },
            );
        }
        yield sse_data(&json!({
            "id": id, "object": "chat.completion.chunk", "created": created,
            "model": model,
            "choices": [{
                "index": 0,
                "delta": {},
                "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" },
            }],
            "usage": to_openai_usage(&final_usage),
        }));
        yield "data: [DONE]\n\n".to_string();
    }
}

/// `openAiJsonFromText` — one chat.completion from collected text.
pub fn openai_json_from_text(
    text: &str,
    model: &str,
    input_body: &Value,
    on_usage: Option<&UsageSink>,
    upstream_usage: Option<&UsageStats>,
    upstream_tool_calls: &[GatewayToolCall],
    account_id: &str,
    provider: &str,
) -> Value {
    let (parsed_text, parsed_calls) = split_inline_tool_calls(text);
    let tool_calls = merge_tool_calls(upstream_tool_calls.to_vec(), parsed_calls);
    let has_calls = !tool_calls.is_empty();
    let usage = upstream_usage
        .cloned()
        .unwrap_or_else(|| estimated_usage(input_body, &parsed_text));
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            crate::types::UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some(provider.to_string()),
            },
        );
    }
    let mut message = json!({
        "role": "assistant",
        "content": if parsed_text.is_empty() && has_calls { Value::Null } else { json!(parsed_text) },
    });
    if has_calls {
        message["tool_calls"] = Value::Array(to_openai_tool_calls(&tool_calls));
    }
    json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": crate::responses_api::now_secs(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": if has_calls { "tool_calls" } else { "stop" },
        }],
        "usage": to_openai_usage(&usage),
    })
}

/// `anthropicSseFromCascadeDeltas`.
#[allow(unused_assignments)]
pub fn anthropic_sse_from_cascade_deltas<S>(
    source: S,
    model: String,
    input_body: Value,
    on_usage: Option<UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<WindsurfCascadeStreamEvent, anyhow::Error>> + Send,
{
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    async_stream::stream! {
        let mut source = Box::pin(source);
        let mut message_started = false;
        let mut text_block_open = false;
        let mut emitted_text = String::new();
        let mut usage: Option<UsageStats> = None;
        let mut tool_calls: Vec<GatewayToolCall> = Vec::new();
        let mut block_index: u64 = 0;
        let mut failed = false;

        macro_rules! ensure_message_started {
            () => {{
                if !message_started {
                    message_started = true;
                    yield sse_event("message_start", &json!({
                        "type": "message_start",
                        "message": {
                            "id": id, "type": "message", "role": "assistant", "model": model,
                            "content": [], "stop_reason": null, "stop_sequence": null,
                            "usage": {"input_tokens": 0, "output_tokens": 0},
                        },
                    }));
                }
            }};
        }

        while let Some(item) = source.next().await {
            let Ok(event) = item else {
                let e = item.err().unwrap();
                ensure_message_started!();
                yield sse_event("error", &json!({
                    "type": "error",
                    "error": {"type":"api_error","message":e.to_string()},
                }));
                failed = true;
                break;
            };
            if let Some(u) = &event.usage {
                usage = Some(u.clone());
            }
            if !event.tool_calls.is_empty() {
                tool_calls = merge_tool_calls(tool_calls, event.tool_calls.clone());
            }
            let mut delta = event.text_delta.unwrap_or_default();
            if delta.is_empty() && event.done && event.text.starts_with(&emitted_text) {
                delta = event.text[emitted_text.len()..].to_string();
            }
            if !delta.is_empty() {
                if !text_block_open {
                    ensure_message_started!();
                    yield sse_event("content_block_start", &json!({
                        "type": "content_block_start", "index": block_index,
                        "content_block": {"type":"text","text":""},
                    }));
                    text_block_open = true;
                }
                emitted_text.push_str(&delta);
                yield sse_event("content_block_delta", &json!({
                    "type": "content_block_delta", "index": block_index,
                    "delta": {"type":"text_delta","text":delta},
                }));
            }
            if event.done {
                break;
            }
        }
        if failed {
            return;
        }
        if text_block_open {
            yield sse_event("content_block_stop", &json!({
                "type": "content_block_stop", "index": block_index,
            }));
            block_index += 1;
        }
        ensure_message_started!();
        if !text_block_open && tool_calls.is_empty() {
            yield sse_event("content_block_start", &json!({
                "type": "content_block_start", "index": block_index,
                "content_block": {"type":"text","text":""},
            }));
            yield sse_event("content_block_stop", &json!({
                "type": "content_block_stop", "index": block_index,
            }));
            block_index += 1;
        }
        for t in &tool_calls {
            yield sse_event("content_block_start", &json!({
                "type": "content_block_start", "index": block_index,
                "content_block": {
                    "type": "tool_use",
                    "id": t.id.clone().unwrap_or_else(|| format!("toolu_{}", uuid::Uuid::new_v4().simple())),
                    "name": t.name,
                    "input": {},
                },
            }));
            yield sse_event("content_block_delta", &json!({
                "type": "content_block_delta", "index": block_index,
                "delta": {"type":"input_json_delta","partial_json":stringify_tool_input(&t.input)},
            }));
            yield sse_event("content_block_stop", &json!({
                "type": "content_block_stop", "index": block_index,
            }));
            block_index += 1;
        }
        let final_usage = usage.unwrap_or_else(|| estimated_usage(&input_body, &emitted_text));
        if let Some(sink) = &on_usage {
            sink(
                final_usage.clone(),
                crate::types::UsageMeta {
                    account_id: Some(account_id),
                    model: Some(model.clone()),
                    provider: Some("windsurf".into()),
                },
            );
        }
        yield sse_event("message_delta", &json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": if tool_calls.is_empty() { "end_turn" } else { "tool_use" },
                "stop_sequence": null,
            },
            "usage": to_anthropic_usage(&final_usage),
        }));
        yield sse_event("message_stop", &json!({"type":"message_stop"}));
    }
}

/// `anthropicJsonFromText` — one message object from collected text.
pub fn anthropic_json_from_text(
    text: &str,
    model: &str,
    input_body: &Value,
    on_usage: Option<&UsageSink>,
    upstream_usage: Option<&UsageStats>,
    upstream_tool_calls: &[GatewayToolCall],
    account_id: &str,
    provider: &str,
) -> Value {
    let (parsed_text, parsed_calls) = split_inline_tool_calls(text);
    let tool_calls = merge_tool_calls(upstream_tool_calls.to_vec(), parsed_calls);
    let usage = upstream_usage
        .cloned()
        .unwrap_or_else(|| estimated_usage(input_body, &parsed_text));
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            crate::types::UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some(provider.to_string()),
            },
        );
    }
    json!({
        "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": to_anthropic_content_blocks(&parsed_text, &tool_calls),
        "stop_reason": if tool_calls.is_empty() { "end_turn" } else { "tool_use" },
        "stop_sequence": null,
        "usage": to_anthropic_usage(&usage),
    })
}
