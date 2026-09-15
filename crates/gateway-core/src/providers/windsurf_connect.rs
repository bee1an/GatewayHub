//! Windsurf language-server client — port of `providers/windsurf/connect.ts`.
//! Spawns `language_server_macos_arm` with Connect-RPC args, waits for the
//! server port, then issues unary JSON POSTs to
//! `http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}`.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

use crate::types::AccountFile;

pub const DEFAULT_WINDSURF_MODEL: &str = "swe-1-6-slow";
pub const DEFAULT_WINDSURF_API_SERVER_URL: &str = "https://server.self-serve.windsurf.com";
pub const DEFAULT_WINDSURF_IDE_VERSION: &str = "2.3.15";
pub const DEFAULT_INFERENCE_API_SERVER_URL: &str = "https://inference.codeium.com";
const MACOS_BINARY: &str = "/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm";
const MACOS_EXTENSION_DIR: &str =
    "/Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf";

pub fn normalize_windsurf_model(model: &str) -> String {
    let trimmed = model.trim();
    if trimmed.is_empty() {
        DEFAULT_WINDSURF_MODEL.into()
    } else {
        trimmed.into()
    }
}

pub fn resolve_language_server_binary(configured: &str) -> String {
    if !configured.is_empty() && std::path::Path::new(configured).exists() {
        return configured.to_string();
    }
    if std::path::Path::new(MACOS_BINARY).exists() {
        return MACOS_BINARY.to_string();
    }
    let home = dirs::home_dir().unwrap_or_default();
    let home_candidate = home.join(
        "Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/bin/language_server_macos_arm",
    );
    if home_candidate.exists() {
        return home_candidate.to_string_lossy().into_owned();
    }
    if configured.is_empty() {
        MACOS_BINARY.into()
    } else {
        configured.to_string()
    }
}

pub fn resolve_extension_dir() -> String {
    if std::path::Path::new(MACOS_EXTENSION_DIR).exists() {
        return MACOS_EXTENSION_DIR.into();
    }
    let home = dirs::home_dir().unwrap_or_default();
    home.join("Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf")
        .to_string_lossy()
        .into_owned()
}

pub fn windsurf_runtime_dir(account_id: &str) -> std::path::PathBuf {
    let sanitized: String = account_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || "_.-".contains(c) {
                c
            } else {
                '_'
            }
        })
        .collect();
    std::env::temp_dir()
        .join("gatewayhub-windsurf")
        .join(sanitized)
}

#[derive(Debug, Clone, Default)]
pub struct CapturedCascadeEdit {
    pub uri: Option<String>,
    pub target_content: Option<String>,
    pub cascade_id: Option<String>,
    pub git_worktree_path: Option<String>,
    pub received_at: i64,
}

struct ClientState {
    child: Option<tokio::process::Child>,
    parent_listener: Option<tokio::net::UnixListener>,
    extension_task: Option<tokio::task::JoinHandle<()>>,
    pipe_path: Option<std::path::PathBuf>,
    stderr_tail: Arc<Mutex<String>>,
}

/// Per-account language server process + Connect-RPC endpoint.
pub struct WindsurfLanguageServerClient {
    account_id: String,
    api_key: String,
    api_server_url: String,
    inference_api_server_url: String,
    codeium_dir: String,
    binary_path: String,
    detect_proxy: bool,
    vpn_proxy_url: String,
    runtime_dir: std::path::PathBuf,
    launch_timeout: Duration,
    client: reqwest::Client,
    port: Mutex<u16>,
    lsp_port: Mutex<u16>,
    extension_server_port: Mutex<u16>,
    csrf_token: String,
    session_id: String,
    request_id: AtomicU64,
    started: AtomicBool,
    state: Mutex<ClientState>,
    captured_edits: Arc<Mutex<Vec<CapturedCascadeEdit>>>,
}

use std::sync::atomic::AtomicBool;

