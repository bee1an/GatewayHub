//! Output adapters for `kiro_stream.rs` — openai/anthropic SSE emitters.

use super::*;

pub(crate) fn find_matching_brace(text: &str, start: usize) -> usize {
    let bytes = text.as_bytes();
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    let mut i = start;
    while i < bytes.len() {
        let ch = bytes[i];
        if escaped {
            escaped = false;
        } else if ch == b'\\' && in_string {
            escaped = true;
        } else if ch == b'"' {
            in_string = !in_string;
        } else if !in_string && ch == b'{' {
            depth += 1;
        } else if !in_string && ch == b'}' {
            depth -= 1;
            if depth == 0 {
                return i;
            }
        }
        i += 1;
    }
    usize::MAX
}

pub(crate) fn dedupe_tool_calls(tools: Vec<Value>) -> Vec<Value> {
    let mut by_identity: Vec<(String, Value, Value)> = Vec::new(); // (id:name, tool, merged input)
    let mut order: Vec<String> = Vec::new();
    for tool in tools {
        let id = tool.get("id").and_then(Value::as_str).unwrap_or("");
        let name = tool
            .pointer("/function/name")
            .or_else(|| tool.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let identity = format!("{id}:{name}");
        let next_input = safe_json(tool.pointer("/function/arguments").unwrap_or(&Value::Null));
        if let Some(entry) = by_identity.iter_mut().find(|(i, _, _)| *i == identity) {
            let merged = merge_tool_input(entry.2.clone(), next_input.clone());
            let prefer_new = next_input.as_object().map(|o| o.len()).unwrap_or(0)
                > entry.2.as_object().map(|o| o.len()).unwrap_or(0);
            entry.1 = if prefer_new {
                tool.clone()
            } else {
                entry.1.clone()
            };
            entry.2 = merged;
        } else {
            order.push(identity.clone());
            by_identity.push((identity, tool, next_input));
        }
    }
    order
        .iter()
        .filter_map(|id| by_identity.iter().find(|(i, _, _)| i == id))
        .map(|(_, tool, input)| {
            let mut t = tool.clone();
            let name = tool
                .pointer("/function/name")
                .or_else(|| tool.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            t["function"] = json!({
                "name": name,
                "arguments": serde_json::to_string(input).unwrap_or_else(|_| "{}".into()),
            });
            t
        })
        .collect()
}

pub(crate) fn normalize_tool_input(chunks: Vec<Value>) -> Value {
    let mut merged = json!({});
    let mut has_object = false;
    let mut text = String::new();
    for chunk in chunks {
        match chunk {
            Value::String(s) => text.push_str(&s),
            Value::Object(_) => {
                merged = merge_tool_input(merged, chunk);
                has_object = true;
            }
            _ => {}
        }
    }
    if let Some(parsed) = parse_tool_input_text(&text) {
        merged = merge_tool_input(merged, parsed);
        has_object = true;
    }
    if has_object { merged } else { json!({}) }
}

pub(crate) fn parse_tool_input_text(text: &str) -> Option<Value> {
    if text.trim().is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text)
        && v.is_object()
    {
        return Some(v);
    }
    // concatenated fragments
    let mut merged = json!({});
    let mut found = false;
    let mut cursor = 0;
    while cursor < text.len() {
        let Some(start) = text[cursor..].find('{').map(|p| cursor + p) else {
            break;
        };
        let end = find_matching_brace(text, start);
        if end == usize::MAX {
            break;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(&text[start..=end])
            && parsed.is_object()
        {
            merged = merge_tool_input(merged, parsed);
            found = true;
        }
        cursor = end + 1;
    }
    found.then_some(merged)
}

pub(crate) fn merge_tool_input(target: Value, patch: Value) -> Value {
    let (mut t, p) = match (target, patch) {
        (Value::Object(t), Value::Object(p)) => (t, p),
        (_, patch) => return patch,
    };
    for (k, v) in p {
        match (t.get(&k).cloned(), v) {
            (Some(Value::Object(prev)), Value::Object(next)) => {
                t.insert(
                    k,
                    merge_tool_input(Value::Object(prev), Value::Object(next)),
                );
            }
            (Some(Value::String(prev)), Value::String(next)) => {
                t.insert(k, Value::String(merge_string_fragment(&prev, &next)));
            }
            (_, v) => {
                t.insert(k, v);
            }
        }
    }
    Value::Object(t)
}

pub(crate) fn merge_string_fragment(prev: &str, next: &str) -> String {
    if prev.is_empty() {
        return next.to_string();
    }
    if next.is_empty() {
        return prev.to_string();
    }
    if next.starts_with(prev) {
        return next.to_string();
    }
    if prev.ends_with(next) {
        return prev.to_string();
    }
    format!("{prev}{next}")
}

// ---------------------------------------------------------------------------
// output converters
// ---------------------------------------------------------------------------

/// `openAiSseFromKiro` — Kiro events → chat.completion.chunk frames.
pub fn openai_sse_from_kiro<S>(
    events: S,
    model: String,
    request_body: Value,
    on_usage: Option<crate::types::UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<KiroEvent, KiroStreamError>> + Send,
{
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = crate::responses_api::now_secs();
    async_stream::stream! {
        let mut events = Box::pin(events);
        let mut first = true;
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut upstream_usage = Value::Null;
        let mut credits = 0.0f64;
        let mut failed = false;

        while let Some(item) = events.next().await {
            match item {
                Ok(KiroEvent::Usage(u)) => upstream_usage = u,
                Ok(KiroEvent::Metering(c)) => credits += c,
                Ok(KiroEvent::Content(t)) => {
                    content.push_str(&t);
                    yield sse_data(&json!({
                        "id": id, "object": "chat.completion.chunk", "created": created,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": if first { json!({"role":"assistant","content":t}) } else { json!({"content":t}) },
                            "finish_reason": null,
                        }],
                    }));
                    first = false;
                }
                Ok(KiroEvent::Thinking(t)) => {
                    thinking.push_str(&t);
                    yield sse_data(&json!({
                        "id": id, "object": "chat.completion.chunk", "created": created,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": if first { json!({"role":"assistant","reasoning_content":t}) } else { json!({"reasoning_content":t}) },
                            "finish_reason": null,
                        }],
                    }));
                    first = false;
                }
                Ok(KiroEvent::ToolUse(tool)) => tool_calls.push(tool),
                Ok(KiroEvent::ContextUsage(_)) => {}
                Err(e) => {
                    yield sse_data(&json!({
                        "error": {"message": e.to_string(), "type": "gateway_error"},
                    }));
                    yield "data: [DONE]\n\n".to_string();
                    failed = true;
                    break;
                }
            }
        }
        if failed {
            return;
        }

        if !tool_calls.is_empty() {
            let calls: Vec<Value> = tool_calls
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    let mut c = t.clone();
                    c["index"] = json!(i);
                    c
                })
                .collect();
            let mut delta = json!({ "tool_calls": calls });
            if first {
                delta["role"] = json!("assistant");
            }
            yield sse_data(&json!({
                "id": id, "object": "chat.completion.chunk", "created": created,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": delta,
                    "finish_reason": null,
                }],
            }));
        }
        let usage = with_credits(
            extract_upstream_usage(&upstream_usage)
                .unwrap_or_else(|| fallback_usage(&request_body, &content, &thinking)),
            credits,
        );
        if let Some(sink) = &on_usage {
            sink(
                usage.clone(),
                crate::types::UsageMeta {
                    account_id: Some(account_id),
                    model: Some(model.clone()),
                    provider: Some("kiro".into()),
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
            "usage": to_openai_usage(&usage),
        }));
        yield "data: [DONE]\n\n".to_string();
    }
}

