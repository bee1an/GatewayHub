//! GptWeb upstream — port of `sentinel.ts`, `http.ts`, `streaming.ts`.
//! ChatGPT web backend-api: sentinel chat-requirements tokens (PoW),
//! conduit prepare, /f/conversation SSE with JSON-patch deltas.
//! The turnstile browser + nodeBridge workarounds are Electron-specific
//! and intentionally not ported.

use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};

use crate::types::AccountFile;

pub const DEFAULT_GPT_WEB_BASE_URL: &str = "https://chatgpt.com/backend-api";
pub const GPT_WEB_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
pub const GPT_WEB_CLIENT_BUILD_NUMBER: &str = "7034670";
pub const GPT_WEB_CLIENT_VERSION: &str = "prod-355892676443208d0eb87aeaeb17d3ef3327f23f";
/// "auto" is the web client's auto mode — a selector, not a model id.
pub const GPT_WEB_KNOWN_MODELS: &[&str] = &["auto"];

pub fn normalize_gptweb_model(model: &str) -> String {
    let t = model.trim();
    if t.is_empty() {
        "auto".into()
    } else {
        t.to_string()
    }
}

// ---------------------------------------------------------------------------
// sentinel.ts — requirements token + proof-of-work
// ---------------------------------------------------------------------------

const SCRIPT_CANDIDATES: &[&str] = &[
    "https://chatgpt.com/backend-api/sentinel/sdk.js",
    "https://chatgpt.com/c/prod-355892676443208d0eb87aeaeb17d3ef3327f23f/_next/static/chunks/sentinel.js",
];
const DOCUMENT_KEYS: &[&str] = &[
    "location",
    "cookie",
    "body",
    "head",
    "scripts",
    "documentElement",
    "querySelector",
    "createElement",
];
const WINDOW_KEYS: &[&str] = &[
    "document",
    "navigator",
    "screen",
    "performance",
    "crypto",
    "location",
    "setTimeout",
    "clearTimeout",
    "TextEncoder",
    "btoa",
    "atob",
];