impl WindsurfLanguageServerClient {
    pub fn new(
        account: &AccountFile,
        api_server_url: &str,
        inference_api_server_url: &str,
        binary_path: &str,
        codeium_dir: &str,
        detect_proxy: bool,
        vpn_proxy_url: &str,
        launch_timeout: Duration,
        client: reqwest::Client,
    ) -> Self {
        let field = |k: &str| {
            account
                .fields
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let csrf_token: String = uuid::Uuid::new_v4().simple().to_string();
        Self {
            account_id: account.id.clone(),
            api_key: field("apiKey"),
            api_server_url: {
                let v = field("apiServerUrl");
                if v.is_empty() {
                    api_server_url.to_string()
                } else {
                    v
                }
            },
            inference_api_server_url: {
                let v = field("inferenceApiServerUrl");
                if v.is_empty() {
                    inference_api_server_url.to_string()
                } else {
                    v
                }
            },
            codeium_dir: codeium_dir.to_string(),
            binary_path: binary_path.to_string(),
            detect_proxy,
            vpn_proxy_url: vpn_proxy_url.to_string(),
            runtime_dir: windsurf_runtime_dir(&account.id),
            launch_timeout,
            client,
            port: Mutex::new(0),
            lsp_port: Mutex::new(0),
            extension_server_port: Mutex::new(0),
            csrf_token,
            session_id: format!("gatewayhub-{}", uuid::Uuid::new_v4()),
            request_id: AtomicU64::new(0),
            started: AtomicBool::new(false),
            state: Mutex::new(ClientState {
                child: None,
                parent_listener: None,
                extension_task: None,
                pipe_path: None,
                stderr_tail: Arc::new(Mutex::new(String::new())),
            }),
            captured_edits: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub async fn ensure_started(&self) -> anyhow::Result<()> {
        {
            let mut state = self.state.lock().await;
            if self.started.load(Ordering::Relaxed)
                && state
                    .child
                    .as_mut()
                    .is_some_and(|c| c.try_wait().ok().flatten().is_none())
            {
                return Ok(());
            }
        }
        self.start().await
    }

    async fn start(&self) -> anyhow::Result<()> {
        let _guard = self.state.lock().await;
        if self.started.load(Ordering::Relaxed) {
            return Ok(());
        }
        tokio::fs::create_dir_all(&self.runtime_dir).await.ok();
        let port = free_port().await?;
        let lsp_port = free_port().await?;
        let extension_server_port = free_port().await?;

        // extension server — tiny HTTP listener capturing /WriteCascadeEdit
        let captured = self.captured_edits.clone();
        let ext_listener =
            tokio::net::TcpListener::bind(("127.0.0.1", extension_server_port)).await?;
        let ext_task = tokio::spawn(async move {
            loop {
                let Ok((socket, _)) = ext_listener.accept().await else {
                    break;
                };
                let captured = captured.clone();
                tokio::spawn(async move {
                    use tokio::io::AsyncReadExt;
                    let mut buf = Vec::new();
                    let mut socket = socket;
                    let _ =
                        tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut buf))
                            .await;
                    let text = String::from_utf8_lossy(&buf);
                    if let Some(edit) = parse_write_cascade_edit(&text) {
                        let mut edits = captured.lock().await;
                        edits.push(edit);
                        if edits.len() > 500 {
                            let drain = edits.len() - 500;
                            edits.drain(..drain);
                        }
                    }
                    let _ = socket
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnect-protocol-version: 1\r\ncontent-length: 2\r\n\r\n{}")
                        .await;
                });
            }
        });

        // parent pipe — unix socket that accepts + drops connections
        let pipe_path = std::env::temp_dir().join(format!(
            "gatewayhub-windsurf-parent-{}",
            &uuid::Uuid::new_v4().simple().to_string()[..16]
        ));
        let _ = tokio::fs::remove_file(&pipe_path).await;
        let parent_listener = tokio::net::UnixListener::bind(&pipe_path)?;
        let mut pstate = self.state.lock().await;
        pstate.extension_task = Some(ext_task);
        pstate.pipe_path = Some(pipe_path.clone());
        pstate.parent_listener = Some(parent_listener);
        drop(pstate);

        let binary = resolve_language_server_binary(&self.binary_path);
        let extension_dir = resolve_extension_dir();
        let args: Vec<String> = vec![
            "--api_server_url".into(),
            self.api_server_url.clone(),
            "--run_child".into(),
            "--enable_lsp".into(),
            "--extension_server_port".into(),
            extension_server_port.to_string(),
            "--ide_name".into(),
            "windsurf".into(),
            "--inference_api_server_url".into(),
            self.inference_api_server_url.clone(),
            "--server_port".into(),
            port.to_string(),
            "--lsp_port".into(),
            lsp_port.to_string(),
            "--csrf_token".into(),
            self.csrf_token.clone(),
            "--codeium_dir".into(),
            self.codeium_dir.clone(),
            "--database_dir".into(),
            self.runtime_dir
                .join("database")
                .join("9c0694567290725d9dcba14ade58e297")
                .to_string_lossy()
                .into_owned(),
            "--enable_index_service".into(),
            "--enable_local_search".into(),
            "--search_max_workspace_file_count".into(),
            "50000".into(),
            "--indexed_files_retention_period_days".into(),
            "30".into(),
            "--sentry_telemetry".into(),
            "--sentry_environment".into(),
            "stable".into(),
            "--extensions_dir".into(),
            extension_dir,
            "--parent_pipe_path".into(),
            pipe_path.to_string_lossy().into_owned(),
            "--windsurf_version".into(),
            DEFAULT_WINDSURF_IDE_VERSION.into(),
            "--stdin_initial_metadata".into(),
            format!("--detect_proxy={}", self.detect_proxy),
            "--workspace_id".into(),
            "gatewayhub".into(),
        ];
        let mut cmd = tokio::process::Command::new(binary);
        cmd.args(&args)
            .env(
                "CODEIUM_EDITOR_APP_ROOT",
                "/Applications/Windsurf.app/Contents/Resources/app",
            )
            .env("WINDSURF_CSRF_TOKEN", &self.csrf_token)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        if !self.vpn_proxy_url.is_empty() {
            cmd.env("HTTP_PROXY", &self.vpn_proxy_url)
                .env("HTTPS_PROXY", &self.vpn_proxy_url)
                .env("ALL_PROXY", &self.vpn_proxy_url)
                .env("http_proxy", &self.vpn_proxy_url)
                .env("https_proxy", &self.vpn_proxy_url)
                .env("all_proxy", &self.vpn_proxy_url);
        }
        let mut child = cmd.spawn()?;
        // stdin initial metadata (protobuf binary)
        if let Some(mut stdin) = child.stdin.take() {
            let blob = self.metadata_binary();
            let _ = stdin.write_all(&blob).await;
        }
        // drain stderr into stderr_tail
        if let Some(stderr) = child.stderr.take() {
            use tokio::io::AsyncReadExt;
            let tail_w = self.state.lock().await.stderr_tail.clone();
            tokio::spawn(async move {
                let mut buf = [0u8; 8192];
                let mut stderr = stderr;
                loop {
                    match stderr.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut t = tail_w.lock().await;
                            t.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if t.len() > 20_000 {
                                let over = t.len() - 20_000;
                                t.drain(..over);
                            }
                        }
                    }
                }
            });
        }
        {
            let mut pstate = self.state.lock().await;
            pstate.child = Some(child);
        }
        *self.port.lock().await = port;
        *self.lsp_port.lock().await = lsp_port;
        *self.extension_server_port.lock().await = extension_server_port;
        self.started.store(true, Ordering::Relaxed);

