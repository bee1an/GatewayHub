//! Request converters — port of `providers/codex/converters.ts`.
//! The gptWeb backend only speaks the Responses API on `/codex/responses`,
//! so OpenAI chat and Anthropic messages bodies fold down to
//! `{ instructions, input, store:false, stream:true }`.

use serde_json::{Value, json};

use crate::protocol::extract_text;

/// `chatToResponsesPayload` port.
pub fn chat_to_responses_payload(body: &Value, normalize_model: &dyn Fn(&str) -> String) -> Value {
    let mut system_texts: Vec<String> = Vec::new();
    let mut input: Vec<Value> = Vec::new();
    let empty = Vec::new();
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    for msg in messages {
        match msg.get("role").and_then(Value::as_str).unwrap_or("") {
            "system" | "developer" => {
                let text = extract_text(msg.get("content").unwrap_or(&Value::Null));
                if !text.is_empty() {
                    system_texts.push(text);
                }
            }
            "tool" => input.push(json!({
                "type": "function_call_output",
                "call_id": msg.get("tool_call_id").and_then(Value::as_str).unwrap_or(""),
                "output": match msg.get("content") {
                    Some(Value::String(s)) => s.clone(),
                    other => extract_text(other.unwrap_or(&Value::Null)),
                },
            })),
            "assistant" => {
                let tool_calls = msg.get("tool_calls").and_then(Value::as_array);
                if tool_calls.is_some_and(|t| !t.is_empty()) {
                    let text = extract_text(msg.get("content").unwrap_or(&Value::Null));
                    if !text.is_empty() {
                        input.push(json!({
                            "role": "assistant",
                            "content": [{ "type": "input_text", "text": text }],
                        }));
                    }
                    for tc in tool_calls.expect("validated invariant") {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": tc.get("id").and_then(Value::as_str).unwrap_or(""),
                            "name": tc.get("function").and_then(|f| f.get("name"))
                                .and_then(Value::as_str).unwrap_or(""),
                            "arguments": tc.get("function").and_then(|f| f.get("arguments"))
                                .and_then(Value::as_str).unwrap_or("{}"),
                        }));
                    }
                } else {
                    input.push(json!({
                        "role": "assistant",
                        "content": convert_content_items(msg.get("content").unwrap_or(&Value::Null)),
                    }));
                }
            }
            "user" => input.push(json!({
                "role": "user",
                "content": convert_content_items(msg.get("content").unwrap_or(&Value::Null)),
            })),
            _ => {}
        }
    }

    let mut payload = json!({
        "model": normalize_model(
            body.get("model").and_then(Value::as_str).unwrap_or("gpt-5")
        ),
        "instructions": if system_texts.is_empty() {
            "You are a helpful assistant.".to_string()
        } else {
            system_texts.join("\n")
        },
        "input": input,
        "store": false,
        "stream": true,
    });

    if let Some(tools) = body.get("tools").and_then(Value::as_array)
        && !tools.is_empty()
    {
        payload["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    if tool.get("type").and_then(Value::as_str) == Some("function") {
                        json!({
                            "type": "function",
                            "name": tool.get("function").and_then(|f| f.get("name")),
                            "description": tool.get("function").and_then(|f| f.get("description")),
                            "parameters": tool.get("function").and_then(|f| f.get("parameters")),
                        })
                    } else {
                        tool.clone()
                    }
                })
                .collect(),
        );
    }
    if let Some(tc) = body.get("tool_choice") {
        payload["tool_choice"] = tc.clone();
    }
    if let Some(effort) = body
        .get("reasoning_effort")
        .cloned()
        .or_else(|| body.get("reasoning").and_then(|r| r.get("effort")).cloned())
    {
        payload["reasoning"] = json!({ "effort": effort });
    }
    payload
}

