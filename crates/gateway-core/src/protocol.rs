//! Protocol adapters — port of `core/protocolAdapters.ts`:
//! Anthropic Messages ⇄ OpenAI Chat Completions, including the SSE
//! event-stream state machine.

use std::collections::BTreeMap;
use std::collections::VecDeque;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};

/// Anthropic `body.system` may be a string or an array of text blocks.
fn extract_anthropic_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(s) => s.clone(),
                Value::Object(block) => {
                    if block.get("type").and_then(Value::as_str) == Some("text")
                        || block.get("text").is_some()
                    {
                        block
                            .get("text")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string()
                    } else if block.get("type").and_then(Value::as_str) == Some("tool_result") {
                        extract_anthropic_text(block.get("content").unwrap_or(&Value::Null))
                    } else {
                        String::new()
                    }
                }
                _ => String::new(),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(block) => block
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| {
                extract_anthropic_text(block.get("content").unwrap_or(&Value::Null))
            }),
        other => other.to_string(),
    }
}

fn extract_openai_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(s) => s.clone(),
                Value::Object(o) => o
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        other => other.to_string(),
    }
}

fn uuid_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}

/// `anthropicMessagesToOpenAIChatCompletions` — port.
pub fn anthropic_messages_to_openai(body: &Value, model: &str) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    let system = extract_anthropic_text(body.get("system").unwrap_or(&Value::Null));
    let system = system.trim();
    if !system.is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }
    if let Some(Value::Array(list)) = body.get("messages") {
        for message in list {
            messages.extend(anthropic_message_to_openai(message));
        }
    }

    let mut converted = json!({
        "model": model,
        "messages": messages,
        "stream": body.get("stream").and_then(Value::as_bool) == Some(true),
    });
    for key in ["temperature", "top_p", "metadata"] {
        if let Some(v) = body.get(key) {
            converted[key] = v.clone();
        }
    }
    if let Some(v) = body.get("max_tokens") {
        converted["max_tokens"] = v.clone();
    }
    if let Some(v) = body.get("stop_sequences") {
        converted["stop"] = v.clone();
    }
    if let Some(Value::Array(tools)) = body.get("tools") {
        converted["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "function": {
                            "name": tool.get("name"),
                            "description": tool.get("description"),
                            "parameters": tool.get("input_schema").cloned()
                                .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                        }
                    })
                })
                .collect(),
        );
    }
    if let Some(choice) = body.get("tool_choice") {
        converted["tool_choice"] = anthropic_tool_choice_to_openai(choice);
    }
    converted
}

fn anthropic_tool_choice_to_openai(choice: &Value) -> Value {
    match choice.get("type").and_then(Value::as_str) {
        Some("auto") => json!("auto"),
        Some("any") => json!("required"),
        Some("none") => json!("none"),
        Some("tool") => json!({ "type": "function", "function": { "name": choice.get("name") } }),
        _ => choice.clone(),
    }
}

fn anthropic_message_to_openai(message: &Value) -> Vec<Value> {
    let role = match message.get("role").and_then(Value::as_str) {
        Some("assistant") => "assistant",
        _ => "user",
    };
    let content = message.get("content").unwrap_or(&Value::Null);
    if role == "assistant" {
        return vec![anthropic_assistant_to_openai(content)];
    }
    anthropic_user_to_openai(content)
}