fn random_pick(items: &[&'static str]) -> &'static str {
    items[fastrand::usize(..items.len())]
}

fn build_proof_config(nonce: u64, elapsed_ms: u64) -> Value {
    json!([
        2560,
        chrono::Utc::now().to_rfc2822(),
        4294705152u64,
        nonce,
        GPT_WEB_USER_AGENT,
        random_pick(SCRIPT_CANDIDATES),
        "c/prod-355892676443208d0eb87aeaeb17d3ef3327f23f/_",
        "en-US",
        "en-US,en",
        elapsed_ms,
        "userAgentData∈[object NavigatorUAData]",
        random_pick(DOCUMENT_KEYS),
        random_pick(WINDOW_KEYS),
        crate::pool::now_ms() % 1_000_000,
        uuid::Uuid::new_v4().to_string(),
        "",
        10,
        crate::pool::now_ms(),
        0,
        0,
        0,
        0,
        0,
        0,
        0,
    ])
}

fn encode_config(config: &Value) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .encode(serde_json::to_string(config).unwrap_or_default())
}

/// `buildRequirementsToken`.
pub fn build_requirements_token() -> String {
    format!("gAAAAAC{}", encode_config(&build_proof_config(1, 0)))
}

/// `solveProofOfWork` — FNV-style hash, first `difficulty.len()` hex chars
/// must be <= difficulty.
pub fn solve_proof_of_work(seed: &str, difficulty: &str) -> String {
    let mut config = build_proof_config(0, 0);
    for nonce in 0..500_000u64 {
        config[3] = json!(nonce);
        config[9] = json!(crate::pool::now_ms() % 1_000_000);
        let answer = encode_config(&config);
        if hash_challenge(&format!("{seed}{answer}"))[..difficulty.len().min(8)] <= *difficulty {
            return format!("gAAAAAB{answer}~S");
        }
    }
    "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4DZQ==".into()
}

/// FNV-1a-ish 32-bit hash from sentinel.ts (charCode iteration, xorshift
/// finalizer). Output is 8-hex-char string.
fn hash_challenge(input: &str) -> String {
    let mut hash: u32 = 2166136261;
    for ch in input.chars() {
        hash ^= ch as u32;
        hash = hash.wrapping_mul(16777619);
    }
    hash ^= hash >> 16;
    hash = hash.wrapping_mul(2246822507);
    hash ^= hash >> 13;
    hash = hash.wrapping_mul(3266489909);
    hash ^= hash >> 16;
    format!("{hash:08x}")
}

// ---------------------------------------------------------------------------
// http.ts — headers + sentinel/conduit/conversation endpoints
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct SentinelTokens {
    pub chat_requirements_token: Option<String>,
    pub proof_token: Option<String>,
    pub turnstile_token: Option<String>,
    pub cookie_header: Option<String>,
}

fn build_headers(
    account: &AccountFile,
    base_url: &str,
    cookie: Option<&str>,
) -> Vec<(String, String)> {
    let f = |k: &str| {
        account
            .fields
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let origin = build_origin(base_url);
    let mut headers = vec![
        (
            "authorization".into(),
            format!("Bearer {}", f("accessToken")),
        ),
        ("oai-device-id".into(), f("oaiDeviceId")),
        ("oai-language".into(), "en-US".into()),
        (
            "oai-client-build-number".into(),
            GPT_WEB_CLIENT_BUILD_NUMBER.into(),
        ),
        ("oai-client-version".into(), GPT_WEB_CLIENT_VERSION.into()),
        ("chatgpt-account-id".into(), f("accountId")),
        ("content-type".into(), "application/json".into()),
        ("user-agent".into(), GPT_WEB_USER_AGENT.into()),
        ("oai-session-id".into(), uuid::Uuid::new_v4().to_string()),
        ("origin".into(), origin.clone()),
        ("referer".into(), format!("{origin}/")),
    ];
    if let Some(c) = cookie {
        headers.push(("cookie".into(), c.to_string()));
    }
    headers
}

fn build_origin(base_url: &str) -> String {
    let base = if base_url.is_empty() {
        DEFAULT_GPT_WEB_BASE_URL
    } else {
        base_url
    };
    let stripped = base.trim_end_matches('/').trim_end_matches("/backend-api");
    // keep scheme://host
    match stripped.find("://") {
        Some(i) => {
            let rest = &stripped[i + 3..];
            let host_end = rest.find('/').unwrap_or(rest.len());
            format!("{}://{}", &stripped[..i], &rest[..host_end])
        }
        None => stripped.to_string(),
    }
}

fn apply_sentinel_headers(headers: &mut Vec<(String, String)>, tokens: &SentinelTokens) {
    if let Some(t) = &tokens.chat_requirements_token {
        headers.push(("openai-sentinel-chat-requirements-token".into(), t.clone()));
    }
    if let Some(t) = &tokens.proof_token {
        headers.push(("openai-sentinel-proof-token".into(), t.clone()));
    }
    if let Some(t) = &tokens.turnstile_token {
        headers.push(("openai-sentinel-turnstile-token".into(), t.clone()));
    }
}

/// `fetchSentinelTokens` — prepare → optional PoW → finalize.
pub async fn fetch_sentinel_tokens(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> SentinelTokens {
    let requirements_token = build_requirements_token();
    let prepare = client
        .post(format!("{base_url}/sentinel/chat-requirements/prepare"))
        .timeout(Duration::from_secs(30));
    let mut req = prepare.json(&json!({ "p": requirements_token }));
    for (k, v) in build_headers(account, base_url, None) {
        req = req.header(k, v);
    }
    let Ok(res) = req.send().await else {
        return SentinelTokens::default();
    };
    if res.status().as_u16() >= 400 {
        return SentinelTokens::default();
    }
    let prepare: Value = res.json().await.unwrap_or(Value::Null);
    let proof = if prepare
        .pointer("/proofofwork/required")
        .and_then(Value::as_bool)
        == Some(true)
    {
        let seed = prepare
            .pointer("/proofofwork/seed")
            .and_then(Value::as_str)
            .unwrap_or("");
        let difficulty = prepare
            .pointer("/proofofwork/difficulty")
            .and_then(Value::as_str)
            .unwrap_or("");
        if seed.is_empty() {
            None
        } else {
            let seed = seed.to_string();
            let difficulty = difficulty.to_string();
            Some(
                tokio::task::spawn_blocking(move || solve_proof_of_work(&seed, &difficulty))
                    .await
                    .unwrap_or_default(),
            )
        }
    } else {
        None
    };
    let mut finalize_body = json!({ "prepare_token": prepare.get("prepare_token") });
    if let Some(p) = &proof {
        finalize_body["proofofwork"] = json!(p);
    }
    let mut req = client
        .post(format!("{base_url}/sentinel/chat-requirements/finalize"))
        .timeout(Duration::from_secs(30))
        .json(&finalize_body);
    for (k, v) in build_headers(account, base_url, None) {
        req = req.header(k, v);
    }
    let Ok(res) = req.send().await else {
        return SentinelTokens {
            proof_token: proof,
            ..Default::default()
        };
    };
    if res.status().as_u16() >= 400 {
        return SentinelTokens {
            proof_token: proof,
            ..Default::default()
        };
    }
    let finalize: Value = res.json().await.unwrap_or(Value::Null);
    SentinelTokens {
        chat_requirements_token: finalize
            .get("token")
            .and_then(Value::as_str)
            .map(str::to_string),
        proof_token: proof,
        ..Default::default()
    }
}

/// `fetchConduitToken` — POST /f/conversation/prepare.
pub async fn fetch_conduit_token(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
    body: &Value,
    sentinel: &SentinelTokens,
) -> anyhow::Result<Option<String>> {
    let mut headers = build_headers(account, base_url, sentinel.cookie_header.as_deref());
    apply_sentinel_headers(&mut headers, sentinel);
    let mut req = client
        .post(format!("{base_url}/f/conversation/prepare"))
        .timeout(Duration::from_secs(30))
        .json(body);
    for (k, v) in headers {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    if status >= 400 {
        let text = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "GptWeb conduit prepare error {status}: {}",
            text.chars().take(200).collect::<String>()
        );
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(data
        .get("conduit_token")
        .and_then(Value::as_str)
        .map(str::to_string))
}

/// `streamConversation` — POST /f/conversation → raw SSE lines.
pub fn stream_conversation(
    client: reqwest::Client,
    base_url: String,
    account: AccountFile,
    body: Value,
    sentinel: SentinelTokens,
    conduit_token: Option<String>,
    read_timeout: Duration,
) -> impl Stream<Item = Result<String, anyhow::Error>> + Send {
    async_stream::stream! {
        let mut headers = build_headers(&account, &base_url, sentinel.cookie_header.as_deref());
        headers.push(("accept".into(), "text/event-stream".into()));
        headers.push(("x-openai-target-path".into(), "/backend-api/f/conversation".into()));
        headers.push(("x-openai-target-route".into(), "/backend-api/f/conversation".into()));
        apply_sentinel_headers(&mut headers, &sentinel);
        if let Some(t) = &conduit_token {
            headers.push(("x-conduit-token".into(), t.clone()));
        }
        let mut req = client
            .post(format!("{base_url}/f/conversation"))
            .timeout(read_timeout)
            .json(&body);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => { yield Err(e.into()); return; }
        };
        let status = res.status().as_u16();
        if status >= 400 {
            let text = res.text().await.unwrap_or_default();
            yield Err(anyhow::anyhow!(
                "GptWeb API error {status}: {}",
                text.chars().take(200).collect::<String>()
            ));
            return;
        }
        use futures::StreamExt;
        let mut byte_stream = res.bytes_stream();
        let mut buffer = String::new();
        while let Some(item) = byte_stream.next().await {
            match item {
                Ok(bytes) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(idx) = buffer.find('\n') {
                        let line: String = buffer.drain(..=idx).collect();
                        let line = line.trim_end_matches(['\r', '\n']);
                        if !line.trim().is_empty() {
                            yield Ok(line.to_string());
                        }
                    }
                }
                Err(e) => { yield Err(e.into()); return; }
            }
        }
        if !buffer.trim().is_empty() {
            yield Ok(buffer.trim().to_string());
        }
    }
}

/// `fetchModels` — /models?iim=false&is_gizmo=false.
pub async fn fetch_gptweb_models(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<Vec<String>> {
    let mut req = client
        .get(format!("{base_url}/models?iim=false&is_gizmo=false"))
        .timeout(Duration::from_secs(20));
    for (k, v) in build_headers(account, base_url, None) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    if status >= 400 {
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "GptWeb models error {status}: {}",
            body.chars().take(200).collect::<String>()
        );
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    let models = data.get("models").and_then(Value::as_array);
    let Some(models) = models else {
        anyhow::bail!("GptWeb models response missing models array");
    };
    let mut seen = std::collections::BTreeSet::new();
    for m in models {
        if let Some(slug) = m.get("slug").and_then(Value::as_str) {
            let slug = slug.trim();
            if !slug.is_empty() {
                seen.insert(slug.to_string());
            }
        }
    }
    seen.insert("auto".into());
    let ids: Vec<String> = seen.into_iter().collect();
    let plan = account
        .fields
        .get("planType")
        .and_then(Value::as_str)
        .unwrap_or("free");
    if plan == "free" {
        Ok(ids
            .into_iter()
            .filter(|id| GPT_WEB_KNOWN_MODELS.contains(&id.as_str()))
            .collect())
    } else {
        Ok(ids)
    }
}

// ---------------------------------------------------------------------------
// streaming.ts — body conversion + delta parser
// ---------------------------------------------------------------------------

/// `convertOpenAIToGptWebBody`.
pub fn convert_openai_to_gptweb_body(messages: &[Value], model: &str) -> Value {
    let converted: Vec<Value> = messages
        .iter()
        .map(|msg| {
            let role = match msg.get("role").and_then(Value::as_str) {
                Some("assistant") => "assistant",
                Some("system") => "system",
                _ => "user",
            };
            let text = match msg.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter(|p| p.get("type").and_then(Value::as_str) == Some("text"))
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join("\n"),
                _ => String::new(),
            };
            json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "author": { "role": role },
                "content": { "content_type": "text", "parts": [text] },
                "metadata": { "serialization_metadata": { "custom_symbol_offsets": [] } },
            })
        })
        .collect();
    json!({
        "action": "next",
        "messages": converted,
        "model": if model.is_empty() { "auto".to_string() } else { model.to_string() },
        "conversation_mode": { "kind": "primary_assistant" },
        "enable_message_followups": true,
        "system_hints": [],
        "supports_buffering": true,
        "supported_encodings": ["v1"],
        "timezone_offset_min": 0,
        "timezone": "UTC",
        "client_contextual_info": {
            "is_dark_mode": false,
            "time_since_loaded": 120,
            "page_height": 924,
            "page_width": 1200,
            "pixel_ratio": 1,
            "screen_height": 1080,
            "screen_width": 1920,
            "app_name": "chatgpt.com",
        },
        "paragen_cot_summary_display_override": "allow",
        "force_parallel_switch": "auto",
    })
}

