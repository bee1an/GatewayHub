//! Trae local bridge — port of `providers/trae/localBridge.ts`. Launches
//! Trae.app with `--remote-debugging-port`, finds the workbench page over
//! the CDP HTTP endpoints, then evaluates an injected JS routine that
//! drives `vscode.ahaIpc.connect('ai-agent')` and returns collected
//! stream events.

use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

use crate::providers::trae_auth::{DEFAULT_TRAE_LOCAL_APP_PATH, normalize_trae_model};
use crate::types::UsageStats;

const TRAE_PROJECT_ID: &str = "GatewayHub";
const TRAE_WORKSPACE: &str = "/Users/bee/j/GatewayHub";

pub struct TraeLocalChatResult {
    pub text: String,
    pub usage: Option<UsageStats>,
    pub actual_model: String,
}

/// `toTraeLocalChatModel` — the local agent path maps the free model to
/// the `_premium` variant.
fn to_trae_local_chat_model(model: &str) -> String {
    let normalized = normalize_trae_model(model);
    if normalized == "gemini_2.5_flash" {
        return "gemini_2.5_flash_premium".into();
    }
    normalized
}

pub async fn run_trae_local_chat(
    http: &reqwest::Client,
    local_debug_port: u16,
    local_app_path: &str,
    account_email: &str,
    account_user_id: &str,
    account_country_code: &str,
    token: &str,
    model: &str,
    prompt: String,
    streaming_read_timeout: Duration,
) -> anyhow::Result<TraeLocalChatResult> {
    ensure_trae_debug_port(http, local_app_path, local_debug_port).await?;

    let actual_model = to_trae_local_chat_model(model);
    let params = json!({
        "connectSessionId": uuid::Uuid::new_v4().to_string(),
        "projectId": TRAE_PROJECT_ID,
        "workspaceFolder": TRAE_WORKSPACE,
        "model": actual_model,
        "prompt": prompt,
        "account": {
            "email": account_email,
            "token": token,
            "userId": account_user_id,
            "countryCode": if account_country_code.is_empty() { "US" } else { account_country_code },
        },
    });
    let expression = format!(
        "({})({})",
        INJECTED_TRAE_CHAT,
        serde_json::to_string(&params)?
    );
    let evaluated = evaluate_in_trae(
        http,
        local_debug_port,
        &expression,
        streaming_read_timeout.max(Duration::from_secs(90)),
    )
    .await?;

    if !evaluated.is_object() {
        anyhow::bail!("Trae local bridge returned an empty result");
    }
    if let Some(err) = evaluated.get("error").and_then(Value::as_str)
        && !err.is_empty()
    {
        anyhow::bail!("Trae local bridge failed: {err}");
    }
    let events = evaluated
        .get("events")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let text = extract_trae_local_chat_text(&events);
    if text.trim().is_empty() {
        let last_error = events
            .iter()
            .filter_map(|e| e.get("message").and_then(Value::as_str))
            .last()
            .unwrap_or("");
        anyhow::bail!(
            "Trae local bridge produced no text{}",
            if last_error.is_empty() {
                String::new()
            } else {
                format!(": {last_error}")
            }
        );
    }
    Ok(TraeLocalChatResult {
        text: text.trim().to_string(),
        usage: extract_trae_local_usage(&events),
        actual_model,
    })
}

/// `extractTraeLocalChatText`.
fn extract_trae_local_chat_text(events: &[Value]) -> String {
    let mut fallback = String::new();
    for event in events {
        let Some(payload) = event.get("payload").filter(|p| p.is_object()) else {
            continue;
        };
        if event.get("event").and_then(Value::as_str) == Some("text_message") {
            for key in ["text", "content", "response", "delta"] {
                if let Some(t) = payload
                    .get(key)
                    .and_then(Value::as_str)
                    .filter(|s| !s.trim().is_empty())
                {
                    fallback.push_str(t);
                    break;
                }
            }
        }
        if event.get("event").and_then(Value::as_str) == Some("plan_item") {
            let tool = payload
                .get("tool_call_info")
                .cloned()
                .unwrap_or(Value::Null);
            if tool.get("name").and_then(Value::as_str) == Some("finish") {
                for source in [
                    tool.get("params").cloned(),
                    tool.pointer("/result/data").cloned(),
                ]
                .into_iter()
                .flatten()
                {
                    for key in ["summary", "response", "content"] {
                        if let Some(s) = source
                            .get(key)
                            .and_then(Value::as_str)
                            .filter(|s| !s.is_empty())
                        {
                            return s.to_string();
                        }
                    }
                }
            }
            if let Some(thought) = payload.get("thought").and_then(Value::as_str)
                && !thought.trim().is_empty()
            {
                fallback = thought.to_string();
            }
        }
    }
    fallback
}