/// `anthropicToResponsesPayload` port.
pub fn anthropic_to_responses_payload(
    body: &Value,
    normalize_model: &dyn Fn(&str) -> String,
) -> Value {
    let system = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        other => extract_text(other.unwrap_or(&Value::Null)),
    };
    let empty = Vec::new();
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .unwrap_or(&empty);
    let mut input: Vec<Value> = Vec::new();

    for msg in messages {
        match msg.get("role").and_then(Value::as_str).unwrap_or("") {
            "assistant" => {
                if let Some(blocks) = msg.get("content").and_then(Value::as_array)
                    && blocks
                        .iter()
                        .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                {
                    let text: String = blocks
                        .iter()
                        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                        .filter_map(|b| b.get("text").and_then(Value::as_str))
                        .collect();
                    if !text.is_empty() {
                        input.push(json!({
                            "role": "assistant",
                            "content": [{ "type": "input_text", "text": text }],
                        }));
                    }
                    for block in blocks {
                        if block.get("type").and_then(Value::as_str) == Some("tool_use") {
                            let arguments = match block.get("input") {
                                Some(Value::String(s)) => s.clone(),
                                other => serde_json::to_string(
                                    &other.cloned().unwrap_or_else(|| json!({})),
                                )
                                .unwrap_or_else(|_| "{}".into()),
                            };
                            input.push(json!({
                                "type": "function_call",
                                "call_id": block.get("id").and_then(Value::as_str).unwrap_or(""),
                                "name": block.get("name").and_then(Value::as_str).unwrap_or(""),
                                "arguments": arguments,
                            }));
                        }
                    }
                    continue;
                }
                input.push(json!({
                    "role": "assistant",
                    "content": convert_anthropic_content(msg.get("content").unwrap_or(&Value::Null)),
                }));
            }
            "user" => {
                if let Some(blocks) = msg.get("content").and_then(Value::as_array)
                    && blocks
                        .iter()
                        .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                {
                    for block in blocks {
                        match block.get("type").and_then(Value::as_str) {
                            Some("tool_result") => {
                                let output = match block.get("content") {
                                    Some(Value::String(s)) => s.clone(),
                                    other => extract_text(other.unwrap_or(&Value::Null)),
                                };
                                input.push(json!({
                                    "type": "function_call_output",
                                    "call_id": block.get("tool_use_id")
                                        .and_then(Value::as_str).unwrap_or(""),
                                    "output": output,
                                }));
                            }
                            Some("text") => input.push(json!({
                                "role": "user",
                                "content": [{ "type": "input_text",
                                    "text": block.get("text").and_then(Value::as_str).unwrap_or("") }],
                            })),
                            Some("image") => input.push(json!({
                                "role": "user",
                                "content": convert_anthropic_content(
                                    &Value::Array(vec![block.clone()])),
                            })),
                            _ => {}
                        }
                    }
                    continue;
                }
                input.push(json!({
                    "role": "user",
                    "content": convert_anthropic_content(msg.get("content").unwrap_or(&Value::Null)),
                }));
            }
            _ => input.push(json!({
                "role": "user",
                "content": convert_anthropic_content(msg.get("content").unwrap_or(&Value::Null)),
            })),
        }
    }

    let mut payload = json!({
        "model": normalize_model(
            body.get("model").and_then(Value::as_str).unwrap_or("gpt-5")
        ),
        "instructions": if system.is_empty() {
            "You are a helpful assistant.".to_string()
        } else {
            system
        },
        "input": input,
        "store": false,
        "stream": true,
    });
    if let Some(t) = body.get("temperature").and_then(Value::as_f64) {
        payload["temperature"] = json!(t);
    }
    if let Some(t) = body.get("top_p").and_then(Value::as_f64) {
        payload["top_p"] = json!(t);
    }
    if let Some(tools) = body.get("tools").and_then(Value::as_array)
        && !tools.is_empty()
    {
        payload["tools"] = Value::Array(
            tools
                .iter()
                .map(|tool| {
                    json!({
                        "type": "function",
                        "name": tool.get("name"),
                        "description": tool.get("description"),
                        "parameters": tool.get("input_schema"),
                    })
                })
                .collect(),
        );
    }
    if let Some(tc) = body.get("tool_choice") {
        payload["tool_choice"] = match tc.get("type").and_then(Value::as_str) {
            Some("auto") => json!("auto"),
            Some("any") => json!("required"),
            Some("tool") => tc.get("name").cloned().unwrap_or(tc.clone()),
            _ => tc.clone(),
        };
    }
    if body
        .get("thinking")
        .and_then(|t| t.get("budget_tokens"))
        .and_then(Value::as_u64)
        .is_some()
    {
        payload["reasoning"] = json!({ "effort": "high" });
    }
    payload
}