fn anthropic_assistant_to_openai(content: &Value) -> Value {
    if let Value::String(s) = content {
        return json!({ "role": "assistant", "content": s });
    }
    let blocks = content.as_array().cloned().unwrap_or_default();
    let text = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .map(|b| b.get("text").and_then(Value::as_str).unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n");
    let tool_calls: Vec<Value> = blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .map(|b| {
            json!({
                "id": b.get("id").and_then(Value::as_str).map(str::to_string)
                    .unwrap_or_else(|| uuid_id("toolu_")),
                "type": "function",
                "function": {
                    "name": b.get("name").and_then(Value::as_str).unwrap_or("tool"),
                    "arguments": serde_json::to_string(
                        b.get("input").unwrap_or(&json!({}))
                    ).unwrap_or_else(|_| "{}".into()),
                }
            })
        })
        .collect();
    let mut message = json!({
        "role": "assistant",
        "content": if !text.is_empty() { json!(text) } else if tool_calls.is_empty() { json!("") } else { Value::Null },
    });
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    message
}

fn anthropic_user_to_openai(content: &Value) -> Vec<Value> {
    if let Value::String(s) = content {
        return vec![json!({ "role": "user", "content": s })];
    }
    let blocks = content.as_array().cloned().unwrap_or_default();
    let mut user_parts: Vec<Value> = Vec::new();
    let mut messages: Vec<Value> = Vec::new();
    for block in &blocks {
        if block.get("type").and_then(Value::as_str) == Some("tool_result") {
            if !user_parts.is_empty() {
                messages.push(json!({
                    "role": "user",
                    "content": compact_openai_content(std::mem::take(&mut user_parts)),
                }));
            }
            messages.push(json!({
                "role": "tool",
                "tool_call_id": block
                    .get("tool_use_id")
                    .or_else(|| block.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| uuid_id("toolu_")),
                "content": extract_anthropic_text(block.get("content").unwrap_or(&Value::Null)),
            }));
            continue;
        }
        user_parts.push(anthropic_block_to_part(block));
    }
    if !user_parts.is_empty() || messages.is_empty() {
        messages.push(json!({
            "role": "user",
            "content": compact_openai_content(user_parts),
        }));
    }
    messages
}

fn anthropic_block_to_part(block: &Value) -> Value {
    let block_type = block.get("type").and_then(Value::as_str);
    if block_type.is_none() || block_type == Some("text") {
        return json!({
            "type": "text",
            "text": block.get("text").and_then(Value::as_str).unwrap_or(""),
        });
    }
    if block_type == Some("image")
        && let Some(source) = block.get("source")
    {
        let url = if source.get("type").and_then(Value::as_str) == Some("base64") {
            format!(
                "data:{};base64,{}",
                source
                    .get("media_type")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png"),
                source.get("data").and_then(Value::as_str).unwrap_or("")
            )
        } else {
            source
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        if !url.is_empty() {
            return json!({ "type": "image_url", "image_url": { "url": url } });
        }
    }
    json!({ "type": "text", "text": extract_anthropic_text(block) })
}

fn compact_openai_content(parts: Vec<Value>) -> Value {
    let normalized: Vec<Value> = parts
        .into_iter()
        .filter(|p| {
            p.get("type").and_then(Value::as_str) != Some("text")
                || p.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| !t.is_empty())
        })
        .collect();
    if normalized.is_empty() {
        return json!("");
    }
    if normalized
        .iter()
        .all(|p| p.get("type").and_then(Value::as_str) == Some("text"))
    {
        return json!(
            normalized
                .iter()
                .map(|p| p.get("text").and_then(Value::as_str).unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n")
        );
    }
    Value::Array(normalized)
}

/// `openAIChatCompletionToAnthropicMessage` — port.
pub fn openai_completion_to_anthropic(
    completion: &Value,
    model: &str,
    original_body: &Value,
) -> Value {
    let choice = completion
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .cloned()
        .unwrap_or(Value::Null);
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let usage = completion.get("usage").cloned().unwrap_or(Value::Null);

    let input_tokens = numeric(
        usage
            .get("prompt_tokens")
            .or_else(|| usage.get("input_tokens")),
    );
    let input_tokens = if input_tokens > 0 {
        input_tokens
    } else {
        estimate_input(original_body)
    };
    let output_tokens = numeric(
        usage
            .get("completion_tokens")
            .or_else(|| usage.get("output_tokens")),
    );

    json!({
        "id": to_anthropic_message_id(completion.get("id")),
        "type": "message",
        "role": "assistant",
        "model": completion.get("model").and_then(Value::as_str).unwrap_or(model),
        "content": openai_message_to_anthropic_content(&message),
        "stop_reason": openai_finish_reason_to_anthropic(
            choice.get("finish_reason").and_then(Value::as_str)
        ),
        "stop_sequence": null,
        "usage": {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        },
    })
}

fn openai_message_to_anthropic_content(message: &Value) -> Value {
    let mut blocks: Vec<Value> = Vec::new();
    let text = extract_openai_text(message.get("content").unwrap_or(&Value::Null));
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    if let Some(Value::Array(calls)) = message.get("tool_calls") {
        for call in calls {
            let args = call
                .get("function")
                .and_then(|f| f.get("arguments"))
                .and_then(Value::as_str)
                .unwrap_or("");
            blocks.push(json!({
                "type": "tool_use",
                "id": call.get("id").and_then(Value::as_str).map(str::to_string)
                    .unwrap_or_else(|| uuid_id("toolu_")),
                "name": call
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                    .unwrap_or("tool"),
                "input": parse_json_object(args),
            }));
        }
    }
    if blocks.is_empty() {
        blocks.push(json!({ "type": "text", "text": "" }));
    }
    Value::Array(blocks)
}

fn parse_json_object(value: &str) -> Value {
    match serde_json::from_str::<Value>(value) {
        Ok(v) if v.is_object() => v,
        Ok(v) => json!({ "value": v }),
        Err(_) => json!({ "arguments": value }),
    }
}

fn to_anthropic_message_id(value: Option<&Value>) -> String {
    if let Some(text) = value.and_then(Value::as_str)
        && text.starts_with("msg_")
    {
        return text.to_string();
    }
    uuid_id("msg_")
}

fn estimate_input(body: &Value) -> u64 {
    let text = serde_json::to_string(body).unwrap_or_default();
    (text.len() as u64 / 4).max(1)
}

fn numeric(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.trunc() as u64)
        .unwrap_or(0)
}

fn openai_finish_reason_to_anthropic(reason: Option<&str>) -> String {
    match reason {
        Some("length") => "max_tokens".into(),
        Some("tool_calls") | Some("function_call") => "tool_use".into(),
        Some("stop") | None => "end_turn".into(),
        Some(other) => other.to_string(),
    }
}

fn openai_usage_to_anthropic(usage: &Value) -> Value {
    json!({
        "input_tokens": numeric(usage.get("prompt_tokens").or_else(|| usage.get("input_tokens"))),
        "output_tokens": numeric(usage.get("completion_tokens").or_else(|| usage.get("output_tokens"))),
    })
}

fn sse_event(event: &str, data: Value) -> String {
    format!(
        "event: {event}\ndata: {}\n\n",
        serde_json::to_string(&data).unwrap_or_else(|_| "{}".into())
    )
}

// ---------------------------------------------------------------------------
// SSE parsing — eventsource-parser semantics (data payload only is enough;
// the transformer ignores event names since OpenAI SSE is data-only)
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct SseParser {
    buffer: String,
    data: String,
    event_name: Option<String>,
}

impl SseParser {
    /// Feed a text chunk; returns completed event data payloads.
    pub fn feed(&mut self, chunk: &str) -> Vec<String> {
        self.feed_blocks(chunk)
            .into_iter()
            .map(|(_, data)| data)
            .collect()
    }

    /// Like `feed` but keeps the `event:` field — returns
    /// `(event_name, data)` pairs for upstreams that name their frames
    /// (`response.*` events).
    pub fn feed_blocks(&mut self, chunk: &str) -> Vec<(Option<String>, String)> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buffer.find('\n') {
            let mut line: String = self.buffer.drain(..=pos).collect();
            line.pop(); // '\n'
            if line.ends_with('\r') {
                line.pop();
            }
            if line.is_empty() {
                if !self.data.is_empty() {
                    events.push((self.event_name.take(), std::mem::take(&mut self.data)));
                }
                continue;
            }
            if line.starts_with(':') {
                continue; // comment
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_str(), ""),
            };
            match field {
                "data" => {
                    if !self.data.is_empty() {
                        self.data.push('\n');
                    }
                    self.data.push_str(value);
                }
                "event" => self.event_name = Some(value.to_string()),
                _ => {}
            }
        }
        events
    }

    /// Flush any trailing unterminated event at EOF.
    pub fn finish(&mut self) -> Vec<String> {
        let mut out = self.feed("\n");
        if !self.data.is_empty() {
            out.push(std::mem::take(&mut self.data));
        }
        out
    }
}

