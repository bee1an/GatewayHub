//! GeminiWeb provider — port of `providers/geminiweb/*`.
//! Cookie auth → /app SNlM0e scrape → StreamGenerate form POST →
//! newline-delimited JSON-array frames carrying cumulative text.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::{Stream, StreamExt};
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use tokio::sync::Mutex;

use crate::http::UpstreamHttp;
use crate::pool::{AccountPool, AccountWithState, now_ms};
use crate::protocol::{
    anthropic_messages_to_openai, openai_completion_to_anthropic, openai_sse_to_anthropic,
};
use crate::provider::ProviderAdapter;
use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, AccountTestResult, ClassifiedError,
    GatewayLogEntry, GatewayRequestContext, GatewayResponse, JsonMap, LogLevel, LogSink,
    ProviderModel, ProviderStatus, ResponseKind, UsageMeta, UsageStats,
};

pub const DEFAULT_GEMINI_WEB_BASE_URL: &str = "https://gemini.google.com";
pub const GEMINI_APP_PATH: &str = "/app";
pub const GEMINI_STREAM_GENERATE_PATH: &str =
    "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
pub const GEMINI_ROTATE_COOKIES_URL: &str = "https://accounts.google.com/RotateCookies";
pub const GEMINI_WEB_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
pub const GEMINI_WEB_DEFAULT_MODEL: &str = "gemini-3.5-flash";
pub const GEMINI_WEB_KNOWN_MODELS: &[&str] = &[
    "gemini-3.1-pro",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
];

fn model_header(mode_id: &str) -> String {
    serde_json::to_string(&json!([
        1,
        null,
        null,
        null,
        mode_id,
        null,
        null,
        0,
        [4],
        null,
        null,
        1
    ]))
    .unwrap_or_default()
}

/// `geminiWebModelHeader` — model id → x-goog-ext-525001261-jspb value.
pub fn gemini_web_model_header(model: &str) -> String {
    match normalize_geminiweb_model(model).as_str() {
        "gemini-3.1-pro" => model_header("e6fa609c3fa255c0"),
        "gemini-3.5-flash" => model_header("56fdd199312815e2"),
        "gemini-3.1-flash-lite" => model_header("8c46e95b1a07cecc"),
        _ => String::new(),
    }
}

pub fn normalize_geminiweb_model(model: &str) -> String {
    let t = model.trim();
    if t.is_empty() {
        GEMINI_WEB_DEFAULT_MODEL.into()
    } else {
        t.to_string()
    }
}

#[derive(Debug, Clone)]
struct GeminiWebSettings {
    base_url: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
}

// ---------------------------------------------------------------------------
// http.ts — SAPISID hash, /app scrape, SIDTS rotate, StreamGenerate
// ---------------------------------------------------------------------------

