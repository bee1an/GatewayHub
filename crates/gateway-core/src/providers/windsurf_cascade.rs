//! Windsurf Cascade flow — port of `providers/windsurf/cascade.ts`.
//! GetUserStatus → UpdatePanelState → StartCascade → SendUserCascadeMessage
//! → poll GetCascadeTrajectory until plannerResponse / IDLE.

use std::sync::Arc;
use std::time::Duration;

use futures::Stream;
use serde_json::{Value, json};

use crate::pool::now_ms;
use crate::providers::kiro_convert::estimate_tokens;
use crate::providers::windsurf_connect::WindsurfLanguageServerClient;
use crate::providers::windsurf_stream::{
    GatewayToolCall, dedupe_tool_calls, normalize_gateway_tool_calls, split_inline_tool_calls,
};
use crate::types::UsageStats;

const SOURCE: &str = "CORTEX_TRAJECTORY_SOURCE_CASCADE_CLIENT";
const TRAJECTORY_TYPE: &str = "CORTEX_TRAJECTORY_TYPE_USER_MAINLINE";
const IDLE_STATUS: &str = "CASCADE_RUN_STATUS_IDLE";

#[derive(Debug, Clone, Default)]
pub struct WindsurfImageAttachment {
    pub mime_type: Option<String>,
    pub base64_data: Option<String>,
    pub caption: Option<String>,
    pub source_url: Option<String>,
}

#[derive(Debug, Clone)]
pub struct WindsurfPromptPayload {
    pub prompt: String,
    pub images: Vec<WindsurfImageAttachment>,
}

#[derive(Debug, Clone)]
pub struct WindsurfCascadeResult {
    pub cascade_id: String,
    pub text: String,
    pub usage: UsageStats,
    pub tool_calls: Vec<GatewayToolCall>,
    pub workspace_edits: Vec<Value>,
}

#[derive(Debug, Clone)]
pub struct WindsurfCascadeStreamEvent {
    pub cascade_id: String,
    pub text: String,
    pub text_delta: Option<String>,
    pub usage: Option<UsageStats>,
    pub tool_calls: Vec<GatewayToolCall>,
    pub workspace_edits: Vec<Value>,
    pub done: bool,
}

#[derive(Clone, Copy)]
pub struct WindsurfSettingsView {
    pub launch_timeout: Duration,
    pub first_token_timeout: Duration,
    pub streaming_read_timeout: Duration,
}

pub async fn run_windsurf_cascade(
    client: &Arc<WindsurfLanguageServerClient>,
    payload: &WindsurfPromptPayload,
    model: &str,
    settings: WindsurfSettingsView,
) -> anyhow::Result<WindsurfCascadeResult> {
    let ctx = start_cascade_and_send(client, payload, model, settings, true).await?;
    wait_for_cascade_result(client, &ctx.0, &ctx.1, ctx.2).await
}

