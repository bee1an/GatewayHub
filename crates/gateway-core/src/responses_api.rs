//! Responses API adapter — port of `core/responsesApi.ts`:
//! `/v1/responses` ⇄ chat-completions, including the streaming
//! item/state machine.

use std::collections::{BTreeMap, VecDeque};

use futures::Stream;
use serde_json::{Value, json};

use crate::protocol::SseParser;

mod sse;
pub use sse::*;

fn uuid_id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}

// ---------- request: Responses -> Chat Completions ----------

/// `responsesRequestToChatCompletions` port.
pub fn responses_request_to_chat(body: &Value) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(instructions) = body.get("instructions").and_then(Value::as_str) {
        let trimmed = instructions.trim();
        if !trimmed.is_empty() {
            messages.push(json!({ "role": "system", "content": trimmed }));
        }
    }
    messages.extend(input_to_messages(body.get("input").unwrap_or(&Value::Null)));

    let mut converted = json!({
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "messages": messages,
        "stream": body.get("stream").and_then(Value::as_bool) == Some(true),
    });
    for key in [
        "temperature",
        "top_p",
        "metadata",
        "parallel_tool_calls",
        "user",
        "service_tier",
        "prompt_cache_key",
        "safety_identifier",
        "logprobs",
        "top_logprobs",
    ] {
        if let Some(v) = body.get(key) {
            converted[key] = v.clone();
        }
    }
    if let Some(v) = body.get("max_output_tokens") {
        converted["max_completion_tokens"] = v.clone();
    }
    if let Some(Value::Array(tools)) = body.get("tools") {
        let mapped: Vec<Value> = tools
            .iter()
            .filter(|t| t.get("type").and_then(Value::as_str) == Some("function"))
            .map(|t| {
                let mut f = json!({
                    "name": t.get("name"),
                    "description": t.get("description"),
                    "parameters": t.get("parameters").cloned()
                        .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
                });
                if let Some(strict) = t.get("strict") {
                    f["strict"] = strict.clone();
                }
                json!({ "type": "function", "function": f })
            })
            .collect();
        if !mapped.is_empty() {
            converted["tools"] = Value::Array(mapped);
        }
    }
    if let Some(choice) = tool_choice_to_chat(body.get("tool_choice").unwrap_or(&Value::Null)) {
        converted["tool_choice"] = choice;
    }
    if let Some(fmt) = text_format_to_response_format(
        body.get("text")
            .and_then(|t| t.get("format"))
            .unwrap_or(&Value::Null),
    ) {
        converted["response_format"] = fmt;
    }
    if let Some(effort) = body
        .get("reasoning")
        .and_then(|r| r.get("effort"))
        .and_then(Value::as_str)
        .filter(|e| !e.is_empty())
    {
        converted["reasoning_effort"] = json!(effort);
    }
    if converted["stream"].as_bool() == Some(true) {
        let opts = body
            .get("stream_options")
            .filter(|o| o.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        let mut opts = opts;
        opts["include_usage"] = json!(true);
        converted["stream_options"] = opts;
    }
    converted
}

fn input_to_messages(input: &Value) -> Vec<Value> {
    if let Value::String(s) = input {
        return vec![json!({ "role": "user", "content": s })];
    }
    let Some(items) = input.as_array() else {
        return Vec::new();
    };
    let mut messages = Vec::new();
    for item in items {
        if !item.is_object() {
            continue;
        }
        let ty = item
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("message");
        if ty == "message" || item.get("role").is_some() {
            messages.extend(message_to_chat(item));
        } else if ty == "function_call" {
            messages.push(json!({
                "role": "assistant",
                "content": null,
                "tool_calls": [{
                    "id": item.get("call_id").or_else(|| item.get("id"))
                        .and_then(Value::as_str).map(str::to_string)
                        .unwrap_or_else(|| uuid_id("call_")),
                    "type": "function",
                    "function": {
                        "name": item.get("name").and_then(Value::as_str).unwrap_or("tool"),
                        "arguments": item.get("arguments").and_then(Value::as_str).unwrap_or("{}"),
                    },
                }],
            }));
        } else if ty == "function_call_output" {
            let output = match item.get("output") {
                Some(Value::String(s)) => s.clone(),
                other => serde_json::to_string(&other.cloned().unwrap_or(Value::Null))
                    .unwrap_or_default(),
            };
            messages.push(json!({
                "role": "tool",
                "tool_call_id": item.get("call_id").or_else(|| item.get("id"))
                    .and_then(Value::as_str).unwrap_or(""),
                "content": output,
            }));
        }
        // reasoning / item_reference / image_generation_call can't be replayed
    }
    messages
}

