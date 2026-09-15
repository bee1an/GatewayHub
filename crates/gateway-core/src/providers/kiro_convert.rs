//! Kiro payload converters — port of `providers/kiro/converters.ts`.
//! OpenAI/Anthropic bodies → `{conversationState: {currentMessage:
//! {userInputMessage}, history}}` for the CodeWhisperer streaming API.

use serde_json::{Value, json};

use crate::protocol::extract_text;

const EMPTY_MESSAGE_PLACEHOLDER: &str = "";
const EMPTY_TOOL_RESULT_PLACEHOLDER: &str = "(empty result)";

#[derive(Default)]
struct UnifiedMessage {
    role: String,
    content: String,
    tool_calls: Vec<Value>,
    tool_results: Vec<Value>,
    images: Vec<(String, String)>, // (media_type, data)
}

struct UnifiedTool {
    name: String,
    description: String,
    input_schema: Value,
}

/// `estimateTokens` — ~4 chars/token (gpt-tokenizer only for gpt-* models,
/// which kiro never serves).
pub fn estimate_tokens(value: &Value) -> u64 {
    let text = match value {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_default(),
    };
    (text.len() as u64 / 4).max(1)
}

/// `anthropicInputTokens` for the /v1/messages count endpoint + usage
/// fallback.
pub fn anthropic_input_tokens(body: &Value) -> u64 {
    estimate_tokens(&json!({
        "messages": body.get("messages"),
        "system": body.get("system"),
        "tools": body.get("tools"),
    }))
}

pub fn openai_usage_from_bodies(request_body: &Value, content: &str) -> Value {
    let prompt = estimate_tokens(&json!({
        "messages": request_body.get("messages"),
        "tools": request_body.get("tools"),
    }));
    let completion = estimate_tokens(&json!(content));
    json!({
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    })
}

pub fn normalize_kiro_model_id(model: &str) -> String {
    let v = model.trim();
    if v.is_empty() || v == "auto-kiro" {
        return "auto".into();
    }
    // `(\d+)-(\d+)$` → `$1.$2` (claude-sonnet-4-5 → claude-sonnet-4.5)
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(\d+)-(\d+)$").unwrap())
        .replace_all(v, "$1.$2")
        .to_string()
}

/// `buildKiroPayloadFromOpenAI`.
pub fn build_kiro_payload_from_openai(body: &Value, model: &str, profile_arn: &str) -> anyhow::Result<Value> {
    let (system, mut messages) = openai_messages_to_unified(
        body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default(),
    );
    let tools = openai_tools_to_unified(body.get("tools"));
    build_kiro_payload(
        normalize_kiro_model_id(model),
        std::mem::take(&mut messages),
        system,
        tools,
        profile_arn,
        openai_thinking_config(body),
    )
}

/// `buildKiroPayloadFromAnthropic`.
pub fn build_kiro_payload_from_anthropic(body: &Value, model: &str, profile_arn: &str) -> anyhow::Result<Value> {
    let system = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        other => extract_text(other.unwrap_or(&Value::Null)),
    };
    let messages: Vec<UnifiedMessage> = body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .map(|msg| UnifiedMessage {
            role: msg.get("role").and_then(Value::as_str).unwrap_or("user").to_string(),
            content: extract_text(msg.get("content").unwrap_or(&Value::Null)),
            tool_calls: extract_tool_uses(msg.get("content").unwrap_or(&Value::Null)),
            tool_results: extract_tool_results(msg.get("content").unwrap_or(&Value::Null)),
            images: extract_images(msg.get("content").unwrap_or(&Value::Null)),
        })
        .collect();
    let tools = anthropic_tools_to_unified(body.get("tools"));
    build_kiro_payload(
        normalize_kiro_model_id(model),
        messages,
        system,
        tools,
        profile_arn,
        anthropic_thinking_config(body),
    )
}

