//! Streaming half of `trae_rawchat.rs` — tool-call accumulation + SSE emitters.

use super::*;

// --- tool-call accumulation (openai + anthropic event shapes) ---------------

#[derive(Default)]
pub(crate) struct ToolCallAcc {
    pub(crate) entries: Vec<(String, ToolCallEntry)>,
}

#[derive(Default, Clone)]
pub(crate) struct ToolCallEntry {
    pub(crate) id: Option<String>,
    pub(crate) index: Option<u64>,
    pub(crate) name: Option<String>,
    pub(crate) arguments_text: String,
    pub(crate) input: Option<Value>,
}

impl ToolCallAcc {
    pub(crate) fn get_mut(&mut self, key: &str) -> &mut ToolCallEntry {
        if !self.entries.iter().any(|(k, _)| k == key) {
            self.entries
                .push((key.to_string(), ToolCallEntry::default()));
        }
        &mut self
            .entries
            .iter_mut()
            .find(|(k, _)| k == key)
            .expect("validated invariant")
            .1
    }
    pub(crate) fn resolve_key(&self, id: &str, index: Option<u64>) -> String {
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

pub(crate) fn merge_tool_calls_from_payload(payload: &Value, acc: &mut ToolCallAcc) {
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

pub(crate) fn merge_openai_tool_calls(
    value: Option<&Value>,
    acc: &mut ToolCallAcc,
    complete: bool,
) {
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

pub(crate) fn merge_anthropic_tool_uses(value: Option<&Value>, acc: &mut ToolCallAcc) {
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

pub(crate) fn merge_anthropic_tool_event(payload: &Value, acc: &mut ToolCallAcc) {
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

pub(crate) fn has_meaningful_input(input: &Value) -> bool {
    match input {
        Value::Null => false,
        Value::Object(o) => !o.is_empty(),
        _ => true,
    }
}

pub(crate) fn finalize_tool_calls(acc: ToolCallAcc) -> Vec<GatewayToolCall> {
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

pub(crate) fn as_array(value: Option<&Value>) -> Vec<Value> {
    match value {
        Some(Value::Array(arr)) => arr.clone(),
        Some(v) if !v.is_null() => vec![v.clone()],
        _ => Vec::new(),
    }
}

pub(crate) fn pick_str(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|k| v.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

pub(crate) fn stringify_arguments(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
    }
}

pub(crate) fn parse_arguments(value: &str) -> Value {
    if value.is_empty() {
        return json!({});
    }
    serde_json::from_str(value).unwrap_or_else(|_| json!({ "arguments": value }))
}

pub(crate) fn extract_usage(payload: &Value) -> Option<UsageStats> {
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

pub(crate) fn stringify_payload(payload: &Value) -> String {
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

pub(crate) fn to_openai_usage(u: &UsageStats) -> Value {
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

pub(crate) fn to_anthropic_usage(u: &UsageStats) -> Value {
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
