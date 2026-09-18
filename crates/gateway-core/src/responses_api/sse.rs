//! Streaming half of `responses_api.rs` — chat SSE → Responses SSE transformer.

use super::*;

#[derive(Default)]
pub(crate) struct ToolCallOut {
    pub(crate) output_index: usize,
    pub(crate) item_id: String,
    pub(crate) call_id: String,
    pub(crate) name: String,
    pub(crate) arguments: String,
    /// `response.output_item.added` was already emitted for this call —
    /// delayed until `name` is known because OpenAI populates the item's
    /// name at add-time (strict clients reject an added item with `name:""`).
    pub(crate) emitted: bool,
}

pub(crate) struct ResponsesSseTransformer {
    pub(crate) response_id: String,
    pub(crate) created_at: i64,
    pub(crate) request_body: Value,
    pub(crate) model: String,
    pub(crate) sequence: u64,
    pub(crate) completed: bool,
    pub(crate) started: bool,
    pub(crate) items: Vec<Value>,
    pub(crate) message_item_index: Option<usize>,
    pub(crate) message_item_id: String,
    pub(crate) message_text: String,
    pub(crate) reasoning_item_index: Option<usize>,
    pub(crate) reasoning_item_id: String,
    pub(crate) reasoning_text: String,
    pub(crate) tool_calls: BTreeMap<u64, ToolCallOut>,
    pub(crate) last_finish_reason: Option<String>,
    pub(crate) usage: Value,
}

impl ResponsesSseTransformer {
    pub(crate) fn new(request_body: Value) -> Self {
        Self {
            response_id: uuid_id("resp_"),
            created_at: now_secs(),
            model: request_body
                .get("model")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            request_body,
            sequence: 0,
            completed: false,
            started: false,
            items: Vec::new(),
            message_item_index: None,
            message_item_id: String::new(),
            message_text: String::new(),
            reasoning_item_index: None,
            reasoning_item_id: String::new(),
            reasoning_text: String::new(),
            tool_calls: BTreeMap::new(),
            last_finish_reason: None,
            usage: Value::Null,
        }
    }

    pub(crate) fn emit(&mut self, ty: &str, mut payload: Value) -> String {
        payload["type"] = json!(ty);
        payload["sequence_number"] = json!(self.sequence);
        self.sequence += 1;
        sse_event(ty, payload)
    }

    pub(crate) fn base_response(&self, status: &str) -> Value {
        let req = &self.request_body;
        json!({
            "id": self.response_id,
            "object": "response",
            "created_at": self.created_at,
            "status": status,
            "error": null,
            "incomplete_details": null,
            "instructions": req.get("instructions").cloned().unwrap_or(Value::Null),
            "max_output_tokens": req.get("max_output_tokens").cloned().unwrap_or(Value::Null),
            "model": self.model,
            "previous_response_id": req.get("previous_response_id").cloned().unwrap_or(Value::Null),
            "output": [],
            "parallel_tool_calls": req.get("parallel_tool_calls").cloned().unwrap_or(json!(true)),
            "tool_choice": req.get("tool_choice").cloned().unwrap_or(json!("auto")),
            "tools": req.get("tools").and_then(Value::as_array).cloned().unwrap_or_default(),
            "temperature": req.get("temperature").cloned().unwrap_or(json!(1)),
            "top_p": req.get("top_p").cloned().unwrap_or(json!(1)),
            "reasoning": {
                "effort": req.get("reasoning").and_then(|r| r.get("effort")).cloned().unwrap_or(Value::Null),
                "summary": null,
            },
            "store": req.get("store").cloned().unwrap_or(json!(true)),
            "text": req.get("text").cloned().unwrap_or_else(|| json!({ "format": { "type": "text" } })),
            "truncation": req.get("truncation").cloned().unwrap_or(json!("disabled")),
            "user": req.get("user").cloned().unwrap_or(Value::Null),
            "metadata": req.get("metadata").cloned().unwrap_or_else(|| json!({})),
            "usage": null,
        })
    }

    pub(crate) fn start_events(&mut self, out: &mut Vec<String>) {
        if self.started {
            return;
        }
        self.started = true;
        let r = self.base_response("in_progress");
        out.push(self.emit("response.created", json!({ "response": r })));
        let r = self.base_response("in_progress");
        out.push(self.emit("response.in_progress", json!({ "response": r })));
    }