        if !wait_for_port(port, self.launch_timeout).await {
            self.dispose().await;
            let tail = self.stderr_tail_string().await;
            anyhow::bail!("Windsurf language server failed to start: {}", tail);
        }
        Ok(())
    }

    async fn stderr_tail_string(&self) -> String {
        let t = self.state.lock().await.stderr_tail.lock().await.clone();
        t.chars()
            .rev()
            .take(1000)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    }

    pub async fn dispose(&self) {
        self.started.store(false, Ordering::Relaxed);
        let mut state = self.state.lock().await;
        if let Some(task) = state.extension_task.take() {
            task.abort();
        }
        if let Some(path) = state.pipe_path.take() {
            let _ = std::fs::remove_file(path);
        }
        state.parent_listener = None;
        if let Some(mut child) = state.child.take() {
            let _ = child.kill().await;
        }
    }

    pub async fn get_captured_cascade_edits(
        &self,
        cascade_id: Option<&str>,
    ) -> Vec<CapturedCascadeEdit> {
        self.captured_edits
            .lock()
            .await
            .iter()
            .filter(|e| cascade_id.is_none_or(|id| e.cascade_id.as_deref() == Some(id)))
            .cloned()
            .collect()
    }

    pub fn metadata(&self) -> Value {
        let rid = self.request_id.fetch_add(1, Ordering::Relaxed) + 1;
        json!({
            "ideName": "windsurf",
            "ideVersion": DEFAULT_WINDSURF_IDE_VERSION,
            "ideType": "desktop",
            "extensionName": "windsurf",
            "extensionVersion": "0.2.0",
            "extensionPath": resolve_extension_dir(),
            "apiKey": self.api_key,
            "sessionId": self.session_id,
            "requestId": rid.to_string(),
            "locale": "en",
            "planName": "Unset",
            "os": std::env::consts::OS,
            "hardware": std::env::consts::ARCH,
        })
    }

    /// `unary` — Connect-RPC JSON POST with csrf + timeout.
    pub async fn unary(
        &self,
        method: &str,
        body: Value,
        timeout: Duration,
    ) -> anyhow::Result<Value> {
        self.ensure_started().await?;
        let port = *self.port.lock().await;
        let url = format!(
            "http://127.0.0.1:{port}/exa.language_server_pb.LanguageServerService/{method}"
        );
        let resp = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("connect-protocol-version", "1")
            .header("x-codeium-csrf-token", &self.csrf_token)
            .json(&body)
            .timeout(timeout)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    anyhow::anyhow!("Windsurf {method} timed out after {}s", timeout.as_secs())
                } else {
                    anyhow::anyhow!(e)
                }
            })?;
        let status = resp.status().as_u16();
        let text = resp.text().await.unwrap_or_default();
        let parsed: Value = serde_json::from_str(&text).unwrap_or_else(
            |e| json!({ "__parse_error": format!("Invalid Windsurf JSON response: {e}") }),
        );
        if status >= 400 {
            let message = parsed
                .get("message")
                .or_else(|| parsed.pointer("/error/message"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| text.chars().take(500).collect());
            anyhow::bail!("Windsurf HTTP {status}: {message}");
        }
        if let Some(err) = parsed.get("__parse_error") {
            anyhow::bail!(
                "{}: {}",
                err.as_str().unwrap_or(""),
                &text[..text.len().min(300)]
            );
        }
        Ok(parsed)
    }

    /// `metadataBinary` — protobuf-encoded stdin metadata.
    fn metadata_binary(&self) -> Vec<u8> {
        let m = self.metadata();
        let get = |k: &str| m.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let mut out = Vec::new();
        write_string(&mut out, 1, &get("ideName"));
        write_string(&mut out, 7, &get("ideVersion"));
        write_string(&mut out, 28, &get("ideType"));
        write_string(&mut out, 12, &get("extensionName"));
        write_string(&mut out, 2, &get("extensionVersion"));
        write_string(&mut out, 3, &get("apiKey"));
        write_string(&mut out, 4, &get("locale"));
        write_string(&mut out, 5, &get("os"));
        write_string(&mut out, 8, &get("hardware"));
        write_bool(&mut out, 6, false);
        write_string(&mut out, 10, &get("sessionId"));
        write_uint(&mut out, 9, self.request_id.load(Ordering::Relaxed));
        write_string(&mut out, 17, &get("extensionPath"));
        write_string(&mut out, 26, &get("planName"));
        out
    }
}