fn message_to_chat(item: &Value) -> Vec<Value> {
    let role = match item.get("role").and_then(Value::as_str) {
        Some("assistant") => "assistant",
        Some("system") | Some("developer") => "system",
        _ => "user",
    };
    let content = item.get("content").unwrap_or(&Value::Null);
    if let Value::String(s) = content {
        return vec![json!({ "role": role, "content": s })];
    }
    let Some(parts_arr) = content.as_array() else {
        return vec![json!({ "role": role, "content": "" })];
    };
    let mut parts: Vec<Value> = Vec::new();
    for part in parts_arr {
        if !part.is_object() {
            continue;
        }
        match part.get("type").and_then(Value::as_str) {
            Some("input_text") | Some("output_text") | Some("text") => parts.push(json!({
                "type": "text",
                "text": part.get("text").and_then(Value::as_str).unwrap_or(""),
            })),
            Some("input_image") => {
                let url = part
                    .get("image_url")
                    .or_else(|| part.get("url"))
                    .and_then(Value::as_str);
                if let Some(url) = url {
                    parts.push(json!({ "type": "image_url", "image_url": { "url": url } }));
                }
            }
            Some("input_file") | Some("file") => parts.push(json!({
                "type": "file",
                "file": {
                    "file_data": part.get("file_data"),
                    "file_id": part.get("file_id"),
                    "filename": part.get("filename").or_else(|| part.get("file_name")),
                },
            })),
            Some("refusal") => parts.push(json!({
                "type": "text",
                "text": part.get("refusal").and_then(Value::as_str).unwrap_or(""),
            })),
            _ => {}
        }
    }
    vec![json!({ "role": role, "content": compact_parts(parts) })]
}

fn compact_parts(parts: Vec<Value>) -> Value {
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

fn tool_choice_to_chat(choice: &Value) -> Option<Value> {
    match choice {
        Value::Null => None,
        Value::String(s) if matches!(s.as_str(), "auto" | "required" | "none") => Some(json!(s)),
        Value::Object(_) => {
            if choice.get("type").and_then(Value::as_str) == Some("function")
                && choice.get("name").is_some()
            {
                Some(json!({
                    "type": "function",
                    "function": { "name": choice.get("name") },
                }))
            } else if choice.get("type").and_then(Value::as_str) == Some("allowed_tools") {
                choice.get("mode").cloned()
            } else {
                Some(json!("auto"))
            }
        }
        _ => Some(json!("auto")),
    }
}

fn text_format_to_response_format(format: &Value) -> Option<Value> {
    if !format.is_object() {
        return None;
    }
    match format.get("type").and_then(Value::as_str) {
        Some("json_object") => Some(json!({ "type": "json_object" })),
        Some("json_schema") => {
            let mut schema = json!({
                "name": format.get("name").and_then(Value::as_str).unwrap_or("response"),
                "schema": format.get("schema").cloned().unwrap_or_else(|| json!({})),
            });
            if let Some(v) = format.get("strict") {
                schema["strict"] = v.clone();
            }
            if let Some(v) = format.get("description") {
                schema["description"] = v.clone();
            }
            Some(json!({ "type": "json_schema", "json_schema": schema }))
        }
        _ => None,
    }
}

// ---------- non-stream response: Chat Completion -> Response object ----------

/// `chatCompletionToResponsesResponse` port.
pub fn chat_completion_to_responses(completion: &Value, request_body: &Value) -> Value {
    let created = completion
        .get("created")
        .and_then(Value::as_i64)
        .unwrap_or_else(now_secs);
    let choice = completion
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|c| c.first())
        .cloned()
        .unwrap_or(Value::Null);
    let message = choice.get("message").cloned().unwrap_or(Value::Null);
    let (output, text) = chat_message_to_output(&message);
    let finish = choice.get("finish_reason").and_then(Value::as_str);
    let status = match finish {
        Some("stop") | Some("tool_calls") | None => "completed",
        _ => "incomplete",
    };
    let incomplete = match finish {
        Some("length") => json!({ "reason": "max_output_tokens" }),
        Some("content_filter") => json!({ "reason": "content_filter" }),
        _ => Value::Null,
    };
    let usage = completion.get("usage");

    json!({
        "id": uuid_id("resp_"),
        "object": "response",
        "created_at": created,
        "status": status,
        "error": null,
        "incomplete_details": incomplete,
        "instructions": request_body.get("instructions").cloned().unwrap_or(Value::Null),
        "max_output_tokens": request_body.get("max_output_tokens").cloned().unwrap_or(Value::Null),
        "model": completion.get("model").cloned()
            .or_else(|| request_body.get("model").cloned())
            .unwrap_or(Value::Null),
        "previous_response_id": request_body.get("previous_response_id").cloned().unwrap_or(Value::Null),
        "output": output,
        "output_text": text,
        "parallel_tool_calls": request_body.get("parallel_tool_calls").cloned().unwrap_or(json!(true)),
        "tool_choice": request_body.get("tool_choice").cloned().unwrap_or(json!("auto")),
        "tools": request_body.get("tools").and_then(Value::as_array).cloned().unwrap_or_default(),
        "temperature": request_body.get("temperature").cloned().unwrap_or(json!(1)),
        "top_p": request_body.get("top_p").cloned().unwrap_or(json!(1)),
        "reasoning": {
            "effort": request_body.get("reasoning").and_then(|r| r.get("effort")).cloned().unwrap_or(Value::Null),
            "summary": null,
        },
        "store": request_body.get("store").cloned().unwrap_or(json!(true)),
        "text": request_body.get("text").cloned().unwrap_or_else(|| json!({ "format": { "type": "text" } })),
        "truncation": request_body.get("truncation").cloned().unwrap_or(json!("disabled")),
        "user": request_body.get("user").cloned().unwrap_or(Value::Null),
        "metadata": request_body.get("metadata").cloned().unwrap_or_else(|| json!({})),
        "usage": usage.map(responses_usage).unwrap_or(Value::Null),
    })
}

