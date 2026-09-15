//! Kiro upstream stream — port of `providers/kiro/streaming.ts`.
//! The CodeWhisperer runtime emits a JSON-fragment stream (not SSE); the
//! `AwsEventStreamParser` scans for known `{"key":` openings, brace-matches
//! the payload, and tolerates LLM text interleaved between frames.

use std::collections::VecDeque;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};

use crate::providers::kiro_convert::{anthropic_input_tokens, estimate_tokens};
use crate::types::UsageStats;

const PARSER_BUFFER_SOFT_LIMIT: usize = 1024 * 1024;
const DEDUPE_MIN_LENGTH: usize = 32;

#[derive(Debug)]
pub enum KiroStreamError {
    FirstTokenTimeout(u64),
    IdleTimeout(u64),
    Protocol(String),
    Transport(String),
}

impl std::fmt::Display for KiroStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::FirstTokenTimeout(s) => write!(f, "No Kiro token within {s}s"),
            Self::IdleTimeout(s) => write!(f, "Kiro stream idle timeout after {s}s without data"),
            Self::Protocol(m) => write!(f, "{m}"),
            Self::Transport(m) => write!(f, "{m}"),
        }
    }
}
impl std::error::Error for KiroStreamError {}

#[derive(Debug, Clone)]
pub enum KiroEvent {
    Content(String),
    Thinking(String),
    ToolUse(Value),
    Usage(Value),
    ContextUsage(Value),
    Metering(f64),
}

// ---------------------------------------------------------------------------
// AwsEventStreamParser
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct AwsEventStreamParser {
    buffer: String,
    last_content: String,
    current_tool: Option<(String, String)>, // (id, name)
    current_inputs: Vec<Value>,
    tool_calls: Vec<Value>,
}

impl AwsEventStreamParser {
    pub fn feed(&mut self, chunk: &str) -> Result<Vec<KiroEvent>, KiroStreamError> {
        self.buffer.push_str(chunk);
        if self.buffer.len() > PARSER_BUFFER_SOFT_LIMIT {
            return Err(KiroStreamError::Protocol(format!(
                "event-stream buffer overflow ({} bytes > {PARSER_BUFFER_SOFT_LIMIT})",
                self.buffer.len()
            )));
        }
        let mut events = Vec::new();
        let mut search_offset = 0usize;
        loop {
            let Some((pos, kind)) = self.find_next_json_from(search_offset) else {
                break;
            };
            let end = find_matching_brace(&self.buffer, pos);
            if end == usize::MAX {
                break; // wait for more chunks
            }
            let json_str = self.buffer[pos..=end].to_string();
            match serde_json::from_str::<Value>(&json_str) {
                Ok(data) => {
                    self.buffer.drain(..=end);
                    search_offset = 0;
                    if let Some(ev) = self.process(data, &kind) {
                        events.push(ev);
                    }
                }
                Err(_) => search_offset = pos + 1, // substring inside LLM text
            }
        }
        Ok(events)
    }

    pub fn finish(&mut self) -> Vec<KiroEvent> {
        if self.current_tool.is_some() {
            self.finalize_tool_call();
        }
        dedupe_tool_calls(std::mem::take(&mut self.tool_calls))
            .into_iter()
            .map(|tool| KiroEvent::ToolUse(tool))
            .collect()
    }