    pub(crate) fn ensure_reasoning_item(&mut self, out: &mut Vec<String>) {
        self.start_events(out);
        if self.reasoning_item_index.is_some() {
            return;
        }
        let index = self.items.len();
        self.reasoning_item_index = Some(index);
        self.reasoning_item_id = uuid_id("rs_");
        self.items.push(json!({
            "id": self.reasoning_item_id,
            "type": "reasoning",
            "summary": [],
            "content": [],
            "status": "in_progress",
        }));
        let item = self.items[index].clone();
        out.push(self.emit(
            "response.output_item.added",
            json!({ "output_index": index, "item": item }),
        ));
        out.push(self.emit(
            "response.reasoning_summary_part.added",
            json!({
                "item_id": self.reasoning_item_id,
                "output_index": index,
                "summary_index": 0,
                "part": { "type": "summary_text", "text": "" },
            }),
        ));
    }

    pub(crate) fn close_reasoning_item(&mut self, out: &mut Vec<String>) {
        let Some(index) = self.reasoning_item_index else {
            return;
        };
        if self.items[index].get("status").and_then(Value::as_str) != Some("in_progress") {
            return;
        }
        out.push(self.emit(
            "response.reasoning_summary_text.done",
            json!({
                "item_id": self.reasoning_item_id,
                "output_index": index,
                "summary_index": 0,
                "text": self.reasoning_text,
            }),
        ));
        out.push(self.emit(
            "response.reasoning_summary_part.done",
            json!({
                "item_id": self.reasoning_item_id,
                "output_index": index,
                "summary_index": 0,
                "part": { "type": "summary_text", "text": self.reasoning_text },
            }),
        ));
        self.items[index] = json!({
            "id": self.reasoning_item_id,
            "type": "reasoning",
            "summary": if self.reasoning_text.is_empty() { json!([]) } else { json!([{ "type": "summary_text", "text": self.reasoning_text }]) },
            "content": if self.reasoning_text.is_empty() { json!([]) } else { json!([{ "type": "reasoning_text", "text": self.reasoning_text }]) },
            "status": "completed",
        });
        let item = self.items[index].clone();
        out.push(self.emit(
            "response.output_item.done",
            json!({ "output_index": index, "item": item }),
        ));
    }

    pub(crate) fn ensure_message_item(&mut self, out: &mut Vec<String>) {
        self.start_events(out);
        if self.message_item_index.is_some() {
            return;
        }
        self.close_reasoning_item(out);
        let index = self.items.len();
        self.message_item_index = Some(index);
        self.message_item_id = uuid_id("msg_");
        let item = json!({
            "id": self.message_item_id,
            "type": "message",
            "status": "in_progress",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": "", "annotations": [] }],
        });
        self.items.push(item.clone());
        out.push(self.emit(
            "response.output_item.added",
            json!({ "output_index": index, "item": item }),
        ));
        out.push(self.emit(
            "response.content_part.added",
            json!({
                "item_id": self.message_item_id,
                "output_index": index,
                "content_index": 0,
                "part": { "type": "output_text", "text": "", "annotations": [] },
            }),
        ));
    }

    pub(crate) fn close_message_item(&mut self, out: &mut Vec<String>) {
        let Some(index) = self.message_item_index else {
            return;
        };
        if self.items[index].get("status").and_then(Value::as_str) != Some("in_progress") {
            return;
        }
        out.push(self.emit(
            "response.output_text.done",
            json!({
                "item_id": self.message_item_id,
                "output_index": index,
                "content_index": 0,
                "text": self.message_text,
            }),
        ));
        out.push(self.emit(
            "response.content_part.done",
            json!({
                "item_id": self.message_item_id,
                "output_index": index,
                "content_index": 0,
                "part": { "type": "output_text", "text": self.message_text, "annotations": [] },
            }),
        ));
        self.items[index] = json!({
            "id": self.message_item_id,
            "type": "message",
            "status": "completed",
            "role": "assistant",
            "content": [{ "type": "output_text", "text": self.message_text, "annotations": [] }],
        });
        let item = self.items[index].clone();
        out.push(self.emit(
            "response.output_item.done",
            json!({ "output_index": index, "item": item }),
        ));
    }