/// `extractTraeLocalUsage`.
fn extract_trae_local_usage(events: &[Value]) -> Option<UsageStats> {
    let token_usage = events
        .iter()
        .filter(|e| e.get("event").and_then(Value::as_str) == Some("token_usage"))
        .filter_map(|e| e.get("payload"))
        .last()?;
    let num = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| token_usage.get(*k).and_then(Value::as_f64))
            .next()
            .unwrap_or(0.0) as u64
    };
    Some(UsageStats {
        input_tokens: num(&["prompt_tokens", "input_tokens"]),
        output_tokens: num(&["completion_tokens", "output_tokens"]),
        cache_read_tokens: token_usage
            .get("cache_read_input_tokens")
            .and_then(Value::as_f64)
            .map(|n| n as u64),
        cache_write5m_tokens: token_usage
            .get("cache_creation_input_tokens")
            .and_then(Value::as_f64)
            .map(|n| n as u64),
        estimated: Some(false),
        ..Default::default()
    })
}

async fn ensure_trae_debug_port(
    http: &reqwest::Client,
    local_app_path: &str,
    port: u16,
) -> anyhow::Result<()> {
    if can_read_debug_port(http, port).await {
        return Ok(());
    }
    let app_path = if local_app_path.is_empty() {
        DEFAULT_TRAE_LOCAL_APP_PATH
    } else {
        local_app_path
    };
    if !std::path::Path::new(app_path).exists() {
        anyhow::bail!("Trae app not found at {app_path}; set providers.trae.settings.localAppPath");
    }
    tokio::process::Command::new("open")
        .args([
            "-na",
            app_path,
            "--args",
            &format!("--remote-debugging-port={port}"),
            TRAE_WORKSPACE,
        ])
        .output()
        .await
        .map_err(|e| anyhow::anyhow!("Failed to launch Trae with remote debugging: {e}"))?;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        if can_read_debug_port(http, port).await {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    anyhow::bail!("Trae remote debugging port {port} is not reachable")
}

async fn can_read_debug_port(http: &reqwest::Client, port: u16) -> bool {
    http.get(format!("http://127.0.0.1:{port}/json/version"))
        .timeout(Duration::from_secs(1))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// `evaluateInTrae` — find the workbench CDP target, open a WebSocket and
/// run Runtime.evaluate with awaitPromise.
async fn evaluate_in_trae(
    http: &reqwest::Client,
    port: u16,
    expression: &str,
    timeout: Duration,
) -> anyhow::Result<Value> {
    let targets: Vec<Value> = http
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .timeout(Duration::from_secs(2))
        .send()
        .await?
        .json()
        .await?;
    let page = targets.iter().find(|t| {
        t.get("type").and_then(Value::as_str) == Some("page")
            && t.get("webSocketDebuggerUrl")
                .and_then(Value::as_str)
                .is_some()
            && (t
                .get("url")
                .and_then(Value::as_str)
                .is_some_and(|u| u.contains("/workbench.html"))
                || t.get("title").and_then(Value::as_str).is_some())
    });
    let ws_url = page
        .and_then(|p| p.get("webSocketDebuggerUrl"))
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow::anyhow!("No debuggable Trae workbench page found on port {port}"))?;

    let (ws, _) = tokio_tungstenite::connect_async(ws_url).await?;
    let (mut write, mut read) = ws.split();
    let request = json!({
        "id": 1,
        "method": "Runtime.evaluate",
        "params": {
            "expression": expression,
            "returnByValue": true,
            "awaitPromise": true,
            "timeout": timeout.as_millis() as u64,
        },
    });
    write
        .send(Message::Text(serde_json::to_string(&request)?.into()))
        .await?;

    let deadline = std::time::Instant::now() + timeout + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        let msg = match tokio::time::timeout(
            deadline.saturating_duration_since(std::time::Instant::now()),
            read.next(),
        )
        .await
        {
            Ok(Some(Ok(m))) => m,
            _ => anyhow::bail!("CDP websocket closed or timed out"),
        };
        let Message::Text(text) = msg else { continue };
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if parsed.get("id").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        if parsed.pointer("/result/exceptionDetails").is_some() {
            anyhow::bail!(
                "{}",
                serde_json::to_string(&parsed["result"]["exceptionDetails"]).unwrap_or_default()
            );
        }
        return Ok(parsed
            .pointer("/result/result/value")
            .cloned()
            .unwrap_or(Value::Null));
    }
    anyhow::bail!("Trae CDP evaluate timed out")
}