    fn find_next_json_from(&self, offset: usize) -> Option<(usize, &'static str)> {
        // metering must precede usage: {"unit":"credit","usage":…} would
        // otherwise match the usage pattern.
        let patterns: [(&str, &str); 7] = [
            ("{\"content\":", "content"),
            ("{\"name\":", "tool_start"),
            ("{\"input\":", "tool_input"),
            ("{\"stop\":", "tool_stop"),
            ("{\"unit\":", "metering"),
            ("{\"usage\":", "usage"),
            ("{\"contextUsagePercentage\":", "context_usage"),
        ];
        let mut best: Option<(usize, &'static str)> = None;
        for (pat, kind) in patterns {
            if let Some(pos) = self.buffer[offset..].find(pat) {
                let abs = offset + pos;
                if best.is_none_or(|(b, _)| abs < b) {
                    best = Some((abs, kind));
                }
            }
        }
        best
    }

    fn process(&mut self, data: Value, kind: &str) -> Option<KiroEvent> {
        match kind {
            "content" => {
                if data.get("followupPrompt").is_some() {
                    return None;
                }
                let content = data.get("content").and_then(Value::as_str).unwrap_or("");
                if content.is_empty() {
                    return None;
                }
                if content == self.last_content
                    && self.last_content.len() >= DEDUPE_MIN_LENGTH
                    && content.len() >= DEDUPE_MIN_LENGTH
                {
                    return None;
                }
                self.last_content = content.to_string();
                Some(KiroEvent::Content(content.to_string()))
            }
            "tool_start" => {
                // {"name":"Bash","stop":true,"toolUseId":…} is a terminal
                // frame that scans as tool_start
                if data.get("stop").and_then(Value::as_bool) == Some(true)
                    && data.get("input").is_none()
                {
                    if self.current_tool.is_some() {
                        self.finalize_tool_call();
                    }
                    return None;
                }
                if self.current_tool.is_some() {
                    self.finalize_tool_call();
                }
                self.current_tool = Some((
                    data.get("toolUseId")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                    data.get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                ));
                self.current_inputs = Vec::new();
                self.append_tool_input(data.get("input"));
                if data.get("stop").and_then(Value::as_bool) == Some(true) {
                    self.finalize_tool_call();
                }
                None
            }
            "tool_input" => {
                if self.current_tool.is_some() {
                    self.append_tool_input(data.get("input"));
                }
                None
            }
            "tool_stop" => {
                if self.current_tool.is_some()
                    && data.get("stop").and_then(Value::as_bool) == Some(true)
                {
                    self.finalize_tool_call();
                }
                None
            }
            "metering" => {
                let unit = data
                    .get("unit")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_lowercase();
                let usage = data.get("usage").and_then(Value::as_f64);
                match (unit.as_str(), usage) {
                    ("credit", Some(u)) if u.is_finite() => Some(KiroEvent::Metering(u)),
                    _ => None,
                }
            }
            "usage" => Some(KiroEvent::Usage(
                data.get("usage").cloned().unwrap_or(Value::Null),
            )),
            "context_usage" => Some(KiroEvent::ContextUsage(
                data.get("contextUsagePercentage")
                    .cloned()
                    .unwrap_or(Value::Null),
            )),
            _ => None,
        }
    }

    fn finalize_tool_call(&mut self) {
        if let Some((id, name)) = self.current_tool.take() {
            let input = normalize_tool_input(std::mem::take(&mut self.current_inputs));
            self.tool_calls.push(json!({
                "id": id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": serde_json::to_string(&input).unwrap_or_else(|_| "{}".into()),
                },
            }));
        }
    }

    fn append_tool_input(&mut self, input: Option<&Value>) {
        match input {
            None | Some(Value::Null) => {}
            Some(Value::String(s)) if s.is_empty() => {}
            Some(v) => self.current_inputs.push(v.clone()),
        }
    }
}

// ---------------------------------------------------------------------------
// ThinkingTagParser — splits <thinking>…</thinking> inside content events
// ---------------------------------------------------------------------------

#[derive(Default)]
struct ThinkingTagParser {
    in_thinking: bool,
    carry: String,
}

impl ThinkingTagParser {
    fn process(&mut self, event: KiroEvent) -> Vec<KiroEvent> {
        let KiroEvent::Content(content) = &event else {
            return vec![event];
        };
        if content.is_empty() {
            return vec![event];
        }
        let mut out = Vec::new();
        let mut text = format!("{}{}", self.carry, content);
        self.carry.clear();
        while !text.is_empty() {
            let tag = if self.in_thinking {
                "</thinking>"
            } else {
                "<thinking>"
            };
            match text.find(tag) {
                None => {
                    let carry = tag_prefix_suffix(&text, tag);
                    let head = if carry.is_empty() {
                        text.clone()
                    } else {
                        text[..text.len() - carry.len()].to_string()
                    };
                    if !head.is_empty() {
                        out.push(self.emit(head));
                    }
                    self.carry = carry;
                    return out;
                }
                Some(idx) => {
                    let head = text[..idx].to_string();
                    if !head.is_empty() {
                        out.push(self.emit(head));
                    }
                    self.in_thinking = !self.in_thinking;
                    text = text[idx + tag.len()..].to_string();
                }
            }
        }
        out
    }

