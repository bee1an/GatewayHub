//! Prompt builders for `windsurf.rs` — openai/anthropic → cascade payload.

use super::*;

// ---------------------------------------------------------------------------
// prompt converters (converters.ts)
// ---------------------------------------------------------------------------

pub fn openai_to_windsurf_prompt(body: &Value) -> WindsurfPromptPayload {
    let mut lines: Vec<String> = Vec::new();
    let mut images: Vec<WindsurfImageAttachment> = Vec::new();
    for msg in body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = msg.get("role").and_then(Value::as_str).unwrap_or("");
        let content = msg.get("content").unwrap_or(&Value::Null);
        let text = extract_text(content);
        images.extend(extract_openai_images(content));
        match role {
            "system" | "developer" => {
                if !text.is_empty() {
                    lines.push(format!("System: {text}"));
                }
            }
            "assistant" => {
                if !text.is_empty() {
                    lines.push(format!("Assistant: {text}"));
                }
                for call in msg
                    .get("tool_calls")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default()
                {
                    let name = call
                        .pointer("/function/name")
                        .or_else(|| call.get("name"))
                        .and_then(Value::as_str)
                        .unwrap_or("tool");
                    let args = call
                        .pointer("/function/arguments")
                        .or_else(|| call.get("arguments"))
                        .map(|a| match a {
                            Value::String(s) => s.clone(),
                            other => serde_json::to_string(other).unwrap_or_else(|_| "{}".into()),
                        })
                        .unwrap_or_else(|| "{}".into());
                    lines.push(format!("Assistant tool call {name}: {args}"));
                }
            }
            "tool" => {
                let id = msg
                    .get("tool_call_id")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                lines.push(format!(
                    "Tool result{}: {text}",
                    if id.is_empty() {
                        String::new()
                    } else {
                        format!(" {id}")
                    }
                ));
            }
            _ => {
                if !text.is_empty() {
                    lines.push(format!("User: {text}"));
                }
            }
        }
    }
    append_image_notes(&mut lines, &images);
    WindsurfPromptPayload {
        prompt: lines.join("\n\n"),
        images,
    }
}

pub fn anthropic_to_windsurf_prompt(body: &Value) -> WindsurfPromptPayload {
    let system = match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        other => extract_text(other.unwrap_or(&Value::Null)),
    };
    let mut lines: Vec<String> = if system.is_empty() {
        Vec::new()
    } else {
        vec![format!("System: {system}")]
    };
    let mut images: Vec<WindsurfImageAttachment> = Vec::new();
    for msg in body
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let role = if msg.get("role").and_then(Value::as_str) == Some("assistant") {
            "Assistant"
        } else {
            "User"
        };
        let content = msg.get("content").unwrap_or(&Value::Null);
        let Some(blocks) = content.as_array() else {
            let text = extract_text(content);
            if !text.is_empty() {
                lines.push(format!("{role}: {text}"));
            }
            continue;
        };
        images.extend(extract_anthropic_images(blocks));
        for block in blocks {
            match block.get("type").and_then(Value::as_str) {
                Some("text")
                    if block
                        .get("text")
                        .and_then(Value::as_str)
                        .is_some_and(|t| !t.is_empty()) =>
                {
                    lines.push(format!("{role}: {}", block["text"].as_str().unwrap()));
                }
                Some("tool_use") => {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = serde_json::to_string(block.get("input").unwrap_or(&json!({})))
                        .unwrap_or_else(|_| "{}".into());
                    lines.push(format!("Assistant tool call {name}: {input}"));
                }
                Some("tool_result") => {
                    let text = extract_text(block.get("content").unwrap_or(&Value::Null));
                    let id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    lines.push(format!("Tool result {id}: {text}"));
                }
                _ => {}
            }
        }
    }
    append_image_notes(&mut lines, &images);
    WindsurfPromptPayload {
        prompt: lines.join("\n\n"),
        images,
    }
}