    /// Registers the call slot without emitting anything — the
    /// `output_item.added` event only goes out once the function name is
    /// known (see [`emit_tool_call_added`]).
    pub(crate) fn ensure_tool_call(&mut self, index: u64, out: &mut Vec<String>) {
        self.start_events(out);
        self.tool_calls
            .entry(index)
            .or_insert_with(|| ToolCallOut {
                item_id: uuid_id("fc_"),
                ..Default::default()
            });
    }

    /// Emits `response.output_item.added` with the populated item — OpenAI
    /// sends the function name at add-time; only `arguments` stream as
    /// deltas afterwards.
    fn emit_tool_call_added(&mut self, index: u64, out: &mut Vec<String>) {
        self.close_reasoning_item(out);
        self.close_message_item(out);
        let output_index = self.items.len();
        let Some(entry) = self.tool_calls.get_mut(&index) else {
            return;
        };
        entry.output_index = output_index;
        entry.emitted = true;
        let item = json!({
            "id": entry.item_id,
            "type": "function_call",
            "call_id": entry.call_id,
            "name": entry.name,
            "arguments": entry.arguments,
            "status": "in_progress",
        });
        self.items.push(item.clone());
        out.push(self.emit(
            "response.output_item.added",
            json!({ "output_index": output_index, "item": item }),
        ));
    }

    pub(crate) fn close_tool_call(&mut self, index: u64, out: &mut Vec<String>) {
        let Some(entry) = self.tool_calls.get(&index) else {
            return;
        };
        if !entry.emitted {
            // Never named — the call stays un-emitted entirely (same as the
            // non-stream path filtering out nameless tool calls).
            return;
        }
        let output_index = entry.output_index;
        let item_id = entry.item_id.clone();
        let call_id = entry.call_id.clone();
        let name = entry.name.clone();
        let arguments = entry.arguments.clone();
        out.push(self.emit(
            "response.function_call_arguments.done",
            json!({
                "item_id": item_id,
                "output_index": output_index,
                "arguments": arguments,
            }),
        ));
        self.items[output_index] = json!({
            "id": item_id,
            "type": "function_call",
            "call_id": call_id,
            "name": name,
            "arguments": arguments,
            "status": "completed",
        });
        let item = self.items[output_index].clone();
        out.push(self.emit(
            "response.output_item.done",
            json!({ "output_index": output_index, "item": item }),
        ));
    }

    pub(crate) fn finalize(&mut self, out: &mut Vec<String>) {
        self.start_events(out);
        self.close_reasoning_item(out);
        self.close_message_item(out);
        let indices: Vec<u64> = self.tool_calls.keys().copied().collect();
        for index in indices {
            let entry = &self.tool_calls[&index];
            if entry.emitted
                && self.items[entry.output_index]
                    .get("status")
                    .and_then(Value::as_str)
                    == Some("in_progress")
            {
                self.close_tool_call(index, out);
            }
        }
        let status = match self.last_finish_reason.as_deref() {
            Some("length") | Some("content_filter") => "incomplete",
            _ => "completed",
        };
        let incomplete = match self.last_finish_reason.as_deref() {
            Some("length") => json!({ "reason": "max_output_tokens" }),
            Some("content_filter") => json!({ "reason": "content_filter" }),
            _ => Value::Null,
        };
        let mut final_response = self.base_response(status);
        final_response["output"] = Value::Array(self.items.clone());
        final_response["output_text"] = json!(self.message_text);
        final_response["usage"] = if self.usage.is_null() {
            Value::Null
        } else {
            responses_usage(&self.usage)
        };
        final_response["incomplete_details"] = incomplete;
        let event = if status == "completed" {
            "response.completed"
        } else {
            "response.incomplete"
        };
        out.push(self.emit(event, json!({ "response": final_response })));
        self.completed = true;
    }

    pub(crate) fn feed(&mut self, data: &str) -> Vec<String> {
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
            self.start_events(&mut out);
            let mut resp = self.base_response("failed");
            resp["error"] = json!({
                "code": error.get("type").or_else(|| error.get("code"))
                    .and_then(Value::as_str).unwrap_or("api_error"),
                "message": error.get("message").and_then(Value::as_str)
                    .map(str::to_string).unwrap_or_else(|| error.to_string()),
            });
            out.push(self.emit("response.failed", json!({ "response": resp })));
            self.completed = true;
            return out;
        }