/// `runWindsurfCascadeStream` — polling-driven text deltas.
pub fn run_windsurf_cascade_stream(
    client: Arc<WindsurfLanguageServerClient>,
    payload: WindsurfPromptPayload,
    model: String,
    settings: WindsurfSettingsView,
) -> impl Stream<Item = Result<WindsurfCascadeStreamEvent, anyhow::Error>> + Send {
    async_stream::stream! {
        let ctx = match start_cascade_and_send(&client, &payload, &model, settings, false).await {
            Ok(c) => c,
            Err(e) => { yield Err(e); return; }
        };
        let (cascade_id, prompt, request_timeout_ms) = ctx;
        let deadline = now_ms() + request_timeout_ms;
        let mut emitted_text = String::new();
        let mut last_result: Option<(String, UsageStats, Vec<GatewayToolCall>, Vec<Value>)> = None;

        while now_ms() < deadline {
            let remaining = (deadline - now_ms()).clamp(1_000, 30_000) as u64;
            let response = match client
                .unary(
                    "GetCascadeTrajectory",
                    json!({ "cascadeId": cascade_id }),
                    Duration::from_millis(remaining),
                )
                .await
            {
                Ok(r) => r,
                Err(e) => { yield Err(e); return; }
            };
            if let Some(result) = extract_cascade_result(&response, &prompt) {
                let (text, usage, tool_calls, workspace_edits) =
                    with_captured_edits(result, &client, &cascade_id).await;
                last_result = Some((text.clone(), usage.clone(), tool_calls.clone(), workspace_edits.clone()));
                let delta = next_append_only_delta(&emitted_text, &text);
                if !delta.is_empty() {
                    emitted_text.push_str(&delta);
                    yield Ok(WindsurfCascadeStreamEvent {
                        cascade_id: cascade_id.clone(),
                        text: emitted_text.clone(),
                        text_delta: Some(delta),
                        usage: Some(usage.clone()),
                        tool_calls: tool_calls.clone(),
                        workspace_edits: workspace_edits.clone(),
                        done: false,
                    });
                }
                if is_cascade_idle(&response) {
                    yield Ok(WindsurfCascadeStreamEvent {
                        cascade_id: cascade_id.clone(),
                        text,
                        text_delta: None,
                        usage: Some(usage),
                        tool_calls,
                        workspace_edits,
                        done: true,
                    });
                    return;
                }
            }
            if let Some(err) = extract_cascade_error(&response) {
                yield Err(anyhow::anyhow!("Windsurf Cascade error: {err}"));
                return;
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        if let Some((text, usage, tool_calls, workspace_edits)) = last_result {
            yield Ok(WindsurfCascadeStreamEvent {
                cascade_id,
                text,
                text_delta: None,
                usage: Some(usage),
                tool_calls,
                workspace_edits,
                done: true,
            });
            return;
        }
        yield Err(anyhow::anyhow!("Windsurf Cascade produced no planner response"));
    }
}

/// `getWindsurfUserModels` — GetUserStatus + UpdatePanelState + model ids.
pub async fn get_windsurf_user_models(
    client: &Arc<WindsurfLanguageServerClient>,
    launch_timeout: Duration,
) -> anyhow::Result<Vec<String>> {
    let timeout = launch_timeout.max(Duration::from_secs(20));
    let response = client
        .unary(
            "GetUserStatus",
            json!({ "metadata": client.metadata() }),
            timeout,
        )
        .await?;
    if let Some(us) = response.get("userStatus") {
        let _ = client
            .unary(
                "UpdatePanelStateWithUserStatus",
                json!({ "metadata": client.metadata(), "userStatus": us }),
                timeout,
            )
            .await;
    }
    Ok(extract_windsurf_model_ids(&response))
}

/// `extractWindsurfModelIds` — usable clientModelConfigs (not disabled/BYOK).
pub fn extract_windsurf_model_ids(response: &Value) -> Vec<String> {
    let mut configs: Vec<&Value> = Vec::new();
    for path in [
        "/userStatus/cascadeModelConfigData/clientModelConfigs",
        "/planInfo/cascadeModelConfigData/clientModelConfigs",
    ] {
        if let Some(arr) = response.pointer(path).and_then(Value::as_array) {
            configs.extend(arr.iter());
        }
    }
    let mut out: Vec<String> = configs
        .iter()
        .filter(|item| {
            item.get("disabled").and_then(Value::as_bool) != Some(true)
                && item.get("pricingType").and_then(Value::as_str)
                    != Some("MODEL_PRICING_TYPE_BYOK")
        })
        .filter_map(|item| {
            item.get("modelUid")
                .or_else(|| item.pointer("/modelInfo/modelUid"))
                .or_else(|| item.get("label"))
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// `extractWindsurfCascadeResult` — last plannerResponse step →
/// text + inline/structured tool calls + usage + workspace edits.
pub fn extract_cascade_result(
    trajectory_response: &Value,
    prompt: &str,
) -> Option<(String, UsageStats, Vec<GatewayToolCall>, Vec<Value>)> {
    let trajectory = trajectory_response
        .get("trajectory")
        .unwrap_or(trajectory_response);
    let steps = trajectory.get("steps").and_then(Value::as_array)?;
    let mut planner_step: Option<&Value> = None;
    for step in steps {
        if step.get("plannerResponse").is_some()
            || step.get("type").and_then(Value::as_str) == Some("CORTEX_STEP_TYPE_PLANNER_RESPONSE")
        {
            planner_step = Some(step);
        }
    }
    let planner_step = planner_step?;
    let response = planner_step
        .pointer("/plannerResponse/modifiedResponse")
        .or_else(|| planner_step.pointer("/plannerResponse/response"))
        .and_then(Value::as_str)?;
    let inline = split_inline_tool_calls(response);
    let mut tool_calls = extract_structured_tool_calls(planner_step);
    tool_calls.extend(inline.1);
    let tool_calls = dedupe_tool_calls(tool_calls);
    let workspace_edits = extract_workspace_edits(trajectory_response);
    let usage = usage_from_trajectory(trajectory, planner_step, prompt, &inline.0);
    Some((inline.0, usage, tool_calls, workspace_edits))
}

pub fn extract_cascade_error(trajectory_response: &Value) -> Option<String> {
    let trajectory = trajectory_response
        .get("trajectory")
        .unwrap_or(trajectory_response);
    let steps = trajectory.get("steps").and_then(Value::as_array)?;
    for step in steps {
        if let Some(msg) = pick_error_message(step.get("error").unwrap_or(&Value::Null), 0)
            .or_else(|| pick_error_message(step.get("errorMessage").unwrap_or(&Value::Null), 0))
        {
            return Some(msg);
        }
        if step
            .get("type")
            .and_then(Value::as_str)
            .is_some_and(|t| t.contains("ERROR"))
        {
            return Some("cascade step failed".into());
        }
    }
    None
}

fn build_cascade_config(model: &str) -> Value {
    json!({ "plannerConfig": { "conversational": {}, "requestedModelUid": model } })
}

async fn start_cascade_and_send(
    client: &Arc<WindsurfLanguageServerClient>,
    payload: &WindsurfPromptPayload,
    model: &str,
    settings: WindsurfSettingsView,
    blocking: bool,
) -> anyhow::Result<(String, String, i64)> {
    let prompt = payload.prompt.trim().to_string();
    if prompt.is_empty() {
        anyhow::bail!("Windsurf request prompt is empty");
    }
    let short_timeout = settings.launch_timeout.max(Duration::from_secs(20));
    let request_timeout_ms =
        (settings.first_token_timeout + settings.streaming_read_timeout).as_millis() as i64;

    let status = client
        .unary(
            "GetUserStatus",
            json!({ "metadata": client.metadata() }),
            short_timeout,
        )
        .await?;
    if status.get("userStatus").is_none() {
        anyhow::bail!("Windsurf GetUserStatus did not return userStatus");
    }
    client
        .unary(
            "UpdatePanelStateWithUserStatus",
            json!({ "metadata": client.metadata(), "userStatus": status["userStatus"] }),
            short_timeout,
        )
        .await?;
    let started = client
        .unary(
            "StartCascade",
            json!({
                "metadata": client.metadata(),
                "source": SOURCE,
                "trajectoryType": TRAJECTORY_TYPE,
            }),
            short_timeout,
        )
        .await?;
    let cascade_id = started
        .get("cascadeId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow::anyhow!("Windsurf StartCascade did not return cascadeId"))?
        .to_string();

    send_user_cascade_message(
        client,
        &cascade_id,
        payload,
        model,
        blocking,
        request_timeout_ms,
    )
    .await?;
    Ok((cascade_id, prompt, request_timeout_ms))
}

async fn send_user_cascade_message(
    client: &Arc<WindsurfLanguageServerClient>,
    cascade_id: &str,
    payload: &WindsurfPromptPayload,
    model: &str,
    blocking: bool,
    timeout_ms: i64,
) -> anyhow::Result<()> {
    let images = to_cascade_images(&payload.images);
    let body = |include_images: bool| {
        let mut b = json!({
            "metadata": client.metadata(),
            "cascadeId": cascade_id,
            "items": [{"text": payload.prompt.trim()}],
            "cascadeConfig": build_cascade_config(model),
            "blocking": blocking,
        });
        if include_images && !images.is_empty() {
            b["images"] = Value::Array(images.clone());
        }
        b
    };
    match client
        .unary(
            "SendUserCascadeMessage",
            body(true),
            Duration::from_millis(timeout_ms as u64),
        )
        .await
    {
        Ok(_) => Ok(()),
        Err(e) => {
            if images.is_empty() || !should_retry_without_native_images(&e.to_string()) {
                return Err(e);
            }
            client
                .unary(
                    "SendUserCascadeMessage",
                    body(false),
                    Duration::from_millis(timeout_ms as u64),
                )
                .await?;
            Ok(())
        }
    }
}

pub fn to_cascade_images(images: &[WindsurfImageAttachment]) -> Vec<Value> {
    images
        .iter()
        .filter(|i| {
            i.base64_data
                .as_deref()
                .is_some_and(|d| !d.trim().is_empty())
        })
        .map(|i| {
            let mut v = json!({
                "base64Data": i.base64_data.as_deref().unwrap().trim(),
                "mimeType": i.mime_type.as_deref().unwrap_or("image/png"),
            });
            if let Some(c) = &i.caption {
                v["caption"] = json!(c);
            }
            v
        })
        .collect()
}

async fn wait_for_cascade_result(
    client: &Arc<WindsurfLanguageServerClient>,
    cascade_id: &str,
    prompt: &str,
    timeout_ms: i64,
) -> anyhow::Result<WindsurfCascadeResult> {
    let deadline = now_ms() + timeout_ms;
    while now_ms() < deadline {
        let remaining = (deadline - now_ms()).clamp(1_000, 30_000) as u64;
        let response = client
            .unary(
                "GetCascadeTrajectory",
                json!({ "cascadeId": cascade_id }),
                Duration::from_millis(remaining),
            )
            .await?;
        if let Some(result) = extract_cascade_result(&response, prompt) {
            let (text, usage, tool_calls, workspace_edits) =
                with_captured_edits(result, client, cascade_id).await;
            return Ok(WindsurfCascadeResult {
                cascade_id: cascade_id.to_string(),
                text,
                usage,
                tool_calls,
                workspace_edits,
            });
        }
        if let Some(err) = extract_cascade_error(&response) {
            anyhow::bail!("Windsurf Cascade error: {err}");
        }
        if is_cascade_idle(&response) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1_000)).await;
    }
    anyhow::bail!("Windsurf Cascade produced no planner response");
}

fn usage_from_trajectory(
    trajectory: &Value,
    step: &Value,
    prompt: &str,
    response: &str,
) -> UsageStats {
    let metadata = step.get("metadata").cloned().unwrap_or(Value::Null);
    let model_usage = metadata
        .get("modelUsage")
        .or_else(|| trajectory.pointer("/generatorMetadata/0/modelUsage"))
        .or_else(|| {
            trajectory
                .get("generatorMetadata")
                .and_then(Value::as_array)
                .and_then(|a| a.last())
                .and_then(|m| m.get("modelUsage"))
        })
        .cloned()
        .unwrap_or(Value::Null);
    let numeric = |v: &Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            .filter(|n| n.is_finite())
            .map(|n| n.max(0.0).round() as u64)
    };
    let cache_write = numeric(metadata.get("cacheWriteTokens").unwrap_or(&Value::Null))
        .or_else(|| numeric(model_usage.get("cacheWriteTokens").unwrap_or(&Value::Null)))
        .or_else(|| {
            numeric(
                model_usage
                    .get("cacheWriteInputTokens")
                    .unwrap_or(&Value::Null),
            )
        });
    UsageStats {
        input_tokens: numeric(metadata.get("inputTokens").unwrap_or(&Value::Null))
            .or_else(|| numeric(model_usage.get("inputTokens").unwrap_or(&Value::Null)))
            .unwrap_or_else(|| estimate_tokens(&json!(prompt))),
        output_tokens: numeric(metadata.get("outputTokens").unwrap_or(&Value::Null))
            .or_else(|| numeric(model_usage.get("outputTokens").unwrap_or(&Value::Null)))
            .unwrap_or_else(|| estimate_tokens(&json!(response))),
        cache_read_tokens: numeric(metadata.get("cacheReadTokens").unwrap_or(&Value::Null))
            .or_else(|| numeric(model_usage.get("cacheReadTokens").unwrap_or(&Value::Null))),
        cache_write5m_tokens: cache_write,
        estimated: Some(
            numeric(metadata.get("outputTokens").unwrap_or(&Value::Null)).is_none()
                && numeric(model_usage.get("outputTokens").unwrap_or(&Value::Null)).is_none(),
        ),
        ..Default::default()
    }
}

fn extract_structured_tool_calls(step: &Value) -> Vec<GatewayToolCall> {
    let planner = step.get("plannerResponse").cloned().unwrap_or(Value::Null);
    let metadata = step.get("metadata").cloned().unwrap_or(Value::Null);
    let mut values: Vec<Value> = Vec::new();
    for key in ["toolCalls", "tool_calls"] {
        if let Some(arr) = planner.get(key).and_then(Value::as_array) {
            values.extend(arr.iter().cloned());
        }
    }
    for key in ["toolCall", "tool_call"] {
        if let Some(v) = metadata.get(key) {
            values.push(v.clone());
        }
    }
    for key in ["toolCallChoices", "tool_call_choices"] {
        if let Some(arr) = metadata.get(key).and_then(Value::as_array) {
            values.extend(arr.iter().cloned());
        }
    }
    normalize_gateway_tool_calls(values)
}

fn extract_workspace_edits(response: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for edit in [
        response.get("workspaceEdits"),
        response.get("workspace_edits"),
        response.pointer("/trajectory/workspaceEdits"),
        response.pointer("/trajectory/workspace_edits"),
    ]
    .into_iter()
    .flatten()
    .flat_map(|v| v.as_array().cloned().unwrap_or_default())
    {
        if !edit.is_object() {
            continue;
        }
        let normalized = json!({
            "repoRoot": edit.get("repoRoot").or_else(|| edit.get("repo_root")).and_then(Value::as_str),
            "numAdditions": edit.get("numAdditions").or_else(|| edit.get("num_additions")).and_then(Value::as_u64),
            "numDeletions": edit.get("numDeletions").or_else(|| edit.get("num_deletions")).and_then(Value::as_u64),
            "edits": edit.get("edits"),
        });
        if normalized.get("repoRoot").and_then(Value::as_str).is_some()
            || normalized
                .get("numAdditions")
                .and_then(Value::as_u64)
                .is_some()
            || normalized
                .get("numDeletions")
                .and_then(Value::as_u64)
                .is_some()
            || normalized
                .get("edits")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())
        {
            out.push(normalized);
        }
    }
    out
}

/// `withCapturedEdits` — merge captured WriteCascadeEdit callbacks.
async fn with_captured_edits(
    result: (String, UsageStats, Vec<GatewayToolCall>, Vec<Value>),
    client: &Arc<WindsurfLanguageServerClient>,
    cascade_id: &str,
) -> (String, UsageStats, Vec<GatewayToolCall>, Vec<Value>) {
    let captured = client.get_captured_cascade_edits(Some(cascade_id)).await;
    if captured.is_empty() {
        return result;
    }
    // group by repo root (gitWorktreePath or file:// dir)
    let mut grouped: Vec<(
        String,
        Vec<&crate::providers::windsurf_connect::CapturedCascadeEdit>,
    )> = Vec::new();
    for edit in &captured {
        let key = edit
            .git_worktree_path
            .clone()
            .or_else(|| file_uri_to_directory(edit.uri.as_deref()))
            .unwrap_or_else(|| "(unknown workspace)".into());
        if let Some(g) = grouped.iter_mut().find(|(k, _)| *k == key) {
            g.1.push(edit);
        } else {
            grouped.push((key, vec![edit]));
        }
    }
    let mut edits = result.3;
    for (root, group) in grouped {
        let additions: u64 = group
            .iter()
            .map(|e| {
                e.target_content
                    .as_deref()
                    .map(|c| c.split(&['\r', '\n'][..]).count() as u64)
                    .unwrap_or(0)
            })
            .sum();
        edits.push(json!({
            "repoRoot": root,
            "numAdditions": additions,
            "numDeletions": 0,
            "captured": true,
            "edits": group.iter().map(|e| json!({
                "uri": e.uri,
                "targetContent": e.target_content,
                "cascadeId": e.cascade_id,
                "gitWorktreePath": e.git_worktree_path,
                "receivedAt": e.received_at,
            })).collect::<Vec<_>>(),
        }));
    }
    (result.0, result.1, result.2, edits)
}

fn file_uri_to_directory(uri: Option<&str>) -> Option<String> {
    let uri = uri?.strip_prefix("file://")?;
    let path = uri.rsplit_once('/')?.0;
    if path.is_empty() {
        Some("/".into())
    } else {
        Some(path.to_string())
    }
}

fn is_cascade_idle(response: &Value) -> bool {
    for path in [
        "/status",
        "/runStatus",
        "/run_status",
        "/trajectory/status",
        "/trajectory/runStatus",
        "/trajectory/run_status",
    ] {
        if let Some(s) = response.pointer(path).and_then(Value::as_str) {
            return s == IDLE_STATUS || s.ends_with("_IDLE");
        }
    }
    false
}

fn next_append_only_delta(previous: &str, next: &str) -> String {
    if previous.is_empty() {
        return next.to_string();
    }
    if let Some(rest) = next.strip_prefix(previous) {
        return rest.to_string();
    }
    String::new()
}

fn should_retry_without_native_images(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("image")
        || m.contains("unknown field")
        || m.contains("invalid json")
        || m.contains("cannot parse")
        || m.contains("unsupported")
        || m.contains("http 400")
}

fn pick_error_message(value: &Value, depth: usize) -> Option<String> {
    if let Some(s) = value.as_str() {
        let t = s.trim();
        return if t.is_empty() {
            None
        } else {
            Some(t.chars().take(500).collect())
        };
    }
    if !value.is_object() || depth > 4 {
        return None;
    }
    for key in ["userErrorMessage", "message", "shortError", "description"] {
        if let Some(m) = pick_error_message(value.get(key).unwrap_or(&Value::Null), depth + 1) {
            return Some(m);
        }
    }
    value
        .as_object()?
        .values()
        .find_map(|v| pick_error_message(v, depth + 1))
}