fn build_kiro_payload(
    model: String,
    mut messages: Vec<UnifiedMessage>,
    system: String,
    tools: Vec<UnifiedTool>,
    profile_arn: &str,
    _thinking: Option<(bool, u64)>, // shape kept for parity; kiro ignores it today
) -> anyhow::Result<Value> {
    for m in messages.iter_mut() {
        if m.role != "assistant" {
            m.role = "user".into();
        }
    }
    if messages.is_empty() {
        anyhow::bail!("No messages to send");
    }
    // ensureAlternating then ensureFirstUser
    let mut alt: Vec<UnifiedMessage> = Vec::new();
    for m in messages {
        if let Some(prev) = alt.last()
            && prev.role == m.role
        {
            alt.push(UnifiedMessage {
                role: if prev.role == "user" { "assistant".into() } else { "user".into() },
                content: EMPTY_MESSAGE_PLACEHOLDER.into(),
                ..Default::default()
            });
        }
        alt.push(m);
    }
    if alt.first().is_some_and(|m| m.role != "user") {
        alt.insert(
            0,
            UnifiedMessage {
                role: "user".into(),
                content: EMPTY_MESSAGE_PLACEHOLDER.into(),
                ..Default::default()
            },
        );
    }

    let mut current = alt.pop().unwrap();
    let mut history_msgs = alt;

    // system prompt folds into the first history user message, else the
    // current one
    if !system.is_empty() {
        if let Some(first) = history_msgs.first_mut()
            && first.role == "user"
        {
            first.content = format!("{system}\n\n{}", first.content);
        } else {
            current.content = format!("{system}\n\n{}", current.content);
        }
    }

    let mut history: Vec<Value> = history_msgs
        .iter()
        .map(|m| to_kiro_history_message(m, &model))
        .collect();

    let mut current_content = if current.content.is_empty() {
        "Continue".to_string()
    } else {
        current.content.clone()
    };
    if current.role == "assistant" {
        history.push(json!({ "assistantResponseMessage": { "content": current_content } }));
        current_content = "Continue".into();
    }

    let mut user_input_message = json!({
        "content": current_content,
        "modelId": model,
        "origin": "AI_EDITOR",
    });
    let images = if !current.images.is_empty() {
        current.images.clone()
    } else {
        extract_images(&json!(current.content))
    };
    let kiro_images = images_to_kiro(&images);
    if !kiro_images.is_empty() {
        user_input_message["images"] = Value::Array(kiro_images);
    }

    let mut context = json!({});
    let kiro_tools = tools_to_kiro(&tools);
    if !kiro_tools.is_empty() {
        context["tools"] = Value::Array(kiro_tools);
    } else {
        let inferred = infer_tools_from_history(&history_msgs, &current);
        if !inferred.is_empty() {
            context["tools"] = Value::Array(inferred);
        }
    }
    let mut results = current.tool_results.clone();
    if results.is_empty() {
        results = extract_tool_results(&json!(current.content));
    }
    let tool_results = tool_results_to_kiro(&results);
    if !tool_results.is_empty() && context.get("tools").is_some_and(|t| !t.as_array().is_none_or(|a| a.is_empty())) {
        context["toolResults"] = Value::Array(tool_results);
    }
    if context.as_object().is_some_and(|o| !o.is_empty()) {
        user_input_message["userInputMessageContext"] = context;
    }

    let mut payload = json!({
        "conversationState": {
            "chatTriggerType": "MANUAL",
            "conversationId": uuid::Uuid::new_v4().to_string(),
            "currentMessage": { "userInputMessage": user_input_message },
        },
    });
    if !history.is_empty() {
        payload["conversationState"]["history"] = Value::Array(history);
    }
    if !profile_arn.is_empty() {
        payload["profileArn"] = json!(profile_arn);
    }
    Ok(payload)
}