        if let Some(m) = payload.get("model").and_then(Value::as_str) {
            self.model = m.to_string();
        }
        if let Some(u) = payload.get("usage") {
            self.usage = u.clone();
        }

        let Some(choice) = payload
            .get("choices")
            .and_then(Value::as_array)
            .and_then(|c| c.first())
        else {
            return out;
        };
        let delta = choice.get("delta").cloned().unwrap_or(Value::Null);

        let reasoning = extract_delta_text(
            delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning")),
        );
        if !reasoning.is_empty() {
            self.ensure_reasoning_item(&mut out);
            self.reasoning_text.push_str(&reasoning);
            let index = self.reasoning_item_index.unwrap_or(0);
            out.push(self.emit(
                "response.reasoning_summary_text.delta",
                json!({
                    "item_id": self.reasoning_item_id,
                    "output_index": index,
                    "summary_index": 0,
                    "delta": reasoning,
                }),
            ));
        }

        let text = extract_delta_text(delta.get("content"));
        if !text.is_empty() {
            self.ensure_message_item(&mut out);
            self.message_text.push_str(&text);
            let index = self.message_item_index.unwrap_or(0);
            out.push(self.emit(
                "response.output_text.delta",
                json!({
                    "item_id": self.message_item_id,
                    "output_index": index,
                    "content_index": 0,
                    "delta": text,
                }),
            ));
        }

        if let Some(Value::Array(calls)) = delta.get("tool_calls") {
            for call in calls {
                let index = call
                    .get("index")
                    .and_then(Value::as_u64)
                    .unwrap_or(self.tool_calls.len() as u64);
                self.ensure_tool_call(index, &mut out);
                let mut args_delta = String::new();
                {
                    let entry = self.tool_calls.entry(index).or_default();
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        entry.call_id = id.to_string();
                    }
                    if let Some(name) = call
                        .get("function")
                        .and_then(|f| f.get("name"))
                        .and_then(Value::as_str)
                    {
                        entry.name.push_str(name);
                    }
                    if let Some(args) = call
                        .get("function")
                        .and_then(|f| f.get("arguments"))
                        .and_then(Value::as_str)
                    {
                        entry.arguments.push_str(args);
                        args_delta = args.to_string();
                    }
                }
                // Emit `output_item.added` only once the name is known —
                // OpenAI populates it at add-time.
                let named = self.tool_calls[&index]
                    .name
                    .as_str()
                    .chars()
                    .any(|c| !c.is_whitespace());
                if named && !self.tool_calls[&index].emitted {
                    self.emit_tool_call_added(index, &mut out);
                }
                let (output_index, item_id) = {
                    let entry = &self.tool_calls[&index];
                    (entry.output_index, entry.item_id.clone())
                };
                let emitted = self.tool_calls[&index].emitted;
                if emitted && !args_delta.is_empty() {
                    out.push(self.emit(
                        "response.function_call_arguments.delta",
                        json!({
                            "item_id": item_id,
                            "output_index": output_index,
                            "delta": args_delta,
                        }),
                    ));
                }
            }
        }

        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.last_finish_reason = Some(reason.to_string());
        }
        out
    }

    pub(crate) fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        if !self.completed {
            self.finalize(&mut out);
        }
        out
    }
}

/// `chatCompletionSseToResponsesSse` port — wraps an OpenAI chat SSE text
/// stream into the Responses-API event stream.
pub fn chat_sse_to_responses<S>(source: S, request_body: Value) -> impl Stream<Item = String> + Send
where
    S: Stream<Item = String> + Send,
{
    struct State<S> {
        pub(crate) source: std::pin::Pin<Box<S>>,
        pub(crate) parser: SseParser,
        pub(crate) transformer: ResponsesSseTransformer,
        pub(crate) pending: VecDeque<String>,
        pub(crate) eof: bool,
    }
    futures::stream::unfold(
        State {
            source: Box::pin(source),
            parser: SseParser::default(),
            transformer: ResponsesSseTransformer::new(request_body),
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

use futures::StreamExt;
