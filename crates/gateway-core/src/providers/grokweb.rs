//! GrokWeb provider — port of `providers/grokweb/*`. WebSocket gw endpoint:
//! session.create → conversation.item.create → response.create →
//! response.output_text.delta events. Cookie auth via `cookieHeader`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, Stream, StreamExt};
use serde_json::{Value, json};
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

pub const DEFAULT_GROK_WEB_BASE_URL: &str = "https://grok.com";
pub const DEFAULT_GROK_WEB_WS_URL: &str = "wss://grok.com/ws/gw/";
pub const GROK_WEB_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
pub const GROK_WEB_DEFAULT_MODEL: &str = "auto";
pub const GROK_WEB_KNOWN_MODELS: &[&str] = &["auto"];

pub fn normalize_grokweb_model(model: &str) -> String {
    let t = model.trim();
    if t.is_empty() {
        GROK_WEB_DEFAULT_MODEL.into()
    } else {
        t.to_string()
    }
}

#[derive(Debug, Clone)]
struct GrokWebSettings {
    base_url: String,
    ws_url: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
}

// ---------------------------------------------------------------------------
// http.ts — REST + WS conversation
// ---------------------------------------------------------------------------

fn cookie_field(account: &AccountFile, key: &str) -> String {
    account
        .fields
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn build_headers(account: &AccountFile, base_url: &str, json_body: bool) -> Vec<(String, String)> {
    let origin = build_origin(base_url);
    vec![
        (
            "accept".into(),
            if json_body {
                "application/json, text/plain, */*".into()
            } else {
                "*/*".into()
            },
        ),
        ("accept-language".into(), "en-US,en;q=0.9".into()),
        ("user-agent".into(), GROK_WEB_USER_AGENT.into()),
        ("origin".into(), origin.clone()),
        ("referer".into(), format!("{origin}/")),
        ("cookie".into(), cookie_field(account, "cookieHeader")),
    ]
}

fn build_origin(base_url: &str) -> String {
    let base = if base_url.is_empty() {
        DEFAULT_GROK_WEB_BASE_URL
    } else {
        base_url
    };
    match base.find("://") {
        Some(i) => {
            let rest = &base[i + 3..];
            let end = rest.find('/').unwrap_or(rest.len());
            format!("{}://{}", &base[..i], &rest[..end])
        }
        None => base.to_string(),
    }
}

fn build_ws_url(ws_url: &str, account: &AccountFile) -> String {
    let base = if ws_url.is_empty() {
        DEFAULT_GROK_WEB_WS_URL
    } else {
        ws_url
    };
    let uid = {
        let u = cookie_field(account, "userId");
        if u.is_empty() {
            extract_cookie_value(&cookie_field(account, "cookieHeader"), "x-userid")
                .unwrap_or_default()
        } else {
            u
        }
    };
    if uid.is_empty() {
        base.to_string()
    } else {
        let joiner = if base.contains('?') { '&' } else { '?' };
        format!("{base}{joiner}uid={uid}")
    }
}

fn extract_cookie_value(cookie_header: &str, name: &str) -> Option<String> {
    let lower = name.to_lowercase();
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        if eq == 0 {
            continue;
        }
        if trimmed[..eq].trim().to_lowercase() == lower {
            return Some(trimmed[eq + 1..].trim().to_string());
        }
    }
    None
}

fn normalize_model_ids(ids: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = GROK_WEB_KNOWN_MODELS
        .iter()
        .map(|s| s.to_string())
        .collect();
    for id in ids {
        let t = id.trim().to_string();
        if !t.is_empty() && !seen.contains(&t) {
            seen.push(t);
        }
    }
    seen
}