fn parse_write_cascade_edit(request: &str) -> Option<CapturedCascadeEdit> {
    // raw HTTP POST — split headers/body
    let (_, body) = request.split_once("\r\n\r\n")?;
    if !request.starts_with("POST") || !request.contains("/WriteCascadeEdit") {
        return None;
    }
    let v: Value = serde_json::from_str(body).ok()?;
    Some(CapturedCascadeEdit {
        uri: v.get("uri").and_then(Value::as_str).map(str::to_string),
        target_content: v
            .get("targetContent")
            .or_else(|| v.get("target_content"))
            .and_then(Value::as_str)
            .map(str::to_string),
        cascade_id: v
            .get("cascadeId")
            .or_else(|| v.get("cascade_id"))
            .and_then(Value::as_str)
            .map(str::to_string),
        git_worktree_path: v
            .get("gitWorktreePath")
            .or_else(|| v.get("git_worktree_path"))
            .and_then(Value::as_str)
            .map(str::to_string),
        received_at: crate::pool::now_ms(),
    })
}

async fn free_port() -> anyhow::Result<u16> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    Ok(listener.local_addr()?.port())
}

async fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if tokio::time::timeout(
            Duration::from_millis(500),
            tokio::net::TcpStream::connect(("127.0.0.1", port)),
        )
        .await
        .is_ok_and(|r| r.is_ok())
        {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

fn varint(mut n: u64) -> Vec<u8> {
    let mut bytes = Vec::new();
    while n >= 0x80 {
        bytes.push(((n & 0x7f) | 0x80) as u8);
        n >>= 7;
    }
    bytes.push(n as u8);
    bytes
}

fn write_string(out: &mut Vec<u8>, field: u64, value: &str) {
    if value.is_empty() {
        return;
    }
    let data = value.as_bytes();
    out.extend(varint((field << 3) | 2));
    out.extend(varint(data.len() as u64));
    out.extend_from_slice(data);
}

fn write_uint(out: &mut Vec<u8>, field: u64, value: u64) {
    out.extend(varint(field << 3));
    out.extend(varint(value));
}

fn write_bool(out: &mut Vec<u8>, field: u64, value: bool) {
    out.extend(varint(field << 3));
    out.push(value as u8);
}