/// `extractText` port (kiro/converters) — pull text out of a chat/anthropic
/// content value (string, parts array, or {text} object).
pub fn extract_text(content: &Value) -> String {
    match content {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part {
                Value::String(s) => s.clone(),
                Value::Object(o) => match o.get("type").and_then(Value::as_str) {
                    Some("text") => o
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                    Some("tool_result") => extract_text(o.get("content").unwrap_or(&Value::Null)),
                    _ => o
                        .get("text")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                },
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join(""),
        Value::Object(o) => o
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------
// openAIChatCompletionSseToAnthropicMessageSse — the event state machine
// ---------------------------------------------------------------------------

struct AnthropicSseTransformer {
    id: String,
    model: String,
    message_started: bool,
    text_block_open: bool,
    any_content_block: bool,
    block_index: u64,
    stop_reason: String,
    usage: Value,
    tool_calls: BTreeMap<u64, ToolCallAcc>,
    completed: bool,
}

#[derive(Default)]
struct ToolCallAcc {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl AnthropicSseTransformer {
    fn new(model: String) -> Self {
        Self {
            id: uuid_id("msg_"),
            model,
            message_started: false,
            text_block_open: false,
            any_content_block: false,
            block_index: 0,
            stop_reason: "end_turn".into(),
            usage: json!({ "input_tokens": 0, "output_tokens": 0 }),
            tool_calls: BTreeMap::new(),
            completed: false,
        }
    }

    fn ensure_message(&mut self, out: &mut Vec<String>) {
        if self.message_started {
            return;
        }
        self.message_started = true;
        out.push(sse_event(
            "message_start",
            json!({
                "type": "message_start",
                "message": {
                    "id": self.id,
                    "type": "message",
                    "role": "assistant",
                    "model": self.model,
                    "content": [],
                    "stop_reason": null,
                    "stop_sequence": null,
                    "usage": { "input_tokens": 0, "output_tokens": 0 },
                },
            }),
        ));
    }

    fn ensure_text_block(&mut self, out: &mut Vec<String>) {
        self.ensure_message(out);
        if self.text_block_open {
            return;
        }
        self.text_block_open = true;
        self.any_content_block = true;
        out.push(sse_event(
            "content_block_start",
            json!({
                "type": "content_block_start",
                "index": self.block_index,
                "content_block": { "type": "text", "text": "" },
            }),
        ));
    }

    fn close_text_block(&mut self, out: &mut Vec<String>) {
        if !self.text_block_open {
            return;
        }
        out.push(sse_event(
            "content_block_stop",
            json!({ "type": "content_block_stop", "index": self.block_index }),
        ));
        self.text_block_open = false;
        self.block_index += 1;
    }

    fn finalize(&mut self, out: &mut Vec<String>) {
        self.ensure_message(out);
        self.close_text_block(out);
        if !self.tool_calls.is_empty() {
            let calls: Vec<(u64, ToolCallAcc)> =
                std::mem::take(&mut self.tool_calls).into_iter().collect();
            for (index, call) in calls {
                let tool_index = self.block_index;
                self.block_index += 1;
                self.any_content_block = true;
                let name = call.name.unwrap_or_else(|| format!("tool_{index}"));
                out.push(sse_event(
                    "content_block_start",
                    json!({
                        "type": "content_block_start",
                        "index": tool_index,
                        "content_block": {
                            "type": "tool_use",
                            "id": call.id.unwrap_or_else(|| uuid_id("toolu_")),
                            "name": name,
                            "input": {},
                        },
                    }),
                ));
                out.push(sse_event(
                    "content_block_delta",
                    json!({
                        "type": "content_block_delta",
                        "index": tool_index,
                        "delta": {
                            "type": "input_json_delta",
                            "partial_json": if call.arguments.is_empty() { "{}" } else { &call.arguments },
                        },
                    }),
                ));
                out.push(sse_event(
                    "content_block_stop",
                    json!({ "type": "content_block_stop", "index": tool_index }),
                ));
            }
            self.stop_reason = "tool_use".into();
        }
        if !self.any_content_block {
            out.push(sse_event(
                "content_block_start",
                json!({
                    "type": "content_block_start",
                    "index": self.block_index,
                    "content_block": { "type": "text", "text": "" },
                }),
            ));
            out.push(sse_event(
                "content_block_stop",
                json!({ "type": "content_block_stop", "index": self.block_index }),
            ));
        }
        out.push(sse_event(
            "message_delta",
            json!({
                "type": "message_delta",
                "delta": { "stop_reason": self.stop_reason, "stop_sequence": null },
                "usage": self.usage,
            }),
        ));
        out.push(sse_event("message_stop", json!({ "type": "message_stop" })));
        self.completed = true;
    }

    /// Feed one parsed SSE data payload; returns emitted anthropic frames.
    fn feed(&mut self, data: &str) -> Vec<String> {
        let mut out = Vec::new();
        if data.trim() == "[DONE]" {
            if !self.completed {
                self.finalize(&mut out);
            }
            return out;
        }
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            return out;
        };

        if let Some(error) = payload.get("error") {
            out.push(sse_event(
                "error",
                json!({
                    "type": "error",
                    "error": {
                        "type": error.get("type").and_then(Value::as_str).unwrap_or("api_error"),
                        "message": error.get("message").and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| error.to_string()),
                    },
                }),
            ));
            self.completed = true;
            return out;
        }

        if let Some(m) = payload.get("model").and_then(Value::as_str) {
            self.model = m.to_string();
        }
        if let Some(u) = payload.get("usage") {
            self.usage = openai_usage_to_anthropic(u);
        }

        let Some(choice) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
        else {
            return out;
        };
        let delta = choice.get("delta").cloned().unwrap_or(Value::Null);

        if let Some(text) = delta.get("content").and_then(Value::as_str)
            && !text.is_empty()
        {
            self.ensure_text_block(&mut out);
            out.push(sse_event(
                "content_block_delta",
                json!({
                    "type": "content_block_delta",
                    "index": self.block_index,
                    "delta": { "type": "text_delta", "text": text },
                }),
            ));
        }

        if let Some(Value::Array(items)) = delta.get("tool_calls") {
            for item in items {
                let index = item
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.tool_calls.len() as u64);
                let acc = self.tool_calls.entry(index).or_default();
                if let Some(id) = item.get("id").and_then(Value::as_str) {
                    acc.id = Some(id.to_string());
                }
                if let Some(name) = item
                    .get("function")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
                {
                    let current = acc.name.take().unwrap_or_default();
                    acc.name = Some(format!("{current}{name}"));
                }
                if let Some(args) = item
                    .get("function")
                    .and_then(|f| f.get("arguments"))
                    .and_then(Value::as_str)
                {
                    acc.arguments.push_str(args);
                }
            }
        }

        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.stop_reason = openai_finish_reason_to_anthropic(Some(reason));
        }
        out
    }

    fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.completed {
            self.finalize(&mut out);
        }
        out
    }
}