fn openai_messages_to_unified(messages: Vec<Value>) -> (String, Vec<UnifiedMessage>) {
    let mut system: Vec<String> = Vec::new();
    let mut result: Vec<UnifiedMessage> = Vec::new();
    let mut pending_tool_results: Vec<Value> = Vec::new();
    let mut pending_images: Vec<(String, String)> = Vec::new();

    for msg in &messages {
        match msg.get("role").and_then(Value::as_str).unwrap_or("") {
            "system" | "developer" => {
                system.push(extract_text(msg.get("content").unwrap_or(&Value::Null)));
            }
            "tool" => {
                let text = extract_text(msg.get("content").unwrap_or(&Value::Null));
                pending_tool_results.push(json!({
                    "tool_use_id": msg.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                    "content": if text.is_empty() { EMPTY_TOOL_RESULT_PLACEHOLDER.into() } else { text },
                }));
                pending_images.extend(extract_images(msg.get("content").unwrap_or(&Value::Null)));
            }
            role => {
                if !pending_tool_results.is_empty() {
                    result.push(UnifiedMessage {
                        role: "user".into(),
                        content: String::new(),
                        tool_results: std::mem::take(&mut pending_tool_results),
                        images: std::mem::take(&mut pending_images),
                        ..Default::default()
                    });
                }
                result.push(UnifiedMessage {
                    role: role.to_string(),
                    content: extract_text(msg.get("content").unwrap_or(&Value::Null)),
                    tool_calls: msg
                        .get("tool_calls")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default(),
                    tool_results: extract_tool_results(msg.get("content").unwrap_or(&Value::Null)),
                    images: extract_images(msg.get("content").unwrap_or(&Value::Null)),
                });
            }
        }
    }
    if !pending_tool_results.is_empty() {
        result.push(UnifiedMessage {
            role: "user".into(),
            content: String::new(),
            tool_results: pending_tool_results,
            images: pending_images,
            ..Default::default()
        });
    }
    (
        system.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n"),
        result,
    )
}

