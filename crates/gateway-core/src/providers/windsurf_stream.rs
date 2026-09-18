//! Shared output converters (formerly windsurf_stream — now used by trae/workbuddy) — port of `providers/windsurf/toolCalls.ts`
//! + `streaming.ts`. Text/tool calls → OpenAI/Anthropic JSON or SSE.

use serde_json::{Value, json};

use crate::providers::kiro_convert::estimate_tokens;
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
        .get_or_init(|| {
            regex::Regex::new(r"(?i)<tool_call>\s*([\s\S]*?)\s*</tool_call>")
                .expect("validated invariant")
        })
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
    .expect("validated invariant")
    .captures(trimmed)
    .map(|c| c[1].to_string())
    .or_else(|| {
        regex::Regex::new(r"^\s*([A-Za-z0-9_.:-]+)\s*(?:\n|$)")
            .expect("validated invariant")
            .captures(trimmed)
            .map(|c| c[1].to_string())
    });
    let Some(name) = name else { return vec![] };
    let args = regex::Regex::new(r"(?:arguments|input)\s*[:=]\s*([\s\S]+)$")
        .expect("validated invariant")
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

// ---------------------------------------------------------------------------
// streaming.ts — output converters
// ---------------------------------------------------------------------------

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