pub(crate) fn extract_openai_images(content: &Value) -> Vec<WindsurfImageAttachment> {
    let mut images = Vec::new();
    for part in content.as_array().cloned().unwrap_or_default() {
        match part.get("type").and_then(Value::as_str) {
            Some("image_url") => {
                let url = match part.get("image_url") {
                    Some(Value::String(s)) => s.clone(),
                    other => other
                        .and_then(|v| v.get("url").cloned())
                        .and_then(|v| v.as_str().map(str::to_string))
                        .unwrap_or_default(),
                };
                let caption = part
                    .get("detail")
                    .or_else(|| part.pointer("/image_url/detail"))
                    .and_then(Value::as_str)
                    .map(str::to_string);
                if let Some((mime, data)) = data_url_to_image(&url) {
                    images.push(WindsurfImageAttachment {
                        mime_type: Some(mime),
                        base64_data: Some(data),
                        caption,
                        source_url: None,
                    });
                } else if !url.is_empty() {
                    images.push(WindsurfImageAttachment {
                        source_url: Some(url),
                        caption,
                        ..Default::default()
                    });
                }
            }
            Some("input_image") | Some("image") => {
                let data = part
                    .get("image_base64")
                    .or_else(|| part.get("data"))
                    .or_else(|| part.get("base64"))
                    .or_else(|| part.get("base64Data"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !data.trim().is_empty() {
                    images.push(WindsurfImageAttachment {
                        base64_data: Some(strip_data_url_prefix(data)),
                        mime_type: part
                            .get("mime_type")
                            .or_else(|| part.get("mimeType"))
                            .and_then(Value::as_str)
                            .unwrap_or("image/png")
                            .to_string()
                            .into(),
                        caption: part
                            .get("detail")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                        ..Default::default()
                    });
                }
            }
            _ => {}
        }
    }
    images
}

pub(crate) fn extract_anthropic_images(blocks: &[Value]) -> Vec<WindsurfImageAttachment> {
    let mut images = Vec::new();
    for block in blocks {
        if block.get("type").and_then(Value::as_str) != Some("image") {
            continue;
        }
        let src = block.get("source").cloned().unwrap_or(json!({}));
        match src.get("type").and_then(Value::as_str) {
            Some("base64") => {
                if let Some(data) = src.get("data").and_then(Value::as_str) {
                    images.push(WindsurfImageAttachment {
                        base64_data: Some(strip_data_url_prefix(data)),
                        mime_type: src
                            .get("media_type")
                            .or_else(|| src.get("mediaType"))
                            .and_then(Value::as_str)
                            .unwrap_or("image/png")
                            .to_string()
                            .into(),
                        ..Default::default()
                    });
                }
            }
            _ => {
                if let Some(url) = src.get("url").and_then(Value::as_str) {
                    images.push(WindsurfImageAttachment {
                        source_url: Some(url.to_string()),
                        ..Default::default()
                    });
                }
            }
        }
    }
    images
}

pub(crate) fn append_image_notes(lines: &mut Vec<String>, images: &[WindsurfImageAttachment]) {
    if images.is_empty() {
        return;
    }
    let native = images.iter().filter(|i| i.base64_data.is_some()).count();
    let url_count = images.len() - native;
    let mut parts = vec![format!("{} image(s) attached", images.len())];
    if native > 0 {
        parts.push(format!("{native} sent as native Cascade image data"));
    }
    if url_count > 0 {
        parts.push(format!("{url_count} URL-only image(s) referenced in text"));
    }
    lines.push(format!("User image context: {}.", parts.join("; ")));
    for (i, image) in images.iter().enumerate() {
        if let Some(url) = &image.source_url {
            lines.push(format!("Image {} URL: {url}", i + 1));
        } else if let Some(caption) = &image.caption {
            lines.push(format!("Image {} caption: {caption}", i + 1));
        }
    }
}

pub(crate) fn data_url_to_image(value: &str) -> Option<(String, String)> {
    let rest = value.strip_prefix("data:")?;
    let (header, data) = rest.split_once(',')?;
    if !header.contains("base64") {
        return None;
    }
    Some((
        header.split(';').next().unwrap_or("image/png").to_string(),
        data.trim().to_string(),
    ))
}

pub(crate) fn strip_data_url_prefix(value: &str) -> String {
    data_url_to_image(value)
        .map(|(_, d)| d)
        .unwrap_or_else(|| value.trim().to_string())
}

/// `classifyWindsurfError` port — quota before auth (the "api key has
/// exceeded its quota" message mentions api keys).
pub fn classify_windsurf_error(raw: &str) -> ClassifiedError {
    let msg = raw.to_lowercase();
    let has = |p: &str| regex::Regex::new(p).unwrap().is_match(&msg);
    if has(r"high demand|try again later|temporarily unavailable|overloaded") {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"quota|usage limit|exceeded") {
        return ClassifiedError {
            kind: ResponseKind::Quota,
            cooldown_ms: 60 * 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"rate limit|429|too many requests") {
        return ClassifiedError {
            kind: ResponseKind::RateLimit,
            cooldown_ms: 60_000,
            reset_at_iso: None,
        };
    }
    if has(r"unauthenticated|invalid api key|missing api key|unauthorized|401|403") {
        return ClassifiedError {
            kind: ResponseKind::Auth,
            cooldown_ms: 0,
            reset_at_iso: None,
        };
    }
    if has(r"timeout") {
        return ClassifiedError {
            kind: ResponseKind::Timeout,
            cooldown_ms: 30_000,
            reset_at_iso: None,
        };
    }
    if has(r"fetch failed|econnrefused|econnreset|enotfound|network") {
        return ClassifiedError {
            kind: ResponseKind::Network,
            cooldown_ms: 15_000,
            reset_at_iso: None,
        };
    }
    ClassifiedError {
        kind: ResponseKind::ServerError,
        cooldown_ms: 30_000,
        reset_at_iso: None,
    }
}

pub(crate) fn windsurf_settings(settings: &JsonMap) -> WindsurfSettings {
    let secs = |k: &str, default: u64| {
        settings
            .get(k)
            .and_then(Value::as_u64)
            .filter(|v| *v > 0)
            .unwrap_or(default)
    };
    WindsurfSettings {
        api_server_url: settings
            .get("apiServerUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_WINDSURF_API_SERVER_URL)
            .to_string(),
        inference_api_server_url: settings
            .get("inferenceApiServerUrl")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_INFERENCE_API_SERVER_URL)
            .to_string(),
        language_server_binary_path: settings
            .get("languageServerBinaryPath")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        codeium_dir: settings
            .get("codeiumDir")
            .and_then(Value::as_str)
            .unwrap_or(".codeium/windsurf")
            .to_string(),
        vpn_proxy_url: settings
            .get("vpnProxyUrl")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        first_token_timeout: Duration::from_secs(secs("firstTokenTimeoutSeconds", 60)),
        streaming_read_timeout: Duration::from_secs(secs("streamingReadTimeoutSeconds", 120)),
        launch_timeout: Duration::from_secs(secs("launchTimeoutSeconds", 20)),
        detect_proxy: settings
            .get("detectProxy")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}