/// `openAiJsonFromKiro` — collect into one chat.completion.
pub async fn openai_json_from_kiro<S>(
    events: S,
    model: &str,
    request_body: &Value,
    on_usage: Option<&crate::types::UsageSink>,
    account_id: &str,
) -> Result<Value, KiroStreamError>
where
    S: Stream<Item = Result<KiroEvent, KiroStreamError>> + Send,
{
    let mut events = Box::pin(events);
    let mut upstream_usage = Value::Null;
    let mut credits = 0.0f64;
    let mut content = String::new();
    let mut thinking = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();

    while let Some(item) = events.next().await {
        match item {
            Ok(KiroEvent::Usage(u)) => upstream_usage = u,
            Ok(KiroEvent::Metering(c)) => credits += c,
            Ok(KiroEvent::Content(t)) => content.push_str(&t),
            Ok(KiroEvent::Thinking(t)) => thinking.push_str(&t),
            Ok(KiroEvent::ToolUse(tool)) => tool_calls.push(tool),
            Ok(KiroEvent::ContextUsage(_)) => {}
            Err(e) => return Err(e),
        }
    }

    let mut message = json!({ "role": "assistant", "content": content });
    if !thinking.is_empty() {
        message["reasoning_content"] = json!(thinking);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls.clone());
    }
    let usage = with_credits(
        extract_upstream_usage(&upstream_usage).unwrap_or_else(|| UsageStats {
            input_tokens: crate::providers::kiro_convert::openai_usage_from_bodies(
                request_body,
                &(content.clone() + &thinking),
            )["prompt_tokens"]
                .as_u64()
                .unwrap_or(0),
            output_tokens: estimate_tokens(&json!(content)) + estimate_tokens(&json!(thinking)),
            estimated: Some(true),
            ..Default::default()
        }),
        credits,
    );
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            crate::types::UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("kiro".into()),
            },
        );
    }
    Ok(json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4().simple()),
        "object": "chat.completion",
        "created": crate::responses_api::now_secs(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": if tool_calls.is_empty() { "stop" } else { "tool_calls" },
        }],
        "usage": to_openai_usage(&usage),
    }))
}

