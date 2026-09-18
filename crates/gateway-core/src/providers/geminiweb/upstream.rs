//! Upstream internals for `geminiweb.rs` — SAPISID auth, /app token, StreamGenerate.

use super::*;

// ---------------------------------------------------------------------------

pub(crate) fn cookie_field(account: &AccountFile) -> String {
    account
        .fields
        .get("cookieHeader")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

pub(crate) fn extract_sapisid(cookie: &str) -> Option<String> {
    regex::Regex::new(r"(?:^|;\s*)SAPISID=([^;]+)")
        .expect("validated invariant")
        .captures(cookie)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

/// `buildSapisidHash` — SAPISIDHASH <ts_ms>_<sha1(ts ms SAPISID origin)>.
pub(crate) fn build_sapisid_hash(sapisid: &str, origin: &str) -> String {
    let ts = now_ms();
    let hash = Sha1::digest(format!("{ts} {sapisid} {origin}").as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    format!("SAPISIDHASH {ts}_{hash}")
}

pub(crate) fn gemini_headers(account: &AccountFile, model_header: &str) -> Vec<(String, String)> {
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
pub(crate) async fn fetch_access_token(
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
        .expect("validated invariant")
        .captures(&html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    let Some(token) = token else {
        anyhow::bail!("Gemini Web session tokens not found (cookie may be invalid or expired)");
    };
    let email = regex::Regex::new(r#""oPEP7c":"(.*?)""#)
        .expect("validated invariant")
        .captures(&html)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()));
    Ok((token, email))
}

/// `rotateSidts` — RotateCookies → new __Secure-1PSIDTS.
pub(crate) async fn rotate_sidts(
    client: &reqwest::Client,
    account: &AccountFile,
) -> Option<String> {
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
        .expect("validated invariant")
        .captures(&set_cookie)
        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
}

/// `patchSidts`.
pub(crate) fn patch_sidts(cookie_header: &str, new_sidts: &str) -> String {
    let re1 = regex::Regex::new(r"__Secure-1PSIDTS=[^;]+").expect("validated invariant");
    let re3 = regex::Regex::new(r"__Secure-3PSIDTS=[^;]+").expect("validated invariant");
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
pub(crate) fn stream_gemini_conversation(
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

pub(crate) fn urlencoded(s: &str) -> String {
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
pub(crate) fn parse_stream_line(line: &str) -> Vec<GeminiStreamEvent> {
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

pub(crate) fn convert_openai_to_gemini_prompt(messages: &[Value]) -> String {
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

pub(crate) fn extract_text(content: &Value) -> String {
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
pub(crate) struct GeminiStreamingState {
    pub(crate) model: String,
    pub(crate) content: String,
    pub(crate) finished: bool,
}

/// `parseGeminiBatchEvent` — cumulative → prefix-delta.
pub(crate) fn parse_gemini_batch_event(
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

pub(crate) fn build_openai_chunk(
    state: &GeminiStreamingState,
    content: &str,
    finish: Option<&str>,
) -> String {
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