#[derive(Default)]
pub struct GptWebStreamingState {
    pub message_id: String,
    pub model: String,
    pub content: String,
    pub finished: bool,
}

/// `parseGptWebSSE` — returns (sse_line_to_emit, done).
pub fn parse_gptweb_sse(line: &str, state: &mut GptWebStreamingState) -> (Option<String>, bool) {
    if line == "data: [DONE]" {
        return (Some(build_openai_chunk(state, "", Some("stop"))), true);
    }
    if line.starts_with("event: delta_encoding") {
        return (None, false);
    }
    let Some(json_str) = line.strip_prefix("data: ") else {
        return (None, false);
    };
    let Ok(data) = serde_json::from_str::<Value>(json_str) else {
        return (None, false);
    };
    if !data.is_object() {
        return (None, false);
    }
    if data.get("type").and_then(Value::as_str) == Some("message_stream_complete") {
        return (None, false);
    }
    if data.get("p").is_some()
        || data.get("o").is_some()
        || data.get("v").is_some()
        || data.get("c").is_some()
    {
        return handle_delta(&data, state);
    }
    (None, false)
}

fn handle_delta(delta: &Value, state: &mut GptWebStreamingState) -> (Option<String>, bool) {
    capture_message_metadata(delta.get("v"), state);
    let op = delta.get("o").and_then(Value::as_str);
    let path = delta.get("p").and_then(Value::as_str).unwrap_or("");
    if op == Some("add") && delta.get("v").is_some_and(|v| v.is_object()) {
        return (None, false);
    }
    if op == Some("append") && path.contains("/content/parts/") {
        if let Some(text) = delta.get("v").and_then(Value::as_str)
            && !text.is_empty()
        {
            state.content.push_str(text);
            return (Some(build_openai_chunk(state, text, None)), false);
        }
    }
    if op.is_none()
        && delta.get("p").is_none()
        && let Some(text) = delta.get("v").and_then(Value::as_str)
    {
        state.content.push_str(text);
        return (Some(build_openai_chunk(state, text, None)), false);
    }
    if op == Some("patch")
        && let Some(patches) = delta.get("v").and_then(Value::as_array)
    {
        let mut text = String::new();
        for patch in patches {
            if patch.get("o").and_then(Value::as_str) == Some("append")
                && patch
                    .get("p")
                    .and_then(Value::as_str)
                    .is_some_and(|p| p.contains("/content/parts/"))
                && let Some(v) = patch.get("v").and_then(Value::as_str)
            {
                text.push_str(v);
            }
            if patch.get("o").and_then(Value::as_str) == Some("replace")
                && patch.get("p").and_then(Value::as_str) == Some("/message/status")
                && patch.get("v").and_then(Value::as_str) == Some("finished_successfully")
            {
                state.finished = true;
            }
        }
        if !text.is_empty() {
            state.content.push_str(&text);
            return (
                Some(build_openai_chunk(
                    state,
                    &text,
                    if state.finished { Some("stop") } else { None },
                )),
                false,
            );
        }
        if state.finished {
            return (Some(build_openai_chunk(state, "", Some("stop"))), false);
        }
    }
    (None, false)
}