/// `anthropicSseFromKiro` — Kiro events → Anthropic message SSE.
#[allow(unused_assignments)]
pub fn anthropic_sse_from_kiro<S>(
    events: S,
    model: String,
    request_body: Value,
    on_usage: Option<crate::types::UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<KiroEvent, KiroStreamError>> + Send,
{
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    let fallback_input = anthropic_input_tokens(&request_body);
    async_stream::stream! {
        let mut events = Box::pin(events);
        yield sse_event("message_start", &json!({
            "type": "message_start",
            "message": {
                "id": id, "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": fallback_input, "output_tokens": 0},
            },
        }));

        let mut index: u64 = 0;
        let mut open_block: Option<&'static str> = None;
        let mut content = String::new();
        let mut thinking = String::new();
        let mut tool_calls: Vec<Value> = Vec::new();
        let mut upstream_usage = Value::Null;
        let mut credits = 0.0f64;
        let mut failed = false;

        macro_rules! close_block {
            () => {{
                if open_block.is_some() {
                    yield sse_event("content_block_stop", &json!({
                        "type": "content_block_stop", "index": index,
                    }));
                    index += 1;
                    open_block = None;
                }
            }};
        }
        macro_rules! ensure_block {
            ($ty:expr) => {{
                if open_block != Some($ty) {
                    close_block!();
                    yield sse_event("content_block_start", &json!({
                        "type": "content_block_start", "index": index,
                        "content_block": if $ty == "thinking" {
                            json!({"type":"thinking","thinking":"","signature":""})
                        } else {
                            json!({"type":"text","text":""})
                        },
                    }));
                    open_block = Some($ty);
                }
            }};
        }

        while let Some(item) = events.next().await {
            match item {
                Ok(KiroEvent::Usage(u)) => upstream_usage = u,
                Ok(KiroEvent::Metering(c)) => credits += c,
                Ok(KiroEvent::Thinking(t)) => {
                    thinking.push_str(&t);
                    ensure_block!("thinking");
                    yield sse_event("content_block_delta", &json!({
                        "type": "content_block_delta", "index": index,
                        "delta": {"type":"thinking_delta","thinking":t},
                    }));
                }
                Ok(KiroEvent::Content(t)) => {
                    content.push_str(&t);
                    ensure_block!("text");
                    yield sse_event("content_block_delta", &json!({
                        "type": "content_block_delta", "index": index,
                        "delta": {"type":"text_delta","text":t},
                    }));
                }
                Ok(KiroEvent::ToolUse(tool)) => tool_calls.push(tool),
                Ok(KiroEvent::ContextUsage(_)) => {}
                Err(e) => {
                    yield sse_event("error", &json!({
                        "type": "error",
                        "error": {"type":"api_error","message":e.to_string()},
                    }));
                    failed = true;
                    break;
                }
            }
        }
        if failed {
            return;
        }
        close_block!();
        for tool in &tool_calls {
            let input = safe_json(tool.pointer("/function/arguments").unwrap_or(&Value::Null));
            let name = tool
                .pointer("/function/name")
                .or_else(|| tool.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            yield sse_event("content_block_start", &json!({
                "type": "content_block_start", "index": index,
                "content_block": {"type":"tool_use","id":tool.get("id"),"name":name,"input":{}},
            }));
            yield sse_event("content_block_delta", &json!({
                "type": "content_block_delta", "index": index,
                "delta": {"type":"input_json_delta","partial_json":serde_json::to_string(&input).unwrap_or_else(|_|"{}".into())},
            }));
            yield sse_event("content_block_stop", &json!({
                "type": "content_block_stop", "index": index,
            }));
            index += 1;
        }

        let usage = with_credits(
            extract_upstream_usage(&upstream_usage)
                .unwrap_or_else(|| fallback_usage(&request_body, &content, &thinking)),
            credits,
        );
        if let Some(sink) = &on_usage {
            sink(
                usage.clone(),
                crate::types::UsageMeta {
                    account_id: Some(account_id),
                    model: Some(model.clone()),
                    provider: Some("kiro".into()),
                },
            );
        }
        yield sse_event("message_delta", &json!({
            "type": "message_delta",
            "delta": {
                "stop_reason": if tool_calls.is_empty() { "end_turn" } else { "tool_use" },
                "stop_sequence": null,
            },
            "usage": to_anthropic_delta_usage(&usage),
        }));
        yield sse_event("message_stop", &json!({"type":"message_stop"}));
    }
}

/// `anthropicJsonFromKiro` — collect into an Anthropic message object.
pub async fn anthropic_json_from_kiro<S>(
    events: S,
    model: &str,
    request_body: &Value,
    on_usage: Option<&crate::types::UsageSink>,
    account_id: &str,
) -> Result<Value, KiroStreamError>
where
    S: Stream<Item = Result<KiroEvent, KiroStreamError>> + Send,
{
    let mut events = Box::pin(events);
    let mut upstream_usage = Value::Null;
    let mut credits = 0.0f64;
    let mut content = String::new();
    let mut thinking = String::new();
    let mut tool_calls: Vec<Value> = Vec::new();

    while let Some(item) = events.next().await {
        match item {
            Ok(KiroEvent::Usage(u)) => upstream_usage = u,
            Ok(KiroEvent::Metering(c)) => credits += c,
            Ok(KiroEvent::Content(t)) => content.push_str(&t),
            Ok(KiroEvent::Thinking(t)) => thinking.push_str(&t),
            Ok(KiroEvent::ToolUse(tool)) => tool_calls.push(tool),
            Ok(KiroEvent::ContextUsage(_)) => {}
            Err(e) => return Err(e),
        }
    }

    let mut blocks: Vec<Value> = Vec::new();
    if !thinking.is_empty() {
        blocks.push(json!({ "type": "thinking", "thinking": thinking }));
    }
    if !content.is_empty() {
        blocks.push(json!({ "type": "text", "text": content }));
    }
    for tool in &tool_calls {
        blocks.push(json!({
            "type": "tool_use",
            "id": tool.get("id"),
            "name": tool.pointer("/function/name").or_else(|| tool.get("name")),
            "input": safe_json(tool.pointer("/function/arguments").unwrap_or(&Value::Null)),
        }));
    }
    if blocks.is_empty() {
        blocks.push(json!({ "type": "text", "text": "" }));
    }

    let usage = with_credits(
        extract_upstream_usage(&upstream_usage)
            .unwrap_or_else(|| fallback_usage(request_body, &content, &thinking)),
        credits,
    );
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            crate::types::UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("kiro".into()),
            },
        );
    }
    Ok(json!({
        "id": format!("msg_{}", uuid::Uuid::new_v4().simple()),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": blocks,
        "stop_reason": if tool_calls.is_empty() { "end_turn" } else { "tool_use" },
        "stop_sequence": null,
        "usage": to_anthropic_delta_usage(&usage),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    pub(crate) fn parser_extracts_content_and_tool_use() {
        let mut p = AwsEventStreamParser::default();
        let evs = p
            .feed("noise{\"content\":\"Hello\"}more{\"name\":\"bash\",\"toolUseId\":\"t1\",\"input\":{\"cmd\":\"ls\"}}")
            .expect("validated invariant");
        assert!(matches!(&evs[0], KiroEvent::Content(t) if t == "Hello"));
        let final_evs = p.finish();
        assert!(matches!(&final_evs[0], KiroEvent::ToolUse(t) if t["function"]["name"] == "bash"));
    }

    #[test]
    pub(crate) fn thinking_tag_splits_content() {
        let mut tp = ThinkingTagParser::default();
        let out = tp.process(KiroEvent::Content("a<thinking>b</thinking>c".into()));
        assert!(matches!(&out[0], KiroEvent::Content(t) if t == "a"));
        assert!(matches!(&out[1], KiroEvent::Thinking(t) if t == "b"));
        assert!(matches!(&out[2], KiroEvent::Content(t) if t == "c"));
    }

    #[test]
    pub(crate) fn metering_accumulates() {
        let mut p = AwsEventStreamParser::default();
        let evs = p
            .feed("{\"unit\":\"credit\",\"usage\":2.5}")
            .expect("validated invariant");
        assert!(matches!(evs[0], KiroEvent::Metering(c) if c == 2.5));
    }
}
