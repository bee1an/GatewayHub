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

mod out;
pub use out::*;

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
        while let Some((pos, kind)) = self.find_next_json_from(search_offset) {
            let end = find_matching_brace(&self.buffer, pos);
            if end == usize::MAX {
                break; // wait for more chunks
            }
            let json_str = self.buffer[pos..=end].to_string();
            match serde_json::from_str::<Value>(&json_str) {
                Ok(data) => {
                    self.buffer.drain(..=end);
                    search_offset = 0;
                    if let Some(ev) = self.process(data, kind) {
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
            .map(KiroEvent::ToolUse)
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