fn capture_message_metadata(value: Option<&Value>, state: &mut GptWebStreamingState) {
    let Some(msg) = value.and_then(|v| v.get("message")) else {
        return;
    };
    if let Some(id) = msg.get("id").and_then(Value::as_str) {
        state.message_id = id.to_string();
    }
    if let Some(meta) = msg.get("metadata") {
        if let Some(slug) = meta.get("resolved_model_slug").and_then(Value::as_str) {
            state.model = slug.to_string();
        }
        if let Some(slug) = meta.get("model_slug").and_then(Value::as_str) {
            state.model = slug.to_string();
        }
    }
}

fn build_openai_chunk(state: &GptWebStreamingState, content: &str, finish: Option<&str>) -> String {
    let chunk = json!({
        "id": format!("chatcmpl-{}", if state.message_id.is_empty() {
            uuid::Uuid::new_v4().simple().to_string()
        } else {
            state.message_id.clone()
        }),
        "object": "chat.completion.chunk",
        "created": crate::responses_api::now_secs(),
        "model": if state.model.is_empty() { "gpt-4o".to_string() } else { state.model.clone() },
        "choices": [{
            "index": 0,
            "delta": if content.is_empty() { json!({}) } else { json!({"content": content}) },
            "finish_reason": finish,
        }],
    });
    format!(
        "data: {}\n\n",
        serde_json::to_string(&chunk).unwrap_or_default()
    )
}

/// `buildNonStreamResponse`.
pub fn build_non_stream_response(text: &str, model: &str, output_tokens: u64) -> Value {
    json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4()),
        "object": "chat.completion",
        "created": crate::responses_api::now_secs(),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": text},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": 0,
            "completion_tokens": output_tokens,
            "total_tokens": output_tokens,
        },
    })
}

#[allow(dead_code)]
fn _unused(_: &sha2::Sha256) {}