/// Wrap an OpenAI chat-completions SSE text stream into the Anthropic
/// messages event stream (port of `openAIChatCompletionSseToAnthropicMessageSse`).
pub fn openai_sse_to_anthropic<S>(source: S, model: String) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = String> + Send,
{
    struct State<S> {
        source: std::pin::Pin<Box<S>>,
        parser: SseParser,
        transformer: AnthropicSseTransformer,
        pending: VecDeque<String>,
        eof: bool,
    }
    futures::stream::unfold(
        State {
            source: Box::pin(source),
            parser: SseParser::default(),
            transformer: AnthropicSseTransformer::new(model),
            pending: VecDeque::new(),
            eof: false,
        },
        |mut st| async move {
            loop {
                if let Some(frame) = st.pending.pop_front() {
                    return Some((frame, st));
                }
                if st.eof {
                    return None;
                }
                match st.source.next().await {
                    Some(chunk) => {
                        for data in st.parser.feed(&chunk) {
                            st.pending.extend(st.transformer.feed(&data));
                        }
                    }
                    None => {
                        for data in st.parser.finish() {
                            st.pending.extend(st.transformer.feed(&data));
                        }
                        st.pending.extend(st.transformer.finish());
                        st.eof = true;
                    }
                }
            }
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;

    #[test]
    fn anthropic_to_openai_body() {
        let body = json!({
            "model": "claude-x",
            "system": [{"type": "text", "text": "be nice"}],
            "messages": [
                {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"role": "assistant", "content": [
                    {"type": "text", "text": "hello"},
                    {"type": "tool_use", "id": "t1", "name": "bash", "input": {"cmd": "ls"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "ok"},
                    {"type": "text", "text": "done"},
                ]},
            ],
            "max_tokens": 100,
            "stream": true,
        });
        let out = anthropic_messages_to_openai(&body, "nvidia/model");
        assert_eq!(out["model"], "nvidia/model");
        assert_eq!(out["stream"], true);
        assert_eq!(out["max_tokens"], 100);
        assert_eq!(out["messages"][0]["role"], "system");
        assert_eq!(out["messages"][1]["content"], "hi");
        // assistant: text + tool_calls
        assert_eq!(
            out["messages"][2]["tool_calls"][0]["function"]["name"],
            "bash"
        );
        // tool result becomes role:tool then user text
        assert_eq!(out["messages"][3]["role"], "tool");
        assert_eq!(out["messages"][3]["tool_call_id"], "t1");
        assert_eq!(out["messages"][4]["content"], "done");
    }

    #[tokio::test]
    async fn openai_sse_to_anthropic_stream() {
        let chunks = vec![
            "data: {\"id\":\"c1\",\"choices\":[{\"delta\":{\"content\":\"Hel\"}}]}\n\n".to_string(),
            "data: {\"id\":\"c1\",\"choices\":[{\"delta\":{\"content\":\"lo\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\n".to_string(),
            "data: [DONE]\n\n".to_string(),
        ];
        let stream = futures::stream::iter(chunks);
        let out: Vec<String> = openai_sse_to_anthropic(stream, "m".into()).collect().await;
        let joined = out.join("");
        assert!(joined.contains("event: message_start"));
        assert!(joined.contains("\"text_delta\",\"text\":\"Hel\""));
        assert!(joined.contains("\"text\":\"lo\""));
        assert!(joined.contains("event: message_delta"));
        assert!(joined.contains("event: message_stop"));
    }
}