/// `injectedTraeChat` — the JS routine injected into the workbench page.
/// Kept verbatim from the TS implementation.
const INJECTED_TRAE_CHAT: &str = r#"async function(params) {
  const makeUuid = () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const rand = (Math.random() * 16) | 0
      return (char === 'x' ? rand : (rand & 3) | 8).toString(16)
    })
  const makeObjectId = () =>
    Array.from({ length: 24 }, () => Math.floor(Math.random() * 16).toString(16)).join('')

  const commandResult = (commandId, args) => {
    if (commandId === 'icube.event.getABTestConfigByKey') {
      try {
        const parsed = JSON.parse(args?.[0] || '{}')
        return parsed.defaultValue ?? null
      } catch {
        return null
      }
    }
    if (commandId === 'icube.common.commands.tooling.getSandboxCliPath') return ''
    if (commandId === 'icube.common.commands.getAppPrivacyMode') return false
    if (commandId === 'icube.ai.agent.sql.log.enable') return false
    if (commandId === 'icube.cloudide.aiSessionID') return params.connectSessionId
    return null
  }

  const makeEnvelope = (service, method, data, chatSessionId = '') => ({
    service,
    method,
    data,
    user_info: {
      name: params.account.email || '',
      token: params.account.token || '',
      region: params.account.countryCode || 'US',
      is_internal: false,
      user_id: params.account.userId || '',
      scope: ''
    },
    common_params: { agent_type: data?.agent_type || '', shell_execute_strategy: '' },
    streamlined_common_params: { agent_type: data?.agent_type || '', shell_execute_strategy: '' },
    client_info: {
      connect_session_id: params.connectSessionId,
      project_id: params.projectId,
      chat_session_id: chatSessionId,
      version_code: 20260509,
      workspace_folder: params.workspaceFolder,
      icube_language: 'zh-CN',
      device_id: '0',
      workspace_id: params.projectId,
      workspace_folders: [params.workspaceFolder],
      user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      agent_task_service_strategy: 'cloud_agent',
      enable_llm_utils_cloud: false,
      is_evaluation: false,
      is_worktree: false,
      is_workspace_folder_changed: false,
      enable_browser_tools: false,
      authorized_services: ''
    }
  })

  return new Promise((resolve) => {
    const result = { events: [], commands: [], error: '', streamId: '' }
    const vscode = globalThis.vscode
    if (!vscode?.ahaIpc?.connect) {
      resolve({ error: 'window.vscode.ahaIpc is not available' })
      return
    }

    let client
    const pending = {}
    let nextId = 1
    const sendRequest = (method, packet, timeoutMs) =>
      new Promise((requestResolve, requestReject) => {
        const id = String(nextId++)
        pending[id] = requestResolve
        client.send(JSON.stringify({ jsonrpc: '2.0', method, params: [packet], id }))
        setTimeout(() => {
          if (pending[id]) {
            delete pending[id]
            requestReject(new Error(`${method} timeout`))
          }
        }, timeoutMs)
      })

    const onMessage = (rawInput) => {
      try {
        const raw = typeof rawInput === 'string' ? rawInput : JSON.stringify(rawInput)
        const message = JSON.parse(raw)
        if (message.method === 'execute_command') {
          const packet = Array.isArray(message.params) ? message.params[0] : message.params
          const command = packet?.params || {}
          result.commands.push(command.command_id)
          client.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                results: commandResult(command.command_id, command.args),
                base_resp: { status_message: 'ok', status_code: 0, extra: null }
              }
            })
          )
          return
        }
        if (message.id && pending[message.id]) {
          pending[message.id](message)
          delete pending[message.id]
          return
        }
        if (result.streamId && message.method === `rpc.stream.${result.streamId}`) {
          const inner = message.params?.data?.params
          const event = inner?.data?.event
          const payload = inner?.data?.payload
          result.events.push({ event, payload, code: inner?.code, message: inner?.message })
        }
      } catch (error) {
        result.error = error?.message || String(error)
      }
    }

    void (async () => {
      try {
        client = await vscode.ahaIpc.connect('ai-agent')
        client.on('message', onMessage)
        client.on('disconnect', () => {
          if (!result.error) result.error = 'ai-agent disconnected'
        })

        const createPacket = {
          packet_type: 'request',
          channel_id: makeUuid(),
          session_id: params.connectSessionId,
          params: makeEnvelope('chat', 'create_session', {
            project_id: params.projectId,
            session_type: 'side_chat'
          })
        }
        const created = await sendRequest('request', createPacket, 10_000)
        const chatSessionId =
          created?.result?.params?.data?.session?.session_id ||
          created?.result?.params?.data?.session_id ||
          makeObjectId()

        const messageId = makeObjectId()
        const modelInfo = {
          provider: '',
          config_name: params.model,
          display_model_name: params.model,
          multimodal: true,
          ak: '',
          use_remote_service: true,
          is_preset: true,
          config_source: 1,
          base_url: '',
          context_window_size: 1000000,
          region: params.account.countryCode || 'US',
          sk: '',
          auth_type: 0,
          max_tokens: 8192,
          max_turn: 35,
          prompt_max_tokens: 30000
        }
        const chatData = {
          agent_type: 'chat',
          session_id: chatSessionId,
          message_id: messageId,
          mention_context: {
            only_mention: false,
            hash_workspace: false,
            hash_folder: false,
            hash_files: [],
            hash_terminals: [],
            hash_symbols: [],
            hash_folders: [],
            hash_webs: [],
            hash_docs: [],
            hash_web_elements: [],
            hash_logs: [],
            hash_figma: [],
            hash_lint_error_flag: false,
            hash_rule_files: [],
            auto_rule_count: 0,
            agents_md_count: 0,
            claude_md_count: 0,
            hash_problem_items: [],
            hash_problem_files: []
          },
          model_name: params.model,
          custom_model: modelInfo,
          terminal_context: [],
          message_content: [{ type: 'text', text_content: params.prompt }],
          code_selections: [],
          scene_location: 2,
          parsed_query: [],
          multi_media: [],
          workspace_folders: [params.workspaceFolder],
          active_text_editor: null,
          is_workspace_folder_changed: false,
          asr_times: 0,
          is_in_plan_mode: false,
          is_in_spec_mode: false,
          ask_question_config: { feature_available: true, ide_enable: false, solo_enable: false },
          project_id: params.projectId
        }
        const chatPacket = {
          packet_type: 'request',
          channel_id: makeUuid(),
          session_id: params.connectSessionId,
          params: makeEnvelope('chat', 'chat', chatData, chatSessionId)
        }
        const streamResponse = await sendRequest('request_stream', chatPacket, 10_000)
        result.streamId = streamResponse?.result?.streamId || ''
        const deadline = Date.now() + 90_000
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200))
          if (result.events.some((item) => item.event === 'done')) break
          if (result.events.some((item) => item.code && item.code !== 0)) break
        }
        resolve(result)
      } catch (error) {
        resolve({ ...result, error: error?.message || String(error) })
      } finally {
        try {
          client?.off('message', onMessage)
        } catch {
          /* ignore */
        }
        try {
          client?.disconnect()
        } catch {
          /* ignore */
        }
      }
    })()
  })
}"#;