fn openai_tools_to_unified(tools: Option<&Value>) -> Vec<UnifiedTool> {
    tools
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .map(|tool| {
                    let f = tool.get("function").unwrap_or(tool);
                    UnifiedTool {
                        name: f.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                        description: f
                            .get("description")
                            .and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| {
                                format!(
                                    "Tool: {}",
                                    f.get("name").and_then(Value::as_str).unwrap_or("")
                                )
                            }),
                        input_schema: f
                            .get("parameters")
                            .or_else(|| f.get("input_schema"))
                            .cloned()
                            .unwrap_or_else(|| json!({})),
                    }
                })
                .filter(|t| !t.name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn anthropic_tools_to_unified(tools: Option<&Value>) -> Vec<UnifiedTool> {
    tools
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|t| {
                    t.get("type").is_none() || t.get("input_schema").is_some()
                })
                .map(|tool| UnifiedTool {
                    name: tool.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                    description: tool
                        .get("description")
                        .and_then(Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_else(|| {
                            format!("Tool: {}", tool.get("name").and_then(Value::as_str).unwrap_or(""))
                        }),
                    input_schema: tool.get("input_schema").cloned().unwrap_or_else(|| json!({})),
                })
                .filter(|t| !t.name.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn to_kiro_history_message(m: &UnifiedMessage, model: &str) -> Value {
    if m.role == "assistant" {
        let mut arm = json!({
            "content": if m.content.is_empty() { EMPTY_MESSAGE_PLACEHOLDER } else { m.content.as_str() },
        });
        let mut uses = tool_uses_to_kiro(&m.tool_calls);
        if uses.is_empty() {
            uses = tool_uses_to_kiro(&extract_tool_uses(&json!(m.content)));
        }
        if !uses.is_empty() {
            arm["toolUses"] = Value::Array(uses);
        }
        return json!({ "assistantResponseMessage": arm });
    }
    let mut uim = json!({
        "content": if m.content.is_empty() { EMPTY_MESSAGE_PLACEHOLDER } else { m.content.as_str() },
        "modelId": model,
        "origin": "AI_EDITOR",
    });
    let images = if !m.images.is_empty() {
        m.images.clone()
    } else {
        extract_images(&json!(m.content))
    };
    let kiro_images = images_to_kiro(&images);
    if !kiro_images.is_empty() {
        uim["images"] = Value::Array(kiro_images);
    }
    let mut results = m.tool_results.clone();
    if results.is_empty() {
        results = extract_tool_results(&json!(m.content));
    }
    let tr = tool_results_to_kiro(&results);
    if !tr.is_empty() {
        uim["userInputMessageContext"] = json!({ "toolResults": tr });
    }
    json!({ "userInputMessage": uim })
}

fn extract_images(content: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Some(parts) = content.as_array() {
        for part in parts {
            match part.get("type").and_then(Value::as_str) {
                Some("image_url") => {
                    let url = part
                        .get("image_url")
                        .and_then(|u| u.get("url"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if let Some((mt, data)) = parse_data_url(url) {
                        out.push((mt, data));
                    }
                }
                Some("image") => {
                    if let Some(src) = part.get("source") {
                        if src.get("type").and_then(Value::as_str) == Some("base64")
                            && let Some(data) = src.get("data").and_then(Value::as_str)
                        {
                            out.push((
                                src.get("media_type")
                                    .and_then(Value::as_str)
                                    .unwrap_or("image/jpeg")
                                    .to_string(),
                                data.to_string(),
                            ));
                        }
                        // url sources skipped — kiro runtime wants inline images
                    }
                }
                _ => {}
            }
        }
    }
    out
}

fn parse_data_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("data:")?;
    let (header, data) = rest.split_once(',')?;
    Some((
        header.split(';').next().unwrap_or("image/jpeg").to_string(),
        data.to_string(),
    ))
}

fn extract_tool_results(content: &Value) -> Vec<Value> {
    content
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("tool_result"))
                .map(|p| {
                    let text = extract_text(p.get("content").unwrap_or(&Value::Null));
                    json!({
                        "tool_use_id": p.get("tool_use_id").and_then(Value::as_str).unwrap_or(""),
                        "content": if text.is_empty() { EMPTY_TOOL_RESULT_PLACEHOLDER.into() } else { text },
                        "is_error": p.get("is_error").and_then(Value::as_bool).unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn extract_tool_uses(content: &Value) -> Vec<Value> {
    content
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|p| p.get("type").and_then(Value::as_str) == Some("tool_use"))
                .map(|p| {
                    json!({
                        "id": p.get("id").and_then(Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                        "function": {
                            "name": p.get("name").and_then(Value::as_str).unwrap_or(""),
                            "arguments": serde_json::to_string(
                                p.get("input").unwrap_or(&json!({}))).unwrap_or_else(|_| "{}".into()),
                        },
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn infer_tools_from_history(history: &[UnifiedMessage], current: &UnifiedMessage) -> Vec<Value> {
    let mut seen: Vec<(String, Value)> = Vec::new();
    for msg in history.iter().chain(std::iter::once(current)) {
        let mut calls = msg.tool_calls.clone();
        if calls.is_empty() {
            calls = extract_tool_uses(&json!(msg.content));
        }
        for call in calls {
            let f = call.get("function").unwrap_or(&call);
            let name = f
                .get("name")
                .or_else(|| f.get("toolName"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if name.is_empty() || seen.iter().any(|(n, _)| n == name) {
                continue;
            }
            seen.push((
                name.to_string(),
                json!({
                    "toolSpecification": {
                        "name": name.chars().take(64).collect::<String>(),
                        "description": format!("Tool: {name}"),
                        "inputSchema": {"json": {"type": "object"}},
                    },
                }),
            ));
        }
    }
    seen.into_iter().map(|(_, v)| v).collect()
}

fn tools_to_kiro(tools: &[UnifiedTool]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "toolSpecification": {
                    "name": t.name.chars().take(64).collect::<String>(),
                    "description": t.description,
                    "inputSchema": {"json": sanitize_schema(&t.input_schema)},
                },
            })
        })
        .collect()
}

fn tool_uses_to_kiro(calls: &[Value]) -> Vec<Value> {
    calls
        .iter()
        .map(|call| {
            let f = call.get("function").unwrap_or(call);
            json!({
                "name": f.get("name").or_else(|| call.get("name"))
                    .and_then(Value::as_str).unwrap_or(""),
                "input": parse_json_object(
                    f.get("arguments").or_else(|| call.get("input")).cloned().unwrap_or(json!({}))),
                "toolUseId": call.get("id").or_else(|| call.get("toolUseId"))
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            })
        })
        .collect()
}

fn tool_results_to_kiro(results: &[Value]) -> Vec<Value> {
    results
        .iter()
        .map(|r| {
            let text = extract_text(r.get("content").unwrap_or(&Value::Null));
            json!({
                "content": [{
                    "text": if text.is_empty() { EMPTY_TOOL_RESULT_PLACEHOLDER.into() } else { text },
                }],
                "status": if r.get("is_error").and_then(Value::as_bool).unwrap_or(false) {
                    "error"
                } else {
                    "success"
                },
                "toolUseId": r.get("tool_use_id").or_else(|| r.get("toolUseId"))
                    .and_then(Value::as_str).unwrap_or(""),
            })
        })
        .collect()
}

fn images_to_kiro(images: &[(String, String)]) -> Vec<Value> {
    images
        .iter()
        .filter(|(_, data)| !data.is_empty())
        .map(|(mt, data)| {
            json!({
                "format": mt.split('/').next_back().unwrap_or("jpeg"),
                "source": {
                    "bytes": data.strip_prefix("data:")
                        .and_then(|d| d.split_once(',').map(|(_, b)| b.to_string()))
                        .unwrap_or_else(|| data.clone()),
                },
            })
        })
        .collect()
}

fn sanitize_schema(schema: &Value) -> Value {
    match schema {
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                match k.as_str() {
                    "additionalProperties" => continue,
                    "required" => {
                        let req = sanitize_required(v);
                        if !req.is_empty() {
                            out.insert(k.clone(), json!(req));
                        }
                    }
                    _ => {
                        out.insert(
                            k.clone(),
                            if v.is_object() || v.is_array() {
                                sanitize_schema(v)
                            } else {
                                v.clone()
                            },
                        );
                    }
                }
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(sanitize_schema).collect()),
        other => other.clone(),
    }
}

fn sanitize_required(value: &Value) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for item in value.as_array().cloned().unwrap_or_default() {
        let name = match &item {
            Value::String(s) => s.clone(),
            Value::Object(o) => o
                .get("name")
                .or_else(|| o.get("key"))
                .or_else(|| o.get("property"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            _ => String::new(),
        };
        if !name.is_empty() && seen.insert(name.clone()) {
            out.push(name);
        }
    }
    out
}

fn parse_json_object(value: Value) -> Value {
    match value {
        Value::String(s) => {
            if s.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&s).unwrap_or_else(|_| json!({}))
            }
        }
        other => other,
    }
}

fn openai_thinking_config(body: &Value) -> Option<(bool, u64)> {
    let effort = body.get("reasoning_effort").and_then(Value::as_str)?;
    if effort == "none" {
        return None;
    }
    let budget = match effort {
        "low" => 1000,
        "medium" => 4000,
        "high" => 8000,
        "xhigh" => 10000,
        _ => 4000,
    };
    Some((true, budget))
}

fn anthropic_thinking_config(body: &Value) -> Option<(bool, u64)> {
    let thinking = body.get("thinking")?;
    if thinking.get("type").and_then(Value::as_str) == Some("disabled") {
        return None;
    }
    Some((
        true,
        thinking
            .get("budget_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(4000),
    ))
}