    fn finish(&mut self) -> Vec<KiroEvent> {
        if self.carry.is_empty() {
            return Vec::new();
        }
        let carry = std::mem::take(&mut self.carry);
        vec![self.emit(carry)]
    }

    fn emit(&self, text: String) -> KiroEvent {
        if self.in_thinking {
            KiroEvent::Thinking(text)
        } else {
            KiroEvent::Content(text)
        }
    }
}

fn tag_prefix_suffix(text: &str, tag: &str) -> String {
    let max = text.len().min(tag.len() - 1);
    for len in (1..=max).rev() {
        let suffix = &text[text.len() - len..];
        if tag.starts_with(suffix) {
            return suffix.to_string();
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// parse_kiro_stream — bytes → events with timeouts
// ---------------------------------------------------------------------------

pub fn parse_kiro_stream(
    response: reqwest::Response,
    first_token_timeout: Duration,
    idle_timeout: Duration,
) -> impl Stream<Item = Result<KiroEvent, KiroStreamError>> + Send {
    let mut byte_stream = response.bytes_stream();
    async_stream::stream! {
        let mut parser = AwsEventStreamParser::default();
        let mut thinking = ThinkingTagParser::default();
        let mut pending: VecDeque<Result<KiroEvent, KiroStreamError>> = VecDeque::new();
        let mut tail: Vec<u8> = Vec::new();
        let mut first = true;

        loop {
            let timeout = if first { first_token_timeout } else { idle_timeout };
            let item = tokio::time::timeout(timeout, byte_stream.next()).await;
            let chunk = match item {
                Ok(Some(Ok(b))) => b,
                Ok(Some(Err(e))) => {
                    yield Err(KiroStreamError::Transport(e.to_string()));
                    break;
                }
                Ok(None) => break,
                Err(_) => {
                    yield Err(if first {
                        KiroStreamError::FirstTokenTimeout(timeout.as_secs())
                    } else {
                        KiroStreamError::IdleTimeout(timeout.as_secs())
                    });
                    break;
                }
            };
            first = false;
            tail.extend_from_slice(&chunk);
            let valid = match std::str::from_utf8(&tail) {
                Ok(s) => { let o = s.to_string(); tail.clear(); o }
                Err(e) if e.valid_up_to() > 0 => {
                    let o = String::from_utf8_lossy(&tail[..e.valid_up_to()]).into_owned();
                    tail.drain(..e.valid_up_to());
                    o
                }
                Err(_) => continue,
            };
            match parser.feed(&valid) {
                Ok(events) => {
                    for ev in events {
                        for p in thinking.process(ev) {
                            pending.push_back(Ok(p));
                        }
                    }
                }
                Err(e) => pending.push_back(Err(e)),
            }
            while let Some(ev) = pending.pop_front() {
                yield ev;
            }
        }
        if !tail.is_empty()
            && let Ok(events) = parser.feed(&String::from_utf8_lossy(&tail))
        {
            for ev in events {
                for p in thinking.process(ev) {
                    pending.push_back(Ok(p));
                }
            }
        }
        for ev in thinking.finish() {
            pending.push_back(Ok(ev));
        }
        for ev in parser.finish() {
            pending.push_back(Ok(ev));
        }
        while let Some(ev) = pending.pop_front() {
            yield ev;
        }
    }
}

// ---------------------------------------------------------------------------
// usage helpers
// ---------------------------------------------------------------------------

fn pick_number(v: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_f64).filter(|n| n.is_finite()))
        .map(|n| n.max(0.0) as u64)
}

/// `extractUpstreamUsage` — Anthropic-style names + cache_creation.
pub fn extract_upstream_usage(raw: &Value) -> Option<UsageStats> {
    if !raw.is_object() {
        return None;
    }
    let input = pick_number(raw, &["input_tokens", "inputTokens", "prompt_tokens"]);
    let output = pick_number(raw, &["output_tokens", "outputTokens", "completion_tokens"]);
    let cache_read = pick_number(
        raw,
        &[
            "cache_read_input_tokens",
            "cacheReadInputTokens",
            "cached_tokens",
        ],
    );
    let creation = raw
        .get("cache_creation")
        .or_else(|| raw.get("cacheCreation"));
    let w5m = creation
        .and_then(|c| pick_number(c, &["ephemeral_5m_input_tokens", "ephemeral5mInputTokens"]));
    let w1h = creation
        .and_then(|c| pick_number(c, &["ephemeral_1h_input_tokens", "ephemeral1hInputTokens"]));
    let creation_total = pick_number(
        raw,
        &["cache_creation_input_tokens", "cacheCreationInputTokens"],
    );
    if input.is_none() && output.is_none() && cache_read.is_none() && creation_total.is_none() {
        return None;
    }
    Some(UsageStats {
        input_tokens: input.unwrap_or(0),
        output_tokens: output.unwrap_or(0),
        cache_read_tokens: cache_read,
        cache_write5m_tokens: w5m.or(if w1h.is_none() { creation_total } else { None }),
        cache_write1h_tokens: w1h,
        ..Default::default()
    })
}

fn to_openai_usage(u: &UsageStats) -> Value {
    let cached = u.cache_read_tokens.unwrap_or(0);
    let w5m = u.cache_write5m_tokens.unwrap_or(0);
    let w1h = u.cache_write1h_tokens.unwrap_or(0);
    let prompt = u.input_tokens + cached + w5m + w1h;
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
    if u.cache_write5m_tokens.is_some() || u.cache_write1h_tokens.is_some() {
        out["cache_creation_input_tokens"] =
            json!(u.cache_write5m_tokens.unwrap_or(0) + u.cache_write1h_tokens.unwrap_or(0));
    }
    out
}

fn with_credits(mut u: UsageStats, credits: f64) -> UsageStats {
    if credits.is_finite() && credits > 0.0 {
        u.credits = Some(credits);
    }
    u
}

fn fallback_usage(body: &Value, content: &str, thinking: &str) -> UsageStats {
    UsageStats {
        input_tokens: anthropic_input_tokens(body),
        output_tokens: estimate_tokens(&json!(content)) + estimate_tokens(&json!(thinking)),
        estimated: Some(true),
        ..Default::default()
    }
}

fn safe_json(v: &Value) -> Value {
    match v {
        Value::String(s) => serde_json::from_str(s).unwrap_or_else(|_| json!({})),
        Value::Null => json!({}),
        other => other.clone(),
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

// ---------------------------------------------------------------------------
// tool-call merge helpers (dedupeToolCalls / normalizeToolInput)
// ---------------------------------------------------------------------------

fn find_matching_brace(text: &str, start: usize) -> usize {
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

fn dedupe_tool_calls(tools: Vec<Value>) -> Vec<Value> {
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

fn normalize_tool_input(chunks: Vec<Value>) -> Value {
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

fn parse_tool_input_text(text: &str) -> Option<Value> {
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

fn merge_tool_input(target: Value, patch: Value) -> Value {
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

fn merge_string_fragment(prev: &str, next: &str) -> String {
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
    fn parser_extracts_content_and_tool_use() {
        let mut p = AwsEventStreamParser::default();
        let evs = p
            .feed("noise{\"content\":\"Hello\"}more{\"name\":\"bash\",\"toolUseId\":\"t1\",\"input\":{\"cmd\":\"ls\"}}")
            .unwrap();
        assert!(matches!(&evs[0], KiroEvent::Content(t) if t == "Hello"));
        let final_evs = p.finish();
        assert!(matches!(&final_evs[0], KiroEvent::ToolUse(t) if t["function"]["name"] == "bash"));
    }

    #[test]
    fn thinking_tag_splits_content() {
        let mut tp = ThinkingTagParser::default();
        let out = tp.process(KiroEvent::Content("a<thinking>b</thinking>c".into()));
        assert!(matches!(&out[0], KiroEvent::Content(t) if t == "a"));
        assert!(matches!(&out[1], KiroEvent::Thinking(t) if t == "b"));
        assert!(matches!(&out[2], KiroEvent::Content(t) if t == "c"));
    }

    #[test]
    fn metering_accumulates() {
        let mut p = AwsEventStreamParser::default();
        let evs = p.feed("{\"unit\":\"credit\",\"usage\":2.5}").unwrap();
        assert!(matches!(evs[0], KiroEvent::Metering(c) if c == 2.5));
    }
}