fn cookie_field(account: &AccountFile) -> String {
    account
        .fields
        .get("cookieHeader")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn extract_sapisid(cookie: &str) -> Option<String> {
    regex::Regex::new(r"(?:^|;\s*)SAPISID=([^;]+)")
        .unwrap()
        .captures(cookie)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

/// `buildSapisidHash` — SAPISIDHASH <ts_ms>_<sha1(ts ms SAPISID origin)>.
fn build_sapisid_hash(sapisid: &str, origin: &str) -> String {
    let ts = now_ms();
    let hash = Sha1::digest(format!("{ts} {sapisid} {origin}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("SAPISIDHASH {ts}_{hash}")
}

fn gemini_headers(account: &AccountFile, model_header: &str) -> Vec<(String, String)> {
    let origin = "https://gemini.google.com";
    let mut headers = vec![
        (
            "Content-Type".into(),
            "application/x-www-form-urlencoded;charset=utf-8".into(),
        ),
        ("Origin".into(), origin.into()),
        ("Referer".into(), "https://gemini.google.com/".into()),
        ("User-Agent".into(), GEMINI_WEB_USER_AGENT.into()),
        ("X-Same-Domain".into(), "1".into()),
        ("Cookie".into(), cookie_field(account)),
    ];
    if let Some(sapisid) = extract_sapisid(&cookie_field(account)) {
        headers.push(("Authorization".into(), build_sapisid_hash(&sapisid, origin)));
    }
    if !model_header.is_empty() {
        headers.push(("x-goog-ext-525001261-jspb".into(), model_header.to_string()));
    }
    headers
}

/// `fetchAccessToken` — /app page, scrape `"SNlM0e":"..."` + `oPEP7c` email.
async fn fetch_access_token(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<(String, Option<String>)> {
    let res = client
        .get(format!(
            "{}{}",
            base_url.trim_end_matches('/'),
            GEMINI_APP_PATH
        ))
        .header("User-Agent", GEMINI_WEB_USER_AGENT)
        .header("Cookie", cookie_field(account))
        .header("Referer", "https://gemini.google.com/")
        .timeout(Duration::from_secs(30))
        .send()
        .await?;
    if res.status().as_u16() >= 400 {
        anyhow::bail!("Gemini Web app error {}", res.status().as_u16());
    }
    let html = res.text().await.unwrap_or_default();
    let token = regex::Regex::new(r#""SNlM0e":"(.*?)""#)
        .unwrap()
        .captures(&html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    let Some(token) = token else {
        anyhow::bail!("Gemini Web session tokens not found (cookie may be invalid or expired)");
    };
    let email = regex::Regex::new(r#""oPEP7c":"(.*?)""#)
        .unwrap()
        .captures(&html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    Ok((token, email))
}

/// `rotateSidts` — RotateCookies → new __Secure-1PSIDTS.
async fn rotate_sidts(client: &reqwest::Client, account: &AccountFile) -> Option<String> {
    let res = client
        .post(GEMINI_ROTATE_COOKIES_URL)
        .header("Content-Type", "application/json")
        .header("Cookie", cookie_field(account))
        .body("[000,\"-0000000000000000000\"]")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .ok()?;
    if res.status().as_u16() >= 400 {
        return None;
    }
    let set_cookie = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(str::to_string))
        .collect::<Vec<_>>()
        .join(";");
    regex::Regex::new(r"__Secure-1PSIDTS=([^;]+)")
        .unwrap()
        .captures(&set_cookie)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

/// `patchSidts`.
fn patch_sidts(cookie_header: &str, new_sidts: &str) -> String {
    let re1 = regex::Regex::new(r"__Secure-1PSIDTS=[^;]+").unwrap();
    let re3 = regex::Regex::new(r"__Secure-3PSIDTS=[^;]+").unwrap();
    let mut updated = re1
        .replace_all(
            cookie_header,
            format!("__Secure-1PSIDTS={new_sidts}").as_str(),
        )
        .to_string();
    updated = re3
        .replace_all(&updated, format!("__Secure-3PSIDTS={new_sidts}").as_str())
        .to_string();
    if !updated.contains(&format!("__Secure-1PSIDTS={new_sidts}")) {
        updated.push_str(&format!("; __Secure-1PSIDTS={new_sidts}"));
    }
    updated
}

#[derive(Debug, Clone)]
pub enum GeminiStreamEvent {
    Text(String),
    Done,
    Error(String),
}

/// `streamGeminiConversation` — fetchAccessToken (with SIDTS rotate retry)
/// → StreamGenerate form POST → incremental line parser.
fn stream_gemini_conversation(
    client: reqwest::Client,
    base_url: String,
    account: AccountFile,
    prompt: String,
    model: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
) -> impl Stream<Item = Result<GeminiStreamEvent, anyhow::Error>> + Send {
    async_stream::stream! {
        let mut account = account;
        let session = match fetch_access_token(&client, &base_url, &account).await {
            Ok(s) => s,
            Err(e) if e.to_string().contains("session tokens not found") => {
                match rotate_sidts(&client, &account).await {
                    Some(new_sidts) => {
                        let cookie = patch_sidts(&cookie_field(&account), &new_sidts);
                        account.fields.insert("cookieHeader".into(), json!(cookie));
                        match fetch_access_token(&client, &base_url, &account).await {
                            Ok(s) => s,
                            Err(e) => { yield Err(e); return; }
                        }
                    }
                    None => { yield Err(e); return; }
                }
            }
            Err(e) => { yield Err(e); return; }
        };
        let (access_token, _email) = session;
        let header = gemini_web_model_header(&model);
        let inner = serde_json::to_string(&json!([[prompt], null, [null, null, null]]))
            .unwrap_or_default();
        let f_req = serde_json::to_string(&json!([null, inner])).unwrap_or_default();
        let body = format!(
            "at={}&f.req={}",
            urlencoded(&access_token),
            urlencoded(&f_req)
        );
        let mut req = client
            .post(format!(
                "{}{}",
                base_url.trim_end_matches('/'),
                GEMINI_STREAM_GENERATE_PATH
            ))
            .timeout(first_token_timeout + streaming_read_timeout)
            .body(body);
        for (k, v) in gemini_headers(&account, &header) {
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
                "Gemini Web stream error {status}: {}",
                text.chars().take(200).collect::<String>()
            ));
            return;
        }
        let mut byte_stream = res.bytes_stream();
        let mut buffer = String::new();
        let mut saw_first_content = false;
        let mut finished = false;
        loop {
            let timeout = if saw_first_content { streaming_read_timeout } else { first_token_timeout };
            match tokio::time::timeout(timeout, byte_stream.next()).await {
                Ok(Some(Ok(bytes))) => {
                    buffer.push_str(&String::from_utf8_lossy(&bytes));
                    while let Some(nl) = buffer.find('\n') {
                        let line: String = buffer.drain(..=nl).collect();
                        let line = line.trim_end_matches('\n').trim_end_matches('\r');
                        for event in parse_stream_line(line) {
                            match event {
                                GeminiStreamEvent::Text(delta) => {
                                    if !delta.is_empty() {
                                        saw_first_content = true;
                                    }
                                    yield Ok(GeminiStreamEvent::Text(delta));
                                }
                                GeminiStreamEvent::Done => {
                                    yield Ok(GeminiStreamEvent::Done);
                                    return;
                                }
                                GeminiStreamEvent::Error(m) => {
                                    yield Ok(GeminiStreamEvent::Error(m));
                                    return;
                                }
                            }
                        }
                    }
                }
                Ok(Some(Err(e))) => { yield Err(e.into()); return; }
                Ok(None) => break,
                Err(_) => {
                    yield Err(anyhow::anyhow!(
                        if saw_first_content {
                            "Gemini Web stream read timed out"
                        } else {
                            "Gemini Web first token timed out"
                        }
                    ));
                    return;
                }
            }
        }
        if !buffer.trim().is_empty() {
            for event in parse_stream_line(buffer.trim()) {
                match event {
                    GeminiStreamEvent::Done => {
                        finished = true;
                        yield Ok(GeminiStreamEvent::Done);
                        break;
                    }
                    other => yield Ok(other),
                }
            }
        }
        if !finished {
            yield Ok(GeminiStreamEvent::Done);
        }
    }
}

fn urlencoded(s: &str) -> String {
    s.chars()
        .flat_map(|c| {
            if c.is_ascii_alphanumeric() || "-_.~".contains(c) {
                vec![c]
            } else {
                format!("%{:02X}", c as u32).chars().collect()
            }
        })
        .collect()
}

/// `parseStreamLine` — `)]}'` prefix / length markers / wrb.fr frames.
fn parse_stream_line(line: &str) -> Vec<GeminiStreamEvent> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed == ")]}'" {
        return Vec::new();
    }
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Vec::new();
    }
    let Ok(arr) = serde_json::from_str::<Value>(trimmed) else {
        return Vec::new();
    };
    let Some(entries) = arr.as_array() else {
        return Vec::new();
    };
    let mut events = Vec::new();
    for entry in entries {
        let Some(entry) = entry.as_array() else {
            continue;
        };
        // find the first string slot starting with '['
        let inner_str = entry
            .iter()
            .filter_map(Value::as_str)
            .find(|s| s.starts_with('['));
        let Some(inner_str) = inner_str else { continue };
        let Ok(payload) = serde_json::from_str::<Value>(inner_str) else {
            continue;
        };
        let Some(payload) = payload.as_array() else {
            continue;
        };
        if payload.first().and_then(Value::as_str) == Some("er") {
            let code = payload
                .get(2)
                .or_else(|| payload.get(1))
                .map(|v| match v {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .unwrap_or_else(|| "unknown".into());
            events.push(GeminiStreamEvent::Error(format!(
                "Gemini Web generation error (code {code})"
            )));
            continue;
        }
        // cumulative candidate text at payload[4][i][1][0]
        if let Some(candidates) = payload.get(4).and_then(Value::as_array) {
            for candidate in candidates {
                if let Some(text) = candidate
                    .get(1)
                    .and_then(|n| n.get(0))
                    .and_then(Value::as_str)
                    && !text.is_empty()
                {
                    events.push(GeminiStreamEvent::Text(text.to_string()));
                }
            }
        }
    }
    events
}

// ---------------------------------------------------------------------------
// streaming.ts — prompt flatten + cumulative-delta state
// ---------------------------------------------------------------------------

fn convert_openai_to_gemini_prompt(messages: &[Value]) -> String {
    let normalized: Vec<String> = messages
        .iter()
        .filter_map(|message| {
            let text = extract_text(message.get("content").unwrap_or(&Value::Null));
            let text = text.trim();
            if text.is_empty() {
                return None;
            }
            let role = match message.get("role").and_then(Value::as_str) {
                Some("assistant") => "assistant",
                Some("system") => "system",
                _ => "user",
            };
            Some(if role == "user" {
                text.to_string()
            } else {
                format!("[{role}]\n{text}")
            })
        })
        .collect();
    if normalized.is_empty() {
        "Hello".into()
    } else {
        normalized.join("\n\n")
    }
}

fn extract_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| {
                let ty = part.get("type").and_then(Value::as_str).unwrap_or("");
                if !ty.is_empty() && ty != "text" && ty != "input_text" {
                    return String::new();
                }
                part.get("text")
                    .or_else(|| part.get("input_text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[derive(Default)]
struct GeminiStreamingState {
    model: String,
    content: String,
    finished: bool,
}

/// `parseGeminiBatchEvent` — cumulative → prefix-delta.
fn parse_gemini_batch_event(
    event: &GeminiStreamEvent,
    state: &mut GeminiStreamingState,
) -> anyhow::Result<(Option<String>, bool)> {
    match event {
        GeminiStreamEvent::Text(incoming) => {
            if incoming.is_empty() {
                return Ok((None, false));
            }
            let delta = if incoming.starts_with(&state.content) {
                incoming[state.content.len()..].to_string()
            } else {
                incoming.clone()
            };
            state.content = incoming.clone();
            if delta.is_empty() {
                return Ok((None, false));
            }
            Ok((Some(build_openai_chunk(state, &delta, None)), false))
        }
        GeminiStreamEvent::Done => {
            state.finished = true;
            Ok((Some(build_openai_chunk(state, "", Some("stop"))), true))
        }
        GeminiStreamEvent::Error(m) => {
            anyhow::bail!(
                "{}",
                if m.is_empty() {
                    "Gemini Web returned an error".to_string()
                } else {
                    m.clone()
                }
            )
        }
    }
}

fn build_openai_chunk(state: &GeminiStreamingState, content: &str, finish: Option<&str>) -> String {
    let chunk = json!({
        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4()),
        "object": "chat.completion.chunk",
        "created": crate::responses_api::now_secs(),
        "model": if state.model.is_empty() { "auto".to_string() } else { state.model.clone() },
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

// ---------------------------------------------------------------------------
// provider + accountPool
// ---------------------------------------------------------------------------

struct GeminiWebBehavior;
impl crate::pool::PoolBehavior for GeminiWebBehavior {
    fn provider_name(&self) -> &'static str {
        "geminiWeb"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_geminiweb_model(model)
    }
    fn account_has_model(&self, _a: &AccountWithState, _m: &str) -> bool {
        true
    }
    fn seed_models(&self) -> Vec<String> {
        GEMINI_WEB_KNOWN_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }
}

pub struct GeminiWebProvider {
    core: Arc<GeminiWebCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct GeminiWebCore {
    pool: Arc<Mutex<AccountPool<GeminiWebBehavior>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<GeminiWebSettings>,
    log: LogSink,
}

impl GeminiWebProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        _persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = geminiweb_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.base_url, Some(proxy_url))?;
        let mut pool = AccountPool::new(GeminiWebBehavior);
        pool.set_on_changed(on_changed);
        let mut states = provider_state
            .accounts
            .iter()
            .map(|(k, v)| (k.clone(), AccountRuntimeState::from_value(v)))
            .collect();
        pool.reload(
            account_files,
            &mut states,
            provider_state.current_account_index,
        );
        Ok(Self {
            core: Arc::new(GeminiWebCore {
                pool: Arc::new(Mutex::new(pool)),
                http: Arc::new(http),
                settings: Arc::new(settings),
                log,
            }),
            enabled: provider_config.enabled,
            display_name: provider_config.display_name.clone(),
        })
    }
}

impl GeminiWebCore {
    fn log_entry(
        &self,
        level: LogLevel,
        message: impl Into<String>,
        account: Option<&AccountWithState>,
        request_id: Option<&str>,
        duration_ms: Option<u64>,
        extra: Option<Value>,
    ) {
        (self.log)(GatewayLogEntry {
            ts: now_ms(),
            level,
            message: message.into(),
            provider: Some("geminiWeb".into()),
            account_id: account.map(|a| {
                a.config
                    .email
                    .clone()
                    .or_else(|| a.config.label.clone())
                    .unwrap_or_else(|| a.config.id.clone())
            }),
            request_id: request_id.map(str::to_string),
            category: Some("upstream".into()),
            status_code: None,
            duration: duration_ms,
            streaming: None,
            time_to_first_token: None,
            chunk_count: None,
            model: None,
            api_format: None,
            usage: extra,
            cost: None,
            error: None,
            extra: Default::default(),
        });
    }

    async fn get_account(&self, excluded: &HashSet<String>) -> Option<AccountWithState> {
        for relax in [false, true] {
            let candidates = self.pool.lock().await.ordered_candidates(excluded, relax);
            for id in candidates {
                let mut pool = self.pool.lock().await;
                pool.commit(&id);
                if let Some(acc) = pool.find(&id).cloned() {
                    return Some(acc);
                }
            }
        }
        None
    }

    async fn do_request(
        &self,
        account: &AccountWithState,
        model: &str,
        body: &Value,
    ) -> anyhow::Result<String> {
        let prompt = convert_openai_to_gemini_prompt(
            body.get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .as_slice(),
        );
        let events = stream_gemini_conversation(
            self.http.client(),
            self.settings.base_url.clone(),
            account.config.clone(),
            prompt,
            model.to_string(),
            self.settings.first_token_timeout,
            self.settings.streaming_read_timeout,
        );
        let mut state = GeminiStreamingState {
            model: model.to_string(),
            ..Default::default()
        };
        let mut events = Box::pin(events);
        while let Some(item) = events.next().await {
            let event = item?;
            let _ = parse_gemini_batch_event(&event, &mut state)?;
        }
        if state.content.is_empty() {
            anyhow::bail!("Empty response from GeminiWeb");
        }
        Ok(state.content)
    }

    fn stream(
        self: &Arc<Self>,
        model: String,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> impl Stream<Item = String> + Send + 'static {
        let view = self.clone();
        let request_id = ctx.request_id.clone();
        let on_usage = ctx.on_usage.clone();
        async_stream::stream! {
            let mut excluded = HashSet::new();
            let mut last_error = String::new();
            let total = view.pool.lock().await.accounts.len().max(1);
            for attempt in 0..total {
                let Some(account) = view.get_account(&excluded).await else {
                    break;
                };
                let started = now_ms();
                let prompt = convert_openai_to_gemini_prompt(
                    body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default().as_slice(),
                );
                let events = stream_gemini_conversation(
                    view.http.client(),
                    view.settings.base_url.clone(),
                    account.config.clone(),
                    prompt,
                    model.clone(),
                    view.settings.first_token_timeout,
                    view.settings.streaming_read_timeout,
                );
                let mut state = GeminiStreamingState { model: model.clone(), ..Default::default() };
                let mut events = Box::pin(events);
                let mut stream_error: Option<String> = None;
                let mut done = false;
                while let Some(item) = events.next().await {
                    match item {
                        Ok(event) => {
                            match parse_gemini_batch_event(&event, &mut state) {
                                Ok((chunk, d)) => {
                                    if let Some(chunk) = chunk {
                                        yield chunk;
                                    }
                                    if d {
                                        done = true;
                                        break;
                                    }
                                }
                                Err(e) => {
                                    stream_error = Some(e.to_string());
                                    break;
                                }
                            }
                        }
                        Err(e) => {
                            stream_error = Some(e.to_string());
                            break;
                        }
                    }
                }
                if let Some(err) = stream_error {
                    let classified = classify_geminiweb_error(&err);
                    view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                    excluded.insert(account.config.id.clone());
                    view.log_entry(
                        LogLevel::Warn,
                        format!("GeminiWeb stream failed: {err}"),
                        Some(&account),
                        Some(&request_id),
                        Some((now_ms() - started) as u64),
                        Some(json!({"kind": classified.kind, "attempt": attempt + 1})),
                    );
                    last_error = err;
                    if matches!(classified.kind, ResponseKind::Auth) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32))).await;
                    continue;
                }
                let _ = done;
                yield "data: [DONE]\n\n".to_string();
                view.pool.lock().await.report_success(&account.config.id);
                view.log_entry(
                    LogLevel::Info,
                    "GeminiWeb upstream success (stream)",
                    Some(&account),
                    Some(&request_id),
                    Some((now_ms() - started) as u64),
                    None,
                );
                if let Some(sink) = &on_usage {
                    sink(
                        UsageStats {
                            input_tokens: 0,
                            output_tokens: crate::providers::kiro_convert::estimate_tokens(&json!(state.content)),
                            estimated: Some(true),
                            ..Default::default()
                        },
                        UsageMeta {
                            account_id: Some(account.config.id.clone()),
                            model: Some(model.clone()),
                            provider: Some("geminiWeb".into()),
                        },
                    );
                }
                return;
            }
            let message = if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            };
            yield format!(
                "data: {}\n\n",
                serde_json::to_string(&json!({
                    "error": {"message": message, "type": "server_error"},
                }))
                .unwrap_or_default()
            );
        }
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for GeminiWebProvider {
    fn name(&self) -> &'static str {
        "geminiWeb"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        GEMINI_WEB_KNOWN_MODELS
            .iter()
            .map(|id| ProviderModel {
                id: id.to_string(),
                provider: "geminiWeb".into(),
                owned_by: Some("google".into()),
                description: Some("Model via Gemini Web".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_geminiweb_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(GEMINI_WEB_DEFAULT_MODEL),
        );
        if body.get("stream").and_then(Value::as_bool) != Some(false) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(self.core.clone().stream(model, body, ctx)),
            };
        }
        match self.non_stream(&model, &body, ctx).await {
            Ok(v) => GatewayResponse::json(200, v),
            Err(e) => GatewayResponse::error(502, e.to_string(), "gateway_error"),
        }
    }

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_geminiweb_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(GEMINI_WEB_DEFAULT_MODEL),
        );
        let openai_body = anthropic_messages_to_openai(&body, &model);
        if body.get("stream").and_then(Value::as_bool) == Some(true) {
            return GatewayResponse::Sse {
                status: 200,
                stream: Box::pin(openai_sse_to_anthropic(
                    self.core.clone().stream(model.clone(), openai_body, ctx),
                    model,
                )),
            };
        }
        match self.non_stream(&model, &openai_body, ctx).await {
            Ok(v) => GatewayResponse::json(200, openai_completion_to_anthropic(&v, &model, &body)),
            Err(e) => GatewayResponse::error(502, e.to_string(), "gateway_error"),
        }
    }

    async fn count_tokens(
        &self,
        body: Value,
        _ctx: &GatewayRequestContext,
    ) -> Option<GatewayResponse> {
        Some(GatewayResponse::json(
            200,
            json!({ "input_tokens": crate::providers::kiro_convert::estimate_tokens(&body) }),
        ))
    }

    async fn test_account(&self, account_id: &str) -> AccountTestResult {
        let config = {
            let pool = self.core.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let Some(config) = config else {
            return AccountTestResult {
                ok: false,
                account_id: account_id.into(),
                message: "Account not found".into(),
                ..Default::default()
            };
        };
        match fetch_access_token(
            &self.core.http.client(),
            &self.core.settings.base_url,
            &config,
        )
        .await
        {
            Ok((_token, email)) => {
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_updated_at = now_ms();
                    }
                }
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: format!(
                        "GeminiWeb account is valid{}",
                        email.map(|e| format!(" ({e})")).unwrap_or_default()
                    ),
                    models: GEMINI_WEB_KNOWN_MODELS
                        .iter()
                        .map(|s| s.to_string())
                        .collect(),
                    expires_at: None,
                    auth_type: Some("geminiweb-cookie".into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                let classified = classify_geminiweb_error(&message);
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.failures += 1;
                        acc.state.last_failure_at = now_ms();
                        acc.state.last_error = Some(message.clone());
                        acc.state.status = if classified.kind == ResponseKind::Auth {
                            AccountStatus::AuthFailed
                        } else {
                            AccountStatus::Cooling
                        };
                        acc.state.status_reason = Some(message.chars().take(200).collect());
                        acc.state.status_updated_at = now_ms();
                    }
                }
                AccountTestResult {
                    ok: false,
                    account_id: account_id.into(),
                    message,
                    ..Default::default()
                }
            }
        }
    }

    async fn get_account_info(&self, account_id: &str) -> anyhow::Result<Value> {
        let email = {
            let pool = self.core.pool.lock().await;
            pool.find(account_id).and_then(|a| a.config.email.clone())
        };
        Ok(json!({
            "id": account_id,
            "subscription": {"title": "GeminiWeb", "type": "web"},
            "email": email,
            "models": GEMINI_WEB_KNOWN_MODELS.iter().map(|m| json!({
                "modelId": m, "modelName": m, "rateMultiplier": 1, "rateUnit": "request",
            })).collect::<Vec<_>>(),
        }))
    }

    async fn refresh_account_models(&self, _account_id: &str) -> anyhow::Result<Vec<String>> {
        Ok(GEMINI_WEB_KNOWN_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect())
    }

    async fn reset_account(&self, account_id: &str) -> anyhow::Result<()> {
        self.core.pool.lock().await.reset_account(account_id);
        Ok(())
    }

    async fn set_account_status(
        &self,
        account_id: &str,
        status: AccountStatus,
        reason: Option<String>,
    ) -> anyhow::Result<()> {
        self.core
            .pool
            .lock()
            .await
            .set_account_status(account_id, status, reason)
    }

    fn status(&self) -> ProviderStatus {
        let accounts = self
            .core
            .pool
            .try_lock()
            .map(|p| p.accounts.len())
            .unwrap_or_default();
        ProviderStatus {
            name: "geminiWeb".into(),
            provider_type: "geminiWeb".into(),
            display_name: self.display_name.clone(),
            enabled: self.enabled,
            configured: accounts > 0,
            status: if !self.enabled {
                "disabled"
            } else if accounts > 0 {
                "ready"
            } else {
                "error"
            },
            message: if accounts > 0 {
                Some(format!("{accounts} account(s)"))
            } else {
                Some("No GeminiWeb accounts configured".into())
            },
            models: GEMINI_WEB_KNOWN_MODELS
                .iter()
                .map(|s| s.to_string())
                .collect(),
            use_proxy: None,
            accounts,
        }
    }
}

impl GeminiWebProvider {
    async fn non_stream(
        &self,
        model: &str,
        body: &Value,
        ctx: &GatewayRequestContext,
    ) -> anyhow::Result<Value> {
        let mut excluded = HashSet::new();
        let mut last_error = String::new();
        let total = self.core.pool.lock().await.accounts.len().max(1);
        for attempt in 0..total {
            let Some(account) = self.core.get_account(&excluded).await else {
                break;
            };
            let started = now_ms();
            match self.core.do_request(&account, model, body).await {
                Ok(text) => {
                    self.core
                        .pool
                        .lock()
                        .await
                        .report_success(&account.config.id);
                    self.core.log_entry(
                        LogLevel::Info,
                        "GeminiWeb upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    let out_tokens = crate::providers::kiro_convert::estimate_tokens(&json!(text));
                    if let Some(sink) = &ctx.on_usage {
                        sink(
                            UsageStats {
                                input_tokens: 0,
                                output_tokens: out_tokens,
                                estimated: Some(true),
                                ..Default::default()
                            },
                            UsageMeta {
                                account_id: Some(account.config.id.clone()),
                                model: Some(model.to_string()),
                                provider: Some("geminiWeb".into()),
                            },
                        );
                    }
                    return Ok(json!({
                        "id": format!("chatcmpl-{}", uuid::Uuid::new_v4()),
                        "object": "chat.completion",
                        "created": crate::responses_api::now_secs(),
                        "model": model,
                        "choices": [{
                            "index": 0,
                            "message": {"role": "assistant", "content": text},
                            "finish_reason": "stop",
                        }],
                        "usage": {"prompt_tokens": 0, "completion_tokens": out_tokens, "total_tokens": out_tokens},
                    }));
                }
                Err(e) => {
                    last_error = e.to_string();
                    let classified = classify_geminiweb_error(&last_error);
                    self.core.pool.lock().await.report_failure(
                        &account.config.id,
                        &last_error,
                        &classified,
                    );
                    excluded.insert(account.config.id.clone());
                    if matches!(classified.kind, ResponseKind::Auth) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(300 * 2_u64.pow(attempt as u32)))
                        .await;
                }
            }
        }
        anyhow::bail!(
            "GeminiWeb request failed: {}",
            if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            }
        )
    }
}

/// `classifyGeminiWebError` port (mirrors grokweb's table).
pub fn classify_geminiweb_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |s: &str| msg.contains(s);
    if has("401")
        || has("unauthorized")
        || has("not authenticated")
        || has("cookie may be invalid")
        || has("session tokens not found")
    {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if has("429")
        || has("rate limit")
        || has("too many")
        || has("403")
        || has("cloudflare")
        || has("challenge")
    {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has("timeout") || has("timed out") || has("aborted") {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 5_000,
            reset_at_iso: None,
        };
    }
    if has("fetch failed") || has("econn") || has("enotfound") || has("network") {
        return ClassifiedError {
            kind: ResponseKind::Network,
            cooldown_ms: 15_000,
            reset_at_iso: None,
        };
    }
    if has("quota") || has("capacity") {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 300_000,
            reset_at_iso: None,
        };
    }
    ClassifiedError {
        kind: ResponseKind::ServerError,
        cooldown_ms: 15_000,
        reset_at_iso: None,
    }
}

fn geminiweb_settings(settings: &JsonMap) -> GeminiWebSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    GeminiWebSettings {
        base_url: settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(DEFAULT_GEMINI_WEB_BASE_URL)
            .trim_end_matches('/')
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 30)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
    }
}
