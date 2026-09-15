//! `deriveGatewaySession` port — stable conversation/session identity from
//! metadata → body keys → headers → deterministic content hash → request id.

use serde_json::Value;

use crate::apikey::sha256_short;
use crate::types::{ApiFormat, ApiKeyEntry};

pub struct GatewaySessionInfo {
    pub id: String,
    pub source: &'static str,
}

const METADATA_SESSION_KEYS: &[&str] = &[
    "session_id",
    "sessionId",
    "claude_session_id",
    "claudeSessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
];

const BODY_SESSION_KEYS: &[&str] = &[
    "session_id",
    "sessionId",
    "claude_session_id",
    "claudeSessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
    "client_session_id",
    "clientSessionId",
    "chat_session_id",
    "chatSessionId",
];

const HEADER_SESSION_KEYS: &[&str] = &[
    "x-claude-session-id",
    "x-session-id",
    "x-conversation-id",
    "x-thread-id",
    "x-codex-session-id",
    "anthropic-session-id",
];

pub fn derive_gateway_session(
    headers: &axum::http::HeaderMap,
    body: &Value,
    api_key: &ApiKeyEntry,
    request_id: &str,
    api_format: ApiFormat,
) -> GatewaySessionInfo {
    if let Some(id) = pick(body.get("metadata"), METADATA_SESSION_KEYS) {
        return GatewaySessionInfo {
            id,
            source: "metadata",
        };
    }
    if let Some(id) = pick(Some(body), BODY_SESSION_KEYS) {
        return GatewaySessionInfo { id, source: "body" };
    }
    for key in HEADER_SESSION_KEYS {
        if let Some(v) = headers.get(*key).and_then(|v| v.to_str().ok())
            && let Some(id) = normalize_session(v)
        {
            return GatewaySessionInfo {
                id,
                source: "header",
            };
        }
    }
    if let Some(id) = derive_fallback(body, api_key, api_format) {
        return GatewaySessionInfo {
            id,
            source: "fallback",
        };
    }
    GatewaySessionInfo {
        id: request_id.to_string(),
        source: "request",
    }
}

fn pick(value: Option<&Value>, keys: &[&str]) -> Option<String> {
    let Value::Object(map) = value? else {
        return None;
    };
    keys.iter()
        .filter_map(|k| map.get(*k))
        .filter_map(|v| v.as_str())
        .find_map(normalize_session)
}

fn normalize_session(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .trim()
        .chars()
        .filter(|c| !c.is_control() && *c != '\u{7f}')
        .take(256)
        .collect();
    (!cleaned.is_empty()).then_some(cleaned)
}

fn derive_fallback(body: &Value, api_key: &ApiKeyEntry, api_format: ApiFormat) -> Option<String> {
    let first_user = find_first_user_text(body.get("messages"));
    let system = extract_system_text(body);
    if first_user.is_empty() && system.is_empty() {
        return None;
    }
    let key_scope = if !api_key.id.is_empty() {
        api_key.id.clone()
    } else {
        sha256_short(&format!("{}{}", api_key.key, api_key.name))
    };
    Some(sha256_short(&serde_json::json!({
        "v": 1,
        "apiFormat": api_format,
        "keyScope": key_scope,
        "model": body.get("model").and_then(Value::as_str).unwrap_or(""),
        "user": body.get("user").and_then(Value::as_str).and_then(normalize_session).unwrap_or_default(),
        "firstUser": if first_user.is_empty() { String::new() } else { sha256_short_n(&first_user, 24) },
        "system": if system.is_empty() { String::new() } else { sha256_short_n(&system, 16) },
    }).to_string()))
}

fn sha256_short_n(input: &str, n: usize) -> String {
    use sha2::Digest;
    let digest = sha2::Sha256::digest(input.as_bytes());
    digest
        .iter()
        .take(n / 2)
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn find_first_user_text(messages: Option<&Value>) -> String {
    let Some(Value::Array(list)) = messages else {
        return String::new();
    };
    for message in list {
        if message.get("role").and_then(Value::as_str) == Some("user") {
            let text = content_to_plain_text(
                message
                    .get("content")
                    .or_else(|| message.get("contents"))
                    .unwrap_or(&Value::Null),
            );
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn extract_system_text(body: &Value) -> String {
    let direct = content_to_plain_text(body.get("system").unwrap_or(&Value::Null));
    if !direct.trim().is_empty() {
        return direct.trim().to_string();
    }
    let Some(Value::Array(messages)) = body.get("messages") else {
        return String::new();
    };
    messages
        .iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
        .map(|m| {
            content_to_plain_text(
                m.get("content")
                    .or_else(|| m.get("contents"))
                    .unwrap_or(&Value::Null),
            )
        })
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn content_to_plain_text(value: &Value) -> String {
    content_to_plain_text_depth(value, 0)
}

fn content_to_plain_text_depth(value: &Value, depth: usize) -> String {
    if depth > 6 {
        return String::new();
    }
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|i| content_to_plain_text_depth(i, depth + 1))
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(record) => {
            if let Some(t) = record.get("text").and_then(Value::as_str) {
                return t.to_string();
            }
            if let Some(t) = record.get("input_text").and_then(Value::as_str) {
                return t.to_string();
            }
            if let Some(c) = record.get("content") {
                return content_to_plain_text_depth(c, depth + 1);
            }
            if let Some(c) = record.get("contents") {
                return content_to_plain_text_depth(c, depth + 1);
            }
            String::new()
        }
        _ => String::new(),
    }
}