fn convert_content_items(content: &Value) -> Value {
    match content {
        Value::String(s) => json!([{ "type": "input_text", "text": s }]),
        Value::Array(parts) => {
            let mut items: Vec<Value> = Vec::new();
            for part in parts {
                match part.get("type").and_then(Value::as_str) {
                    Some("text") => items.push(json!({
                        "type": "input_text",
                        "text": part.get("text").and_then(Value::as_str).unwrap_or(""),
                    })),
                    Some("image_url") => {
                        let url = match part.get("image_url") {
                            Some(Value::String(s)) => Some(s.clone()),
                            Some(v) => v.get("url").and_then(Value::as_str).map(str::to_string),
                            _ => None,
                        };
                        if let Some(url) = url {
                            items.push(json!({ "type": "input_image", "image_url": url }));
                        }
                    }
                    _ => {
                        let text = extract_text(part);
                        if !text.is_empty() {
                            items.push(json!({ "type": "input_text", "text": text }));
                        }
                    }
                }
            }
            if items.is_empty() {
                items.push(json!({ "type": "input_text", "text": "" }));
            }
            Value::Array(items)
        }
        other => json!([{ "type": "input_text", "text": extract_text(other) }]),
    }
}

fn convert_anthropic_content(content: &Value) -> Value {
    match content {
        Value::String(s) => json!([{ "type": "input_text", "text": s }]),
        Value::Array(blocks) => {
            let mut items: Vec<Value> = Vec::new();
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => items.push(json!({
                        "type": "input_text",
                        "text": block.get("text").and_then(Value::as_str).unwrap_or(""),
                    })),
                    Some("image") => {
                        let source = block.get("source").cloned().unwrap_or(Value::Null);
                        match source.get("type").and_then(Value::as_str) {
                            Some("base64") => {
                                if let Some(data) = source.get("data").and_then(Value::as_str) {
                                    let media = source
                                        .get("media_type")
                                        .and_then(Value::as_str)
                                        .unwrap_or("image/png");
                                    items.push(json!({
                                        "type": "input_image",
                                        "image_url": format!("data:{media};base64,{data}"),
                                    }));
                                }
                            }
                            Some("url") => {
                                if let Some(url) = source.get("url").and_then(Value::as_str) {
                                    items.push(json!({ "type": "input_image", "image_url": url }));
                                }
                            }
                            _ => {}
                        }
                    }
                    _ => {
                        let text = extract_text(block);
                        if !text.is_empty() {
                            items.push(json!({ "type": "input_text", "text": text }));
                        }
                    }
                }
            }
            if items.is_empty() {
                items.push(json!({ "type": "input_text", "text": "" }));
            }
            Value::Array(items)
        }
        other => json!([{ "type": "input_text", "text": extract_text(other) }]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn norm(m: &str) -> String {
        m.to_lowercase()
    }

    #[test]
    fn chat_payload_folds_roles() {
        let body = json!({
            "model": "GPT-5",
            "messages": [
                {"role": "system", "content": "be brief"},
                {"role": "user", "content": [{"type": "text", "text": "hi"}]},
                {"role": "assistant", "content": "ok", "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "bash", "arguments": "{}"}}
                ]},
                {"role": "tool", "tool_call_id": "c1", "content": "done"},
            ],
        });
        let p = chat_to_responses_payload(&body, &norm);
        assert_eq!(p["model"], "gpt-5");
        assert_eq!(p["instructions"], "be brief");
        assert_eq!(p["input"][1]["content"][0]["text"], "ok");
        assert_eq!(p["input"][2]["type"], "function_call");
        assert_eq!(p["input"][3]["type"], "function_call_output");
        assert_eq!(p["store"], false);
        assert_eq!(p["stream"], true);
    }

    #[test]
    fn anthropic_payload_converts_tool_blocks() {
        let body = json!({
            "model": "gpt-5",
            "system": "sys",
            "messages": [
                {"role": "assistant", "content": [
                    {"type": "text", "text": "let me run"},
                    {"type": "tool_use", "id": "t1", "name": "bash", "input": {"cmd": "ls"}},
                ]},
                {"role": "user", "content": [
                    {"type": "tool_result", "tool_use_id": "t1", "content": "out"},
                ]},
            ],
            "tools": [{"name": "bash", "input_schema": {"type": "object"}}],
            "tool_choice": {"type": "any"},
            "thinking": {"budget_tokens": 1000},
        });
        let p = anthropic_to_responses_payload(&body, &norm);
        assert_eq!(p["instructions"], "sys");
        assert_eq!(p["input"][0]["content"][0]["text"], "let me run");
        assert_eq!(p["input"][1]["call_id"], "t1");
        assert_eq!(p["input"][1]["arguments"], "{\"cmd\":\"ls\"}");
        assert_eq!(p["input"][2]["type"], "function_call_output");
        assert_eq!(p["tools"][0]["parameters"]["type"], "object");
        assert_eq!(p["tool_choice"], "required");
        assert_eq!(p["reasoning"]["effort"], "high");
    }
}