fn responses_usage(usage: &Value) -> Value {
    json!({
        "input_tokens": numeric(usage.get("prompt_tokens").or_else(|| usage.get("input_tokens"))),
        "input_tokens_details": {
            "cached_tokens": numeric(usage.get("prompt_tokens_details").and_then(|d| d.get("cached_tokens"))),
        },
        "output_tokens": numeric(usage.get("completion_tokens").or_else(|| usage.get("output_tokens"))),
        "output_tokens_details": {
            "reasoning_tokens": numeric(usage.get("completion_tokens_details").and_then(|d| d.get("reasoning_tokens"))),
        },
        "total_tokens": numeric(usage.get("total_tokens")),
    })
}

fn chat_message_to_output(message: &Value) -> (Value, String) {
    let mut output: Vec<Value> = Vec::new();
    let reasoning = extract_reasoning_text(message);
    if !reasoning.is_empty() {
        output.push(json!({
            "id": uuid_id("rs_"),
            "type": "reasoning",
            "summary": [{ "type": "summary_text", "text": reasoning }],
            "content": [{ "type": "reasoning_text", "text": reasoning }],
            "status": "completed",
        }));
    }
    let text = extract_content_text(message.get("content").unwrap_or(&Value::Null));
    let tool_calls = message
        .get("tool_calls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if !text.is_empty() || tool_calls.is_empty() {
        output.push(json!({
            "id": uuid_id("msg_"),
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": text, "annotations": [] }],
        }));
    }
    for call in &tool_calls {
        output.push(json!({
            "id": uuid_id("fc_"),
            "type": "function_call",
            "call_id": call.get("id").and_then(Value::as_str).map(str::to_string)
                .unwrap_or_else(|| uuid_id("call_")),
            "name": call.get("function").and_then(|f| f.get("name"))
                .and_then(Value::as_str).unwrap_or("tool"),
            "arguments": call.get("function").and_then(|f| f.get("arguments"))
                .and_then(Value::as_str).unwrap_or("{}"),
            "status": "completed",
        }));
    }
    (Value::Array(output), text)
}

