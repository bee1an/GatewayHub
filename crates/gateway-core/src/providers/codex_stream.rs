//! Codex upstream SSE — port of `providers/codex/streaming.ts`.
//! Parses `response.*` frames from the gptWeb `/codex/responses` stream
//! into normalized events, then re-emits them as OpenAI chat-completion
//! SSE / JSON or Anthropic message SSE / JSON.

use std::collections::VecDeque;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::protocol::SseParser;
use crate::types::UsageStats;

/// `FirstTokenTimeoutError` — retry-with-another-account trigger.
#[derive(Debug)]
pub enum CodexStreamError {
    FirstTokenTimeout(u64),
    IdleTimeout(u64),
    Transport(String),
    Upstream(String),
}

impl std::fmt::Display for CodexStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FirstTokenTimeout(s) => write!(f, "No Codex token within {s}s"),
            Self::IdleTimeout(s) => {
                write!(f, "Codex stream idle timeout after {s}s without data")
            }
            Self::Transport(e) => write!(f, "{e}"),
            Self::Upstream(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for CodexStreamError {}

#[derive(Debug)]
pub enum CodexEvent {
    Text(String),
    ReasoningDelta(String),
    ToolUseStart {
        id: String,
        item_id: Option<String>,
        name: String,
    },
    ToolUseArgsDelta {
        id: String,
        item_id: Option<String>,
        args: String,
    },
    ToolUseDone {
        id: String,
        item_id: Option<String>,
    },
    Usage {
        usage: Value,
        model: Option<String>,
    },
    Done,
    Error(Value),
}

/// `blockToEvent` port — SSE block → normalized event.
fn block_to_event(event_name: Option<&str>, data: &str) -> Option<CodexEvent> {
    if data == "[DONE]" {
        return Some(CodexEvent::Done);
    }
    let parsed: Value = serde_json::from_str(data).ok()?;
    let name = event_name
        .map(str::to_string)
        .or_else(|| {
            parsed
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_default();

    match name.as_str() {
        "response.output_text.delta" | "response.text.delta" => {
            let delta = parsed.get("delta").and_then(Value::as_str)?;
            (!delta.is_empty()).then(|| CodexEvent::Text(delta.to_string()))
        }
        "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
            let delta = parsed.get("delta").and_then(Value::as_str)?;
            (!delta.is_empty()).then(|| CodexEvent::ReasoningDelta(delta.to_string()))
        }
        "response.output_item.added" => {
            let item = parsed.get("item")?;
            if item.get("type").and_then(Value::as_str) == Some("function_call")
                || item.get("call_id").is_some()
            {
                Some(CodexEvent::ToolUseStart {
                    id: item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| format!("call_{}", uuid::Uuid::new_v4().simple())),
                    item_id: item
                        .get("id")
                        .or_else(|| item.get("item_id"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    name: item
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                })
            } else {
                None
            }
        }
        "response.function_call_arguments.delta" => {
            let item_id = parsed
                .get("item_id")
                .or_else(|| parsed.get("item").and_then(|i| i.get("id")))
                .and_then(Value::as_str)
                .map(str::to_string);
            let id = parsed
                .get("call_id")
                .or_else(|| parsed.get("item").and_then(|i| i.get("call_id")))
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| item_id.clone())
                .unwrap_or_default();
            Some(CodexEvent::ToolUseArgsDelta {
                id,
                item_id,
                args: parsed
                    .get("delta")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
        }
        "response.output_item.done" => {
            let item = parsed.get("item")?;
            if item.get("type").and_then(Value::as_str) == Some("function_call")
                || item.get("call_id").is_some()
            {
                Some(CodexEvent::ToolUseDone {
                    id: item
                        .get("call_id")
                        .or_else(|| item.get("id"))
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    item_id: item
                        .get("id")
                        .or_else(|| item.get("item_id"))
                        .and_then(Value::as_str)
                        .map(str::to_string),
                })
            } else {
                None
            }
        }
        "response.completed" => {
            let response = parsed.get("response").unwrap_or(&parsed);
            Some(CodexEvent::Usage {
                usage: response.get("usage").cloned().unwrap_or(Value::Null),
                model: response
                    .get("model")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        }
        "response.error" | "response.failed" => Some(CodexEvent::Error(parsed)),
        _ if parsed.get("type").and_then(Value::as_str) == Some("error") => {
            Some(CodexEvent::Error(parsed))
        }
        _ => None,
    }
}

/// `parseCodexStream` — response body → normalized events with
/// first-token + idle timeouts.
pub fn parse_codex_stream(
    response: reqwest::Response,
    first_token_timeout: Duration,
    idle_timeout: Duration,
) -> impl Stream<Item = Result<CodexEvent, CodexStreamError>> + Send {
    let mut byte_stream = response.bytes_stream();
    async_stream::stream! {
        let mut parser = SseParser::default();
        let mut pending: VecDeque<Result<CodexEvent, CodexStreamError>> = VecDeque::new();
        let mut tail: Vec<u8> = Vec::new();
        let mut first = true;

        loop {
            let timeout = if first { first_token_timeout } else { idle_timeout };
            let item = tokio::time::timeout(timeout, byte_stream.next()).await;
            let chunk = match item {
                Ok(Some(Ok(b))) => b,
                Ok(Some(Err(e))) => {
                    yield Err(CodexStreamError::Transport(e.to_string()));
                    break;
                }
                Ok(None) => break,
                Err(_) => {
                    yield Err(if first {
                        CodexStreamError::FirstTokenTimeout(timeout.as_secs())
                    } else {
                        CodexStreamError::IdleTimeout(timeout.as_secs())
                    });
                    break;
                }
            };
            first = false;
            tail.extend_from_slice(&chunk);
            let valid = match std::str::from_utf8(&tail) {
                Ok(s) => {
                    let out = s.to_string();
                    tail.clear();
                    out
                }
                Err(e) if e.valid_up_to() > 0 => {
                    let out = String::from_utf8_lossy(&tail[..e.valid_up_to()]).into_owned();
                    tail.drain(..e.valid_up_to());
                    out
                }
                Err(_) => continue,
            };
            for (name, data) in parser.feed_blocks(&valid) {
                if let Some(ev) = block_to_event(name.as_deref(), &data) {
                    pending.push_back(Ok(ev));
                }
            }
            while let Some(ev) = pending.pop_front() {
                yield ev;
            }
        }
        // flush
        if !tail.is_empty() {
            for (name, data) in parser.feed_blocks(&String::from_utf8_lossy(&tail)) {
                if let Some(ev) = block_to_event(name.as_deref(), &data) {
                    pending.push_back(Ok(ev));
                }
            }
        }
        for data in parser.finish() {
            if let Some(ev) = block_to_event(None, &data) {
                pending.push_back(Ok(ev));
            }
        }
        while let Some(ev) = pending.pop_front() {
            yield ev;
        }
    }
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

fn stringify_error(error: &Value) -> String {
    if error.is_null() {
        return "Codex stream error".into();
    }
    if let Some(s) = error.as_str() {
        return s.to_string();
    }
    if let Some(m) = error.pointer("/error/message").and_then(Value::as_str) {
        return m.to_string();
    }
    if let Some(m) = error.get("message").and_then(Value::as_str) {
        return m.to_string();
    }
    serde_json::to_string(error)
        .unwrap_or_else(|_| "Codex stream error".into())
        .chars()
        .take(500)
        .collect()
}

/// `extractUpstreamUsage` — normalize upstream usage naming variants.
pub fn extract_upstream_usage(raw: &Value) -> Option<UsageStats> {
    if !raw.is_object() {
        return None;
    }
    let pick = |keys: &[&str]| -> Option<u64> {
        keys.iter()
            .find_map(|k| {
                raw.get(*k)
                    .and_then(Value::as_f64)
                    .filter(|n| n.is_finite())
            })
            .map(|n| n.max(0.0) as u64)
    };
    let cached = pick(&[
        "cached_input_tokens",
        "cache_read_input_tokens",
        "cachedInputTokens",
    ])
    .or_else(|| {
        raw.get("input_tokens_details")
            .or_else(|| raw.get("inputTokensDetails"))
            .and_then(|d| pick_at(d, &["cached_tokens", "cache_read_tokens"]))
    })
    .or_else(|| {
        raw.get("prompt_tokens_details")
            .or_else(|| raw.get("promptTokensDetails"))
            .and_then(|d| pick_at(d, &["cached_tokens", "cache_read_tokens"]))
    });
    let input = pick(&["input_tokens", "inputTokens", "prompt_tokens"]);
    let output = pick(&["output_tokens", "outputTokens", "completion_tokens"]);
    if input.is_none() && output.is_none() && cached.is_none() {
        return None;
    }
    Some(UsageStats {
        input_tokens: input.unwrap_or(0).saturating_sub(cached.unwrap_or(0)),
        output_tokens: output.unwrap_or(0),
        cache_read_tokens: cached,
        ..Default::default()
    })
}

fn pick_at(v: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_f64).filter(|n| n.is_finite()))
        .map(|n| n.max(0.0) as u64)
}

fn to_openai_usage(u: &UsageStats) -> Value {
    let cached = u.cache_read_tokens.unwrap_or(0);
    let prompt = u.input_tokens + cached;
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

fn to_anthropic_delta_usage(u: &UsageStats) -> Value {
    let mut out = json!({
        "input_tokens": u.input_tokens,
        "output_tokens": u.output_tokens,
    });
    if let Some(c) = u.cache_read_tokens {
        out["cache_read_input_tokens"] = json!(c);
    }
    out
}

fn matches_tool(
    tool_id: &str,
    tool_item: Option<&str>,
    ev_id: &str,
    ev_item: Option<&str>,
) -> bool {
    tool_id == ev_id
        || tool_item.is_some_and(|t| t == ev_id)
        || ev_item.is_some_and(|e| tool_id == e || tool_item == Some(e))
}

fn safe_json(value: &Value) -> Value {
    match value {
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
        Value::Null => json!({}),
        other => other.clone(),
    }
}

// ---------- consumers ----------

/// `openAiSseFromCodex` — upstream events → chat.completion.chunk frames.
pub fn openai_sse_from_codex<S>(
    events: S,
    model: String,
    on_usage: Option<crate::types::UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<CodexEvent, CodexStreamError>> + Send,
{
    let id = format!("chatcmpl-{}", uuid::Uuid::new_v4().simple());
    let created = crate::responses_api::now_secs();
    async_stream::stream! {
        let mut events = Box::pin(events);
        let mut first = true;
        let mut upstream_usage = Value::Null;
        let mut tool_calls: Vec<(String, Option<String>, String, String)> = Vec::new();
        let mut current_tool_index: i64 = -1;
        let mut failed: Option<String> = None;

        while let Some(item) = events.next().await {
            match item {
                Ok(CodexEvent::Text(text)) => {
                    yield sse_data(&json!({
                        "id": id, "object": "chat.completion.chunk", "created": created,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": if first { json!({"role": "assistant", "content": text}) }
                                     else { json!({"content": text}) },
                            "finish_reason": null,
                        }],
                    }));
                    first = false;
                }
                Ok(CodexEvent::ReasoningDelta(text)) => {
                    yield sse_data(&json!({
                        "id": id, "object": "chat.completion.chunk", "created": created,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": if first { json!({"role": "assistant", "reasoning_content": text}) }
                                     else { json!({"reasoning_content": text}) },
                            "finish_reason": null,
                        }],
                    }));
                    first = false;
                }
                Ok(CodexEvent::ToolUseStart { id: call_id, item_id, name }) => {
                    current_tool_index += 1;
                    tool_calls.push((call_id.clone(), item_id, name.clone(), String::new()));
                    let mut delta = json!({
                        "tool_calls": [{
                            "index": current_tool_index,
                            "id": call_id,
                            "type": "function",
                            "function": {"name": name, "arguments": ""},
                        }],
                    });
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
                    first = false;
                }
                Ok(CodexEvent::ToolUseArgsDelta { id: ev_id, item_id, args }) => {
                    let idx = tool_calls
                        .iter()
                        .position(|(tid, titem, _, _)| matches_tool(tid, titem.as_deref(), &ev_id, item_id.as_deref()))
                        .map(|i| i as i64)
                        .unwrap_or(current_tool_index);
                    if idx >= 0
                        && let Some(t) = tool_calls.get_mut(idx as usize)
                    {
                        t.3.push_str(&args);
                    }
                    yield sse_data(&json!({
                        "id": id, "object": "chat.completion.chunk", "created": created,
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "delta": {
                                "tool_calls": [{
                                    "index": idx.max(0),
                                    "function": {"arguments": args},
                                }],
                            },
                            "finish_reason": null,
                        }],
                    }));
                }
                Ok(CodexEvent::ToolUseDone { .. }) | Ok(CodexEvent::Done) => {}
                Ok(CodexEvent::Usage { usage, .. }) => upstream_usage = usage,
                Ok(CodexEvent::Error(e)) => {
                    yield sse_data(&json!({
                        "error": { "message": stringify_error(&e), "type": "gateway_error" },
                    }));
                    yield "data: [DONE]\n\n".to_string();
                    return;
                }
                Err(e) => {
                    failed = Some(e.to_string());
                    break;
                }
            }
        }
        if let Some(e) = failed {
            yield sse_data(&json!({
                "error": { "message": e, "type": "gateway_error" },
            }));
            yield "data: [DONE]\n\n".to_string();
            return;
        }

        let usage = extract_upstream_usage(&upstream_usage).unwrap_or(UsageStats {
            estimated: Some(true),
            ..Default::default()
        });
        if let Some(sink) = &on_usage {
            sink(
                usage.clone(),
                crate::types::UsageMeta {
                    account_id: Some(account_id),
                    model: Some(model.clone()),
                    provider: Some("codex".into()),
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

/// `openAiJsonFromCodex` — collect the event stream into one completion.
pub async fn openai_json_from_codex<S>(
    events: S,
    model: &str,
    on_usage: Option<&crate::types::UsageSink>,
    account_id: &str,
) -> Result<Value, CodexStreamError>
where
    S: Stream<Item = Result<CodexEvent, CodexStreamError>> + Send,
{
    let mut events = Box::pin(events);
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut upstream_usage = Value::Null;
    let mut tool_calls: Vec<Value> = Vec::new();
    let mut current_tool: Option<(String, Option<String>, String, String)> = None;

    while let Some(item) = events.next().await {
        match item {
            Ok(CodexEvent::Text(t)) => content.push_str(&t),
            Ok(CodexEvent::ReasoningDelta(t)) => reasoning.push_str(&t),
            Ok(CodexEvent::ToolUseStart { id, item_id, name }) => {
                current_tool = Some((id, item_id, name, String::new()));
            }
            Ok(CodexEvent::ToolUseArgsDelta { id, item_id, args }) => {
                if let Some(t) = &mut current_tool
                    && matches_tool(&t.0, t.1.as_deref(), &id, item_id.as_deref())
                {
                    t.3.push_str(&args);
                }
            }
            Ok(CodexEvent::ToolUseDone { .. }) => {
                if let Some((id, _, name, args)) = current_tool.take() {
                    tool_calls.push(json!({
                        "id": id, "type": "function",
                        "function": {"name": name, "arguments": args},
                    }));
                }
            }
            Ok(CodexEvent::Usage { usage, .. }) => upstream_usage = usage,
            Ok(CodexEvent::Error(e)) => {
                return Err(CodexStreamError::Upstream(stringify_error(&e)));
            }
            Ok(CodexEvent::Done) => {}
            Err(e) => return Err(e),
        }
    }
    if let Some((id, _, name, args)) = current_tool.take() {
        tool_calls.push(json!({
            "id": id, "type": "function",
            "function": {"name": name, "arguments": args},
        }));
    }

    let usage = extract_upstream_usage(&upstream_usage).unwrap_or(UsageStats {
        estimated: Some(true),
        ..Default::default()
    });
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            crate::types::UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("codex".into()),
            },
        );
    }
    let mut message = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls.clone());
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

/// `anthropicSseFromCodex` — upstream events → Anthropic message SSE.
#[allow(unused_assignments)] // macros assign then re-branch on open_block
pub fn anthropic_sse_from_codex<S>(
    events: S,
    model: String,
    on_usage: Option<crate::types::UsageSink>,
    account_id: String,
) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = Result<CodexEvent, CodexStreamError>> + Send,
{
    let id = format!("msg_{}", uuid::Uuid::new_v4().simple());
    async_stream::stream! {
        let mut events = Box::pin(events);
        yield sse_event("message_start", &json!({
            "type": "message_start",
            "message": {
                "id": id, "type": "message", "role": "assistant", "model": model,
                "content": [], "stop_reason": null, "stop_sequence": null,
                "usage": {"input_tokens": 0, "output_tokens": 0},
            },
        }));

        let mut index: u64 = 0;
        let mut open_block: Option<&'static str> = None; // thinking|text|tool_use
        let mut upstream_usage = Value::Null;
        let mut tool_calls: Vec<String> = Vec::new();
        let mut failed = false;

        macro_rules! close_block {
            () => {{
                if open_block.is_some() {
                    let frames = vec![sse_event("content_block_stop", &json!({
                        "type": "content_block_stop", "index": index,
                    }))];
                    index += 1;
                    open_block = None;
                    for f in frames { yield f; }
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
                            json!({"type": "thinking", "thinking": "", "signature": ""})
                        } else {
                            json!({"type": "text", "text": ""})
                        },
                    }));
                    open_block = Some($ty);
                }
            }};
        }

        while let Some(item) = events.next().await {
            match item {
                Ok(CodexEvent::Text(text)) => {
                    ensure_block!("text");
                    yield sse_event("content_block_delta", &json!({
                        "type": "content_block_delta", "index": index,
                        "delta": {"type": "text_delta", "text": text},
                    }));
                }
                Ok(CodexEvent::ReasoningDelta(text)) => {
                    ensure_block!("thinking");
                    yield sse_event("content_block_delta", &json!({
                        "type": "content_block_delta", "index": index,
                        "delta": {"type": "thinking_delta", "thinking": text},
                    }));
                }
                Ok(CodexEvent::ToolUseStart { id: call_id, name, .. }) => {
                    close_block!();
                    tool_calls.push(call_id.clone());
                    yield sse_event("content_block_start", &json!({
                        "type": "content_block_start", "index": index,
                        "content_block": {"type": "tool_use", "id": call_id, "name": name, "input": {}},
                    }));
                    open_block = Some("tool_use");
                }
                Ok(CodexEvent::ToolUseArgsDelta { args, .. }) => {
                    yield sse_event("content_block_delta", &json!({
                        "type": "content_block_delta", "index": index,
                        "delta": {"type": "input_json_delta", "partial_json": args},
                    }));
                }
                Ok(CodexEvent::ToolUseDone { .. }) => close_block!(),
                Ok(CodexEvent::Usage { usage, .. }) => upstream_usage = usage,
                Ok(CodexEvent::Error(e)) => {
                    yield sse_event("error", &json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": stringify_error(&e)},
                    }));
                    failed = true;
                    break;
                }
                Ok(CodexEvent::Done) => {}
                Err(e) => {
                    yield sse_event("error", &json!({
                        "type": "error",
                        "error": {"type": "api_error", "message": e.to_string()},
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

        let usage = extract_upstream_usage(&upstream_usage).unwrap_or(UsageStats {
            estimated: Some(true),
            ..Default::default()
        });
        if let Some(sink) = &on_usage {
            sink(
                usage.clone(),
                crate::types::UsageMeta {
                    account_id: Some(account_id),
                    model: Some(model.clone()),
                    provider: Some("codex".into()),
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
        yield sse_event("message_stop", &json!({"type": "message_stop"}));
    }
}

/// `anthropicJsonFromCodex` — collect into an Anthropic message object.
pub async fn anthropic_json_from_codex<S>(
    events: S,
    model: &str,
    on_usage: Option<&crate::types::UsageSink>,
    account_id: &str,
) -> Result<Value, CodexStreamError>
where
    S: Stream<Item = Result<CodexEvent, CodexStreamError>> + Send,
{
    let mut events = Box::pin(events);
    let mut content = String::new();
    let mut thinking = String::new();
    let mut upstream_usage = Value::Null;
    let mut tool_calls: Vec<(String, String, Value)> = Vec::new();
    let mut current_tool: Option<(String, Option<String>, String, String)> = None;

    while let Some(item) = events.next().await {
        match item {
            Ok(CodexEvent::Text(t)) => content.push_str(&t),
            Ok(CodexEvent::ReasoningDelta(t)) => thinking.push_str(&t),
            Ok(CodexEvent::ToolUseStart { id, item_id, name }) => {
                current_tool = Some((id, item_id, name, String::new()));
            }
            Ok(CodexEvent::ToolUseArgsDelta { id, item_id, args }) => {
                if let Some(t) = &mut current_tool
                    && matches_tool(&t.0, t.1.as_deref(), &id, item_id.as_deref())
                {
                    t.3.push_str(&args);
                }
            }
            Ok(CodexEvent::ToolUseDone { .. }) => {
                if let Some((id, _, name, args)) = current_tool.take() {
                    tool_calls.push((id, name, safe_json(&json!(args))));
                }
            }
            Ok(CodexEvent::Usage { usage, .. }) => upstream_usage = usage,
            Ok(CodexEvent::Error(e)) => {
                return Err(CodexStreamError::Upstream(stringify_error(&e)));
            }
            Ok(CodexEvent::Done) => {}
            Err(e) => return Err(e),
        }
    }
    if let Some((id, _, name, args)) = current_tool.take() {
        tool_calls.push((id, name, safe_json(&json!(args))));
    }

    let usage = extract_upstream_usage(&upstream_usage).unwrap_or(UsageStats {
        estimated: Some(true),
        ..Default::default()
    });
    if let Some(sink) = on_usage {
        sink(
            usage.clone(),
            crate::types::UsageMeta {
                account_id: Some(account_id.to_string()),
                model: Some(model.to_string()),
                provider: Some("codex".into()),
            },
        );
    }

    let mut blocks: Vec<Value> = Vec::new();
    if !thinking.is_empty() {
        blocks.push(json!({ "type": "thinking", "thinking": thinking }));
    }
    if !content.is_empty() {
        blocks.push(json!({ "type": "text", "text": content }));
    }
    for (id, name, input) in &tool_calls {
        blocks.push(json!({ "type": "tool_use", "id": id, "name": name, "input": input }));
    }
    if blocks.is_empty() {
        blocks.push(json!({ "type": "text", "text": "" }));
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