/// `fetchModes` + `fetchModels` — modes preferred.
async fn fetch_grok_models(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<Vec<String>> {
    if let Ok(modes) = fetch_grok_modes(client, base_url, account).await
        && !modes.is_empty()
    {
        return Ok(normalize_model_ids(modes));
    }
    let mut req = client
        .post(format!("{}/rest/models", base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .json(&json!({ "locale": "en" }));
    for (k, v) in build_headers(account, base_url, true) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    if status >= 400 {
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "Grok Web models error {status}: {}",
            body.chars().take(200).collect::<String>()
        );
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    let mut ids: Vec<String> = Vec::new();
    for k in ["defaultFreeMode", "defaultFreeModel"] {
        if let Some(v) = data.get(k).and_then(Value::as_str) {
            ids.push(v.to_string());
        }
    }
    for m in data
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        for k in ["modelId", "name", "modeName"] {
            if let Some(v) = m.get(k).and_then(Value::as_str)
                && !v.is_empty()
            {
                ids.push(v.to_string());
                break;
            }
        }
    }
    Ok(normalize_model_ids(ids))
}

async fn fetch_grok_modes(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<Vec<String>> {
    let mut req = client
        .post(format!("{}/rest/modes", base_url.trim_end_matches('/')))
        .timeout(Duration::from_secs(20))
        .json(&json!({ "locale": "en" }));
    for (k, v) in build_headers(account, base_url, true) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    if res.status().as_u16() >= 400 {
        anyhow::bail!("Grok Web modes error {}", res.status().as_u16());
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    let mut ids: Vec<String> = Vec::new();
    if let Some(v) = data.get("defaultModeId").and_then(Value::as_str) {
        ids.push(v.to_string());
    }
    for m in data
        .get("modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        if m.pointer("/availability/available")
            .and_then(Value::as_bool)
            == Some(false)
        {
            continue;
        }
        if let Some(v) = m.get("id").and_then(Value::as_str) {
            ids.push(v.to_string());
        }
    }
    Ok(ids)
}

/// `fetchUser` — /rest/auth/get-user.
async fn fetch_grok_user(
    client: &reqwest::Client,
    base_url: &str,
    account: &AccountFile,
) -> anyhow::Result<Value> {
    let mut req = client
        .get(format!(
            "{}/rest/auth/get-user",
            base_url.trim_end_matches('/')
        ))
        .timeout(Duration::from_secs(20));
    for (k, v) in build_headers(account, base_url, false) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    if status >= 400 {
        let body = res.text().await.unwrap_or_default();
        anyhow::bail!(
            "Grok Web user error {status}: {}",
            body.chars().take(200).collect::<String>()
        );
    }
    let data: Value = res.json().await.unwrap_or(Value::Null);
    Ok(data.get("user").cloned().unwrap_or(data))
}

// ---------------------------------------------------------------------------
// WS conversation — http.ts streamGrokConversation
// ---------------------------------------------------------------------------

fn build_session(model: &str) -> Value {
    json!({
        "model": if model.is_empty() { "auto".to_string() } else { model.to_string() },
        "x_grok": {
            "keep_context": false,
            "is_temporary": true,
            "enable_image_generation": true,
            "image_generation_count": 1,
            "disable_text_follow_ups": false,
            "supported_fast_tools": { "calculatorTool": "1", "unitConversionTool": "1" },
            "disable_artifact": true,
            "force_concise": false,
            "enable_side_by_side": true,
        },
    })
}

/// `streamGrokConversation` → raw gateway events.
fn stream_grok_conversation(
    ws_url: String,
    base_url: String,
    account: AccountFile,
    model: String,
    prompt: String,
    first_token_timeout: Duration,
    streaming_read_timeout: Duration,
) -> impl Stream<Item = Result<Value, anyhow::Error>> + Send {
    async_stream::stream! {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let url = build_ws_url(&ws_url, &account);
        let mut request = match url.as_str().into_client_request() {
            Ok(r) => r,
            Err(e) => { yield Err(anyhow::anyhow!("Grok WS url error: {e}")); return; }
        };
        for (k, v) in build_headers(&account, &base_url, false) {
            use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(&v),
            ) {
                request.headers_mut().insert(name, value);
            }
        }
        let (mut ws, _) = match tokio_tungstenite::connect_async(request).await {
            Ok(x) => x,
            Err(e) => { yield Err(anyhow::anyhow!("Grok WebSocket connect failed: {e}")); return; }
        };
        if let Err(e) = ws
            .send(tokio_tungstenite::tungstenite::Message::Text(
                serde_json::to_string(&json!({
                    "type": "session.create",
                    "event_id": "evt_init",
                    "session": build_session(&model),
                }))
                .unwrap_or_default()
                .into(),
            ))
            .await
        {
            yield Err(anyhow::anyhow!("Grok WebSocket send failed: {e}"));
            return;
        }
        let mut turn_sent = false;
        let mut saw_first_content = false;
        let mut heartbeat = tokio::time::interval(Duration::from_millis(1500));
        heartbeat.tick().await; // skip immediate
        loop {
            let timeout = if saw_first_content { streaming_read_timeout } else { first_token_timeout };
            let next = tokio::time::timeout(timeout, async {
                tokio::select! {
                    msg = ws.next() => msg,
                    _ = heartbeat.tick() => {
                        let _ = ws
                            .send(tokio_tungstenite::tungstenite::Message::Text(
                                json!({"type":"ping","event_id":format!("evt_hb_{}", crate::pool::now_ms())})
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                        return ws.next().await;
                    }
                }
            })
            .await;
            let msg = match next {
                Ok(Some(Ok(m))) => m,
                Ok(Some(Err(e))) => { yield Err(anyhow::anyhow!("Grok WebSocket error: {e}")); return; }
                Ok(None) => {
                    yield Err(anyhow::anyhow!("Grok WebSocket closed before response completed"));
                    return;
                }
                Err(_) => { yield Err(anyhow::anyhow!("Grok WebSocket timed out")); return; }
            };
            let text = match msg {
                tokio_tungstenite::tungstenite::Message::Text(t) => t.to_string(),
                tokio_tungstenite::tungstenite::Message::Binary(b) => {
                    String::from_utf8_lossy(&b).to_string()
                }
                tokio_tungstenite::tungstenite::Message::Close(_) => {
                    yield Err(anyhow::anyhow!("Grok WebSocket closed before response completed"));
                    return;
                }
                _ => continue,
            };
            let Ok(parsed) = serde_json::from_str::<Value>(&text) else { continue };
            if parsed.get("type").and_then(Value::as_str) == Some("pong") {
                continue;
            }
            if parsed.get("type").and_then(Value::as_str) == Some("session.created") && !turn_sent {
                turn_sent = true;
                let now = crate::pool::now_ms();
                let turn = serde_json::to_string(&json!({
                    "type": "conversation.item.create",
                    "event_id": format!("evt_action_{now}"),
                    "item": {
                        "type": "message",
                        "role": "user",
                        "content": [{"type": "input_text", "text": prompt}],
                        "x_grok": { "client_message_id": uuid::Uuid::new_v4().to_string() },
                    },
                }))
                .unwrap_or_default();
                let _ = ws
                    .send(tokio_tungstenite::tungstenite::Message::Text(turn.into()))
                    .await;
                let _ = ws
                    .send(tokio_tungstenite::tungstenite::Message::Text(
                        json!({"type":"response.create","event_id":format!("evt_resp_{now}")})
                            .to_string()
                            .into(),
                    ))
                    .await;
            }
            if parsed.get("type").and_then(Value::as_str) == Some("response.output_text.delta")
                && parsed.get("delta").and_then(Value::as_str).is_some_and(|d| !d.is_empty())
            {
                saw_first_content = true;
            }
            let is_done = matches!(
                parsed.get("type").and_then(Value::as_str),
                Some("response.done" | "error")
            );
            yield Ok(parsed);
            if is_done {
                return;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// streaming.ts — prompt conversion + event parser
// ---------------------------------------------------------------------------

const IGNORED_MESSAGE_TAGS: &[&str] = &[
    "summary",
    "header",
    "tool_partial_output",
    "tool_usage_card",
];

fn convert_openai_to_grok_prompt(messages: &[Value]) -> String {
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
struct GrokStreamingState {
    response_id: String,
    item_id: String,
    model: String,
    content: String,
    finished: bool,
}

/// `parseGrokGatewayEvent`.
fn parse_grok_gateway_event(
    event: &Value,
    state: &mut GrokStreamingState,
) -> anyhow::Result<(Option<String>, bool)> {
    let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "response.created" => {
            if let Some(id) = event
                .pointer("/response/id")
                .or_else(|| event.get("response_id"))
                .and_then(Value::as_str)
            {
                state.response_id = id.to_string();
            }
            Ok((None, false))
        }
        "response.output_item.added" => {
            if let Some(id) = event.pointer("/item/id").and_then(Value::as_str) {
                state.item_id = id.to_string();
            }
            Ok((None, false))
        }
        "response.output_text.delta" => {
            let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
            if delta.is_empty() || should_ignore_delta(event) {
                return Ok((None, false));
            }
            state.content.push_str(delta);
            Ok((Some(build_openai_chunk(state, delta, None)), false))
        }
        "response.done" => {
            if let Some(id) = event
                .pointer("/response/id")
                .or_else(|| event.get("response_id"))
                .and_then(Value::as_str)
            {
                state.response_id = id.to_string();
            }
            state.finished = true;
            Ok((Some(build_openai_chunk(state, "", Some("stop"))), true))
        }
        "error" => {
            let message = event
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Grok Web returned an error");
            anyhow::bail!("{message}")
        }
        _ => Ok((None, false)),
    }
}

fn should_ignore_delta(event: &Value) -> bool {
    if event
        .pointer("/x_grok/is_thinking")
        .and_then(Value::as_bool)
        == Some(true)
    {
        return true;
    }
    event
        .pointer("/x_grok/message_tag")
        .and_then(Value::as_str)
        .is_some_and(|t| IGNORED_MESSAGE_TAGS.contains(&t))
}

fn build_openai_chunk(state: &GrokStreamingState, content: &str, finish: Option<&str>) -> String {
    let id = if !state.response_id.is_empty() {
        state.response_id.clone()
    } else if !state.item_id.is_empty() {
        state.item_id.clone()
    } else {
        uuid::Uuid::new_v4().to_string()
    };
    let chunk = json!({
        "id": format!("chatcmpl-{id}"),
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

const MODELS_CACHE_TTL_MS: i64 = 30 * 60_000;

struct GrokWebBehavior;
impl crate::pool::PoolBehavior for GrokWebBehavior {
    fn provider_name(&self) -> &'static str {
        "grokWeb"
    }
    fn normalize_model(&self, model: &str) -> String {
        normalize_grokweb_model(model)
    }
    fn account_has_model(&self, _a: &AccountWithState, _m: &str) -> bool {
        true
    }
    fn seed_models(&self) -> Vec<String> {
        GROK_WEB_KNOWN_MODELS
            .iter()
            .map(|s| s.to_string())
            .collect()
    }
}

pub struct GrokWebProvider {
    core: Arc<GrokWebCore>,
    enabled: bool,
    display_name: Option<String>,
}

pub struct GrokWebCore {
    pool: Arc<Mutex<AccountPool<GrokWebBehavior>>>,
    http: Arc<UpstreamHttp>,
    settings: Arc<GrokWebSettings>,
    log: LogSink,
}

impl GrokWebProvider {
    pub fn new(
        provider_config: &crate::types::ProviderConfig,
        account_files: Vec<AccountFile>,
        provider_state: &crate::types::ProviderState,
        log: LogSink,
        on_changed: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
        _persist_account: Option<Arc<dyn Fn(&AccountFile) + Send + Sync>>,
        proxy_url: &str,
    ) -> anyhow::Result<Self> {
        let settings = grokweb_settings(&provider_config.settings);
        let http = UpstreamHttp::new(&settings.base_url, Some(proxy_url))?;
        let mut pool = AccountPool::new(GrokWebBehavior);
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
            core: Arc::new(GrokWebCore {
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

impl GrokWebCore {
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
            provider: Some("grokWeb".into()),
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

    async fn maybe_refresh_models(&self, account_id: &str) {
        {
            let pool = self.pool.lock().await;
            let Some(acc) = pool.find(account_id) else {
                return;
            };
            if acc.state.models_cached_at > 0
                && now_ms() - acc.state.models_cached_at < MODELS_CACHE_TTL_MS
                && !acc.state.model_ids.is_empty()
            {
                return;
            }
        }
        let _ = self.refresh_models(account_id).await;
    }

    async fn refresh_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        let config = {
            let pool = self.pool.lock().await;
            pool.find(account_id).map(|a| a.config.clone())
        };
        let Some(config) = config else {
            anyhow::bail!("Account not found");
        };
        let models = fetch_grok_models(&self.http.client(), &self.settings.base_url, &config)
            .await
            .unwrap_or_default();
        let mut pool = self.pool.lock().await;
        if let Some(acc) = pool.find_mut(account_id) {
            if !models.is_empty() {
                acc.state.model_ids = models.clone();
                acc.state.models_cached_at = now_ms();
            }
            Ok(acc.state.model_ids.clone())
        } else {
            anyhow::bail!("Account not found")
        }
    }

    /// `doRequest` — full prompt → collect text.
    async fn do_request(
        &self,
        account: &AccountWithState,
        model: &str,
        body: &Value,
    ) -> anyhow::Result<String> {
        let prompt = convert_openai_to_grok_prompt(
            body.get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .as_slice(),
        );
        let events = stream_grok_conversation(
            self.settings.ws_url.clone(),
            self.settings.base_url.clone(),
            account.config.clone(),
            model.to_string(),
            prompt,
            self.settings.first_token_timeout,
            self.settings.streaming_read_timeout,
        );
        let mut state = GrokStreamingState {
            model: model.to_string(),
            ..Default::default()
        };
        let mut events = Box::pin(events);
        while let Some(item) = events.next().await {
            let event = item?;
            let _ = parse_grok_gateway_event(&event, &mut state)?;
        }
        if state.content.is_empty() {
            anyhow::bail!("Empty response from GrokWeb");
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
                let prompt = convert_openai_to_grok_prompt(
                    body.get("messages").and_then(Value::as_array).cloned().unwrap_or_default().as_slice(),
                );
                let events = stream_grok_conversation(
                    view.settings.ws_url.clone(),
                    view.settings.base_url.clone(),
                    account.config.clone(),
                    model.clone(),
                    prompt,
                    view.settings.first_token_timeout,
                    view.settings.streaming_read_timeout,
                );
                let mut state = GrokStreamingState { model: model.clone(), ..Default::default() };
                let mut events = Box::pin(events);
                let mut stream_error: Option<String> = None;
                let mut done = false;
                while let Some(item) = events.next().await {
                    match item {
                        Ok(event) => {
                            match parse_grok_gateway_event(&event, &mut state) {
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
                    let classified = classify_grokweb_error(&err);
                    view.pool.lock().await.report_failure(&account.config.id, &err, &classified);
                    excluded.insert(account.config.id.clone());
                    view.log_entry(
                        LogLevel::Warn,
                        format!("GrokWeb stream failed: {err}"),
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
                    "GrokWeb upstream success (stream)",
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
                            provider: Some("grokWeb".into()),
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
impl ProviderAdapter for GrokWebProvider {
    fn name(&self) -> &'static str {
        "grokWeb"
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        let ids = {
            let pool = self.core.pool.lock().await;
            pool.accounts
                .iter()
                .filter(|a| a.config.enabled)
                .map(|a| a.config.id.clone())
                .collect::<Vec<_>>()
        };
        for id in &ids {
            self.core.maybe_refresh_models(id).await;
        }
        let mut models = self.core.pool.lock().await.list_models();
        if models.is_empty() {
            models = GROK_WEB_KNOWN_MODELS
                .iter()
                .map(|s| s.to_string())
                .collect();
        }
        models
            .into_iter()
            .map(|id| ProviderModel {
                id,
                provider: "grokWeb".into(),
                owned_by: Some("xai".into()),
                description: Some("Model via GrokWeb".into()),
            })
            .collect()
    }

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        let model = normalize_grokweb_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(GROK_WEB_DEFAULT_MODEL),
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
        let model = normalize_grokweb_model(
            body.get("model")
                .and_then(Value::as_str)
                .unwrap_or(GROK_WEB_DEFAULT_MODEL),
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
        match fetch_grok_user(
            &self.core.http.client(),
            &self.core.settings.base_url,
            &config,
        )
        .await
        {
            Ok(user) => {
                let _ = self.core.refresh_models(account_id).await;
                let models = self
                    .core
                    .pool
                    .lock()
                    .await
                    .find(account_id)
                    .map(|a| a.state.model_ids.clone())
                    .unwrap_or_default();
                {
                    let mut pool = self.core.pool.lock().await;
                    if let Some(acc) = pool.find_mut(account_id) {
                        acc.state.status = AccountStatus::Available;
                        acc.state.status_updated_at = now_ms();
                    }
                }
                let email = user
                    .get("email")
                    .or_else(|| user.pointer("/user/email"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                AccountTestResult {
                    ok: true,
                    account_id: account_id.into(),
                    message: format!(
                        "GrokWeb account is valid{}",
                        email.map(|e| format!(" ({e})")).unwrap_or_default()
                    ),
                    models,
                    expires_at: None,
                    auth_type: Some("grokweb-cookie".into()),
                }
            }
            Err(e) => {
                let message = e.to_string();
                let classified = classify_grokweb_error(&message);
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
                        acc.state.cooldown_until = (classified.cooldown_ms > 0)
                            .then(|| now_ms() + classified.cooldown_ms as i64);
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
        {
            let pool = self.core.pool.lock().await;
            if pool.find(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
        }
        self.core.maybe_refresh_models(account_id).await;
        let (models, email) = {
            let pool = self.core.pool.lock().await;
            let acc = pool.find(account_id);
            (
                acc.map(|a| {
                    if a.state.model_ids.is_empty() {
                        GROK_WEB_KNOWN_MODELS
                            .iter()
                            .map(|s| s.to_string())
                            .collect()
                    } else {
                        a.state.model_ids.clone()
                    }
                })
                .unwrap_or_default(),
                acc.and_then(|a| a.config.email.clone()),
            )
        };
        Ok(json!({
            "id": account_id,
            "subscription": {"title": "GrokWeb", "type": "web"},
            "email": email,
            "models": models.iter().map(|m| json!({
                "modelId": m, "modelName": m, "rateMultiplier": 1, "rateUnit": "request",
            })).collect::<Vec<_>>(),
        }))
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        {
            let pool = self.core.pool.lock().await;
            if pool.find(account_id).is_none() {
                anyhow::bail!("Account not found");
            }
            if let Some(acc) = self.core.pool.lock().await.find_mut(account_id) {
                acc.state.models_cached_at = 0;
            }
        }
        self.core.refresh_models(account_id).await
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
        let (accounts, models) = self
            .core
            .pool
            .try_lock()
            .map(|p| (p.accounts.len(), p.list_models()))
            .unwrap_or_default();
        ProviderStatus {
            name: "grokWeb".into(),
            provider_type: "grokWeb".into(),
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
                Some("No GrokWeb accounts configured".into())
            },
            models: if models.is_empty() {
                GROK_WEB_KNOWN_MODELS
                    .iter()
                    .map(|s| s.to_string())
                    .collect()
            } else {
                models
            },
            use_proxy: None,
            accounts,
        }
    }
}

impl GrokWebProvider {
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
                        "GrokWeb upstream success",
                        Some(&account),
                        Some(&ctx.request_id),
                        Some((now_ms() - started) as u64),
                        None,
                    );
                    if let Some(sink) = &ctx.on_usage {
                        sink(
                            UsageStats {
                                input_tokens: 0,
                                output_tokens: crate::providers::kiro_convert::estimate_tokens(
                                    &json!(text),
                                ),
                                estimated: Some(true),
                                ..Default::default()
                            },
                            UsageMeta {
                                account_id: Some(account.config.id.clone()),
                                model: Some(model.to_string()),
                                provider: Some("grokWeb".into()),
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
                        "usage": {"prompt_tokens": 0, "completion_tokens": crate::providers::kiro_convert::estimate_tokens(&json!(text)), "total_tokens": 0},
                    }));
                }
                Err(e) => {
                    last_error = e.to_string();
                    let classified = classify_grokweb_error(&last_error);
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
            "GrokWeb request failed: {}",
            if last_error.is_empty() {
                "No available accounts".to_string()
            } else {
                last_error
            }
        )
    }
}

/// `classifyGrokWebError` port.
pub fn classify_grokweb_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |s: &str| msg.contains(s);
    if has("401") || has("unauthorized") || has("not authenticated") {
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

fn grokweb_settings(settings: &JsonMap) -> GrokWebSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    GrokWebSettings {
        base_url: settings
            .get("baseUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(DEFAULT_GROK_WEB_BASE_URL)
            .trim_end_matches('/')
            .to_string(),
        ws_url: settings
            .get("wsUrl")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(DEFAULT_GROK_WEB_WS_URL)
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 30)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 180)),
    }
}