fn extract_content_text(content: &Value) -> String {
    match content {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|p| match p {
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
            .join(""),
        other => other.to_string(),
    }
}

fn extract_reasoning_text(message: &Value) -> String {
    let value = message
        .get("reasoning_content")
        .or_else(|| message.get("reasoning"));
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| match p {
                Value::String(s) => s.clone(),
                other => other
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn extract_delta_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|p| match p {
                Value::String(s) => s.clone(),
                other => other
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn numeric(value: Option<&Value>) -> u64 {
    value
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map(|n| n.trunc() as u64)
        .unwrap_or(0)
}

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn sse_event(ty: &str, payload: Value) -> String {
    format!(
        "event: {ty}\ndata: {}\n\n",
        serde_json::to_string(&payload).unwrap_or_else(|_| "{}".into())
    )
}

#[cfg(test)]
mod tests {
    use futures::StreamExt;

    use super::*;

    #[test]
    fn request_converts_instructions_and_tools() {
        let body = json!({
            "model": "nvidia/m",
            "instructions": " be brief ",
            "input": [
                {"type": "message", "role": "user", "content": [
                    {"type": "input_text", "text": "hi"},
                ]},
                {"type": "function_call", "call_id": "c1", "name": "bash", "arguments": "{\"x\":1}"},
                {"type": "function_call_output", "call_id": "c1", "output": "ok"},
            ],
            "max_output_tokens": 64,
            "tools": [{"type": "function", "name": "bash", "parameters": {"type": "object"}, "strict": true}],
            "reasoning": {"effort": "high"},
            "stream": true,
        });
        let out = responses_request_to_chat(&body);
        assert_eq!(
            out["messages"][0],
            json!({"role": "system", "content": "be brief"})
        );
        assert_eq!(out["messages"][1]["content"], "hi");
        assert_eq!(out["messages"][2]["tool_calls"][0]["id"], "c1");
        assert_eq!(out["messages"][3]["role"], "tool");
        assert_eq!(out["max_completion_tokens"], 64);
        assert_eq!(out["tools"][0]["function"]["strict"], true);
        assert_eq!(out["reasoning_effort"], "high");
        assert_eq!(out["stream_options"]["include_usage"], true);
    }

    #[test]
    fn completion_to_response_object() {
        let completion = json!({
            "id": "c1", "created": 7, "model": "m",
            "choices": [{"message": {"role": "assistant", "content": "hi there"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 2, "total_tokens": 6},
        });
        let resp = chat_completion_to_responses(
            &completion,
            &json!({"model": "m", "instructions": "sys"}),
        );
        assert_eq!(resp["object"], "response");
        assert_eq!(resp["status"], "completed");
        assert_eq!(resp["output_text"], "hi there");
        assert_eq!(resp["usage"]["input_tokens"], 4);
        assert!(
            resp["id"]
                .as_str()
                .expect("validated invariant")
                .starts_with("resp_")
        );
    }

    #[tokio::test]
    async fn sse_transform_emits_responses_events() {
        let chunks = vec![
            "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking\"}}]}\n\n".to_string(),
            "data: {\"choices\":[{\"delta\":{\"content\":\"Hello\"}}]}\n\n".to_string(),
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"a\\\":\"}}]}}]}\n\n".to_string(),
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"1}\"}}]},\"finish_reason\":\"tool_calls\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":4}}\n\n".to_string(),
            "data: [DONE]\n\n".to_string(),
        ];
        let stream = futures::stream::iter(chunks);
        let out: Vec<String> = chat_sse_to_responses(stream, json!({"model": "m"}))
            .collect()
            .await;
        let joined = out.join("");
        assert!(joined.contains("event: response.created"));
        assert!(joined.contains("response.output_item.added"));
        assert!(joined.contains("response.reasoning_summary_text.delta"));
        assert!(joined.contains("response.output_text.delta"));
        assert!(joined.contains("response.function_call_arguments.delta"));
        assert!(joined.contains("event: response.completed"));
        // sequence numbers ascend
        let seqs: Vec<u64> = joined
            .lines()
            .filter(|l| l.starts_with("data: "))
            .filter_map(|l| serde_json::from_str::<Value>(&l[6..]).ok())
            .filter_map(|v| v.get("sequence_number").and_then(Value::as_u64))
            .collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]));
    }

    /// A tool_call whose args arrive before its name must still produce an
    /// `output_item.added` with a populated `name` — OpenAI sends the name
    /// at add-time, and strict clients reject `name: ""`.
    #[tokio::test]
    async fn sse_transform_tool_call_added_waits_for_name() {
        let chunks = vec![
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"function\":{\"arguments\":\"{\\\"a\\\":\"}}]}}]}\n\n".to_string(),
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"name\":\"bash\",\"arguments\":\"1}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\n".to_string(),
            "data: [DONE]\n\n".to_string(),
        ];
        let stream = futures::stream::iter(chunks);
        let out: Vec<String> = chat_sse_to_responses(stream, json!({"model": "m"}))
            .collect()
            .await;
        let added: Vec<Value> = out
            .iter()
            .flat_map(|s| s.lines())
            .filter(|l| l.starts_with("data: "))
            .filter_map(|l| serde_json::from_str::<Value>(&l[6..]).ok())
            .filter(|v| v.get("type").and_then(Value::as_str) == Some("response.output_item.added"))
            .collect();
        assert_eq!(added.len(), 1);
        let item = &added[0]["item"];
        assert_eq!(item["type"], "function_call");
        assert_eq!(item["name"], "bash");
        assert_eq!(item["call_id"], "call_1");
    }
}
