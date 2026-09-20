//! CLI login — port of `providers/{kiro,qoder}/cliLogin.ts`: detect a locally
//! installed CLI, run its `login` inside an isolated temp HOME (sandboxed on
//! macOS, browser openers stubbed so the device flow stays in-terminal), then
//! harvest the resulting credentials into a managed account file.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::apikey::sha256_short;
use crate::providers::kiro_auth::KiroAuth;
use crate::types::AccountFile;

/// `CliDetectResult` — binary lookup outcome shown in the dialog.
#[derive(Debug, Clone)]
pub struct CliDetectResult {
    pub found: bool,
    pub path: String,
    pub version: Option<String>,
}

/// `CliLoginOutputEvent` — streamed to the dialog while `login` runs.
#[derive(Debug)]
pub enum CliLoginEvent {
    Stdout(String),
    Stderr(String),
    /// Process exited; `account` is set when credentials were harvested.
    Exit {
        code: i32,
        account: Option<AccountFile>,
        error: Option<String>,
    },
    /// Spawn/setup failure.
    Error(String),
}

/// Cancellation handle kept in the service's session map. `cancel_tx` tells
/// the pump to kill the child; `cancelled` suppresses further output events
/// and skips the post-exit harvest.
pub struct CliLoginHandle {
    pub cancelled: Arc<AtomicBool>,
    pub cancel_tx: UnboundedSender<()>,
}

/// Which providers support the CLI flow and which binary they look for.
pub fn cli_bin(provider: &str) -> Option<&'static str> {
    match provider {
        "kiro" => Some("kiro-cli"),
        "qoder" => Some("qodercli"),
        _ => None,
    }
}

fn default_cli_paths(bin: &str) -> Vec<PathBuf> {
    let home = home::home_dir().unwrap_or_default();
    let mut paths = vec![
        home.join(".local/bin").join(bin),
        PathBuf::from(format!("/usr/local/bin/{bin}")),
        PathBuf::from(format!("/opt/homebrew/bin/{bin}")),
    ];
    if bin == "qodercli" {
        paths.push(PathBuf::from("/usr/bin/qodercli"));
    }
    paths
}

/// `detectKiroCli`/`detectQoderCli` — candidate paths first, then a PATH scan.
pub async fn detect_cli(provider: &str, custom_path: Option<&str>) -> Result<CliDetectResult> {
    let bin = cli_bin(provider).context("provider has no CLI flow")?;
    if let Some(custom) = custom_path.filter(|p| !p.trim().is_empty()) {
        let p = PathBuf::from(custom.trim());
        if p.is_file() {
            return Ok(CliDetectResult {
                found: true,
                version: cli_version(&p).await,
                path: p.display().to_string(),
            });
        }
        return Ok(CliDetectResult {
            found: false,
            path: String::new(),
            version: None,
        });
    }
    for p in default_cli_paths(bin) {
        if p.is_file() {
            return Ok(CliDetectResult {
                found: true,
                version: cli_version(&p).await,
                path: p.display().to_string(),
            });
        }
    }
    if let Some(p) = which(bin) {
        return Ok(CliDetectResult {
            found: true,
            version: cli_version(&p).await,
            path: p.display().to_string(),
        });
    }
    Ok(CliDetectResult {
        found: false,
        path: String::new(),
        version: None,
    })
}

fn which(bin: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(bin))
            .find(|p| p.is_file())
    })
}

async fn cli_version(path: &Path) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(path).arg("--version").output(),
    )
    .await
    .ok()?
    .ok()?;
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!v.is_empty()).then_some(v)
}

// ==================== shared login scaffolding ====================

/// Deny the CLI's IPC auto-launch hooks — the device flow must print its URL
/// instead of opening a browser (TS `MACOS_SANDBOX_PROFILE`).
#[cfg(target_os = "macos")]
const MACOS_SANDBOX_PROFILE: &str = r#"(version 1)
(allow default)
(deny mach-lookup (global-name-regex #"^com\.apple\.coreservices\."))
(deny mach-lookup (global-name-regex #"^com\.apple\.lsd"))"#;

/// Browser-opener binaries stubbed to a stderr echo so `login` can't pop a
/// browser on the real desktop session.
const FAKE_OPENERS: &[&str] = &[
    "open",
    "xdg-open",
    "gio",
    "gnome-open",
    "kde-open",
    "wslview",
    "cygstart",
    "start",
    "osascript",
];

/// Isolated HOME for the login process — credentials land here, never in the
/// real home dir, and get harvested after a clean exit.
struct LoginEnv {
    home: PathBuf,
    fake_bin: PathBuf,
}

impl LoginEnv {
    fn prepare(tag: &str) -> Result<Self> {
        let stamp = uuid::Uuid::new_v4().simple().to_string();
        let home = std::env::temp_dir().join(format!("gatewayhub-{tag}-{stamp}"));
        std::fs::create_dir_all(&home)?;
        chmod(&home, 0o700);
        for sub in [".config", ".local/share", ".local/state", ".cache"] {
            std::fs::create_dir_all(home.join(sub))?;
        }

        let fake_bin = std::env::temp_dir().join(format!("gatewayhub-{tag}-noopen-{stamp}"));
        std::fs::create_dir_all(&fake_bin)?;
        let opener = fake_bin.join("gatewayhub-noopen");
        std::fs::write(&opener, "#!/bin/sh\nprintf \"%s\\n\" \"$*\" >&2\nexit 1\n")?;
        chmod(&opener, 0o755);
        for name in FAKE_OPENERS {
            let p = fake_bin.join(name);
            std::fs::write(&p, format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", opener.display()))?;
            chmod(&p, 0o755);
        }
        Ok(Self { home, fake_bin })
    }

    /// HOME + XDG redirection with the fake openers first on PATH.
    fn env(&self) -> HashMap<String, String> {
        let mut env: HashMap<String, String> = std::env::vars().collect();
        env.insert("HOME".into(), self.home.display().to_string());
        env.insert(
            "XDG_CONFIG_HOME".into(),
            self.home.join(".config").display().to_string(),
        );
        env.insert(
            "XDG_DATA_HOME".into(),
            self.home.join(".local/share").display().to_string(),
        );
        env.insert(
            "XDG_STATE_HOME".into(),
            self.home.join(".local/state").display().to_string(),
        );
        env.insert(
            "XDG_CACHE_HOME".into(),
            self.home.join(".cache").display().to_string(),
        );
        env.insert(
            "BROWSER".into(),
            self.fake_bin.join("gatewayhub-noopen").display().to_string(),
        );
        env.insert("DISPLAY".into(), String::new());
        env.insert("WAYLAND_DISPLAY".into(), String::new());
        env.remove("ELECTRON_RUN_AS_NODE");
        let path = env.get("PATH").cloned().unwrap_or_default();
        env.insert("PATH".into(), format!("{}:{path}", self.fake_bin.display()));
        env
    }

    fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.fake_bin);
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[cfg(unix)]
fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
fn chmod(_path: &Path, _mode: u32) {}

/// Wrap the command in `sandbox-exec` when available (TS `buildSpawnArgs`).
fn sandboxed(cli: &str, args: &[&str]) -> (String, Vec<String>) {
    #[cfg(target_os = "macos")]
    if Path::new("/usr/bin/sandbox-exec").exists() {
        let mut full = vec!["-p".to_string(), MACOS_SANDBOX_PROFILE.to_string(), cli.to_string()];
        full.extend(args.iter().map(|a| a.to_string()));
        return ("/usr/bin/sandbox-exec".to_string(), full);
    }
    (
        cli.to_string(),
        args.iter().map(|a| a.to_string()).collect(),
    )
}

/// Stream the child's stdout/stderr to the dialog until it exits or a cancel
/// lands (then SIGKILL). Returns `(exit_code, combined_output)`.
async fn pump(
    mut child: Child,
    cancelled: Arc<AtomicBool>,
    cancel_rx: &mut UnboundedReceiver<()>,
    tx: &UnboundedSender<CliLoginEvent>,
) -> (i32, String) {
    let output = Arc::new(StdMutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(reader) = child.stdout.take() {
        readers.push(spawn_reader(reader, false, tx, &output, &cancelled));
    }
    if let Some(reader) = child.stderr.take() {
        readers.push(spawn_reader(reader, true, tx, &output, &cancelled));
    }
    let code = tokio::select! {
        status = child.wait() => status.ok().and_then(|s| s.code()).unwrap_or(-1),
        _ = cancel_rx.recv() => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            -1
        }
    };
    for r in readers {
        let _ = r.await;
    }
    let combined = output
        .lock()
        .map(|mut g| std::mem::take(&mut *g))
        .unwrap_or_default();
    (code, combined)
}

fn spawn_reader<R>(
    mut reader: R,
    is_err: bool,
    tx: &UnboundedSender<CliLoginEvent>,
    output: &Arc<StdMutex<String>>,
    cancelled: &Arc<AtomicBool>,
) -> tokio::task::JoinHandle<()>
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    let tx = tx.clone();
    let output = output.clone();
    let cancelled = cancelled.clone();
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    if let Ok(mut out) = output.lock() {
                        out.push_str(&text);
                    }
                    if cancelled.load(Ordering::Relaxed) {
                        continue;
                    }
                    let _ = tx.send(if is_err {
                        CliLoginEvent::Stderr(text)
                    } else {
                        CliLoginEvent::Stdout(text)
                    });
                }
            }
        }
    })
}

// ==================== kiro ====================

/// `SQLITE_TOKEN_KEYS` — first hit wins, token JSON carries the creds.
/// Shared with `discover` (local-credential scan reads the same sqlite keys).
pub(crate) const KIRO_TOKEN_KEYS: &[&str] = &[
    "kirocli:social:token",
    "kirocli:odic:token",
    "codewhisperer:odic:token",
];
/// `SQLITE_REGISTRATION_KEYS` — OIDC device-registration bundle.
pub(crate) const KIRO_REGISTRATION_KEYS: &[&str] = &[
    "kirocli:odic:device-registration",
    "codewhisperer:odic:device-registration",
];

/// `loginWithKiroCli` — `kiro-cli login --license free --use-device-flow`
/// inside the temp profile, then sqlite harvest on clean exit.
pub async fn kiro_login(
    cli_path: &str,
    http: reqwest::Client,
    cancelled: Arc<AtomicBool>,
    mut cancel_rx: UnboundedReceiver<()>,
    tx: UnboundedSender<CliLoginEvent>,
) {
    let login_env = match LoginEnv::prepare("cli") {
        Ok(e) => e,
        Err(e) => {
            let _ = tx.send(CliLoginEvent::Error(e.to_string()));
            return;
        }
    };
    let keychain = MacosKeychain::setup(&login_env.home);

    let (cmd, args) = sandboxed(cli_path, &["login", "--license", "free", "--use-device-flow"]);
    let spawned = Command::new(&cmd)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(login_env.env())
        .spawn();
    let child = match spawned {
        Ok(c) => c,
        Err(e) => {
            restore_keychain(&keychain);
            login_env.cleanup();
            let _ = tx.send(CliLoginEvent::Error(e.to_string()));
            return;
        }
    };

    let (code, output) = pump(child, cancelled.clone(), &mut cancel_rx, &tx).await;
    let _ = std::fs::remove_dir_all(&login_env.fake_bin);
    if cancelled.load(Ordering::Relaxed) {
        restore_keychain(&keychain);
        login_env.cleanup();
        return;
    }

    let already = output.to_lowercase().contains("already logged in");
    if code == 0 || already {
        let result = extract_kiro_account(&login_env.home);
        restore_keychain(&keychain);
        login_env.cleanup();
        match result {
            Ok(mut acc) => {
                if let Some(email) = resolve_kiro_email(&acc, &http).await {
                    acc.label = Some(email.clone());
                    acc.email = Some(email);
                }
                let _ = tx.send(CliLoginEvent::Exit {
                    code: 0,
                    account: Some(acc),
                    error: None,
                });
            }
            Err(e) => {
                let _ = tx.send(CliLoginEvent::Exit {
                    code: 0,
                    account: None,
                    error: Some(e.to_string()),
                });
            }
        }
    } else {
        restore_keychain(&keychain);
        login_env.cleanup();
        let _ = tx.send(CliLoginEvent::Exit {
            code,
            account: None,
            error: None,
        });
    }
}

fn restore_keychain(keychain: &Option<MacosKeychain>) {
    if let Some(k) = keychain {
        k.restore();
    }
}

/// `extractAccountFromProfile` — read `auth_kv`/`state` out of the temp
/// profile's `data.sqlite3` and shape an account file.
fn extract_kiro_account(profile: &Path) -> Result<AccountFile> {
    let candidates = [
        profile.join("Library/Application Support/kiro-cli/data.sqlite3"),
        profile.join(".local/share/kiro-cli/data.sqlite3"),
    ];
    for db_path in candidates {
        if !db_path.exists() {
            continue;
        }
        let conn = rusqlite::Connection::open(&db_path)
            .with_context(|| format!("open {}", db_path.display()))?;
        let kv = |key: &str| -> Option<String> {
            conn.query_row("SELECT value FROM auth_kv WHERE key = ?1", [key], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        };
        let mut access = String::new();
        let mut refresh = String::new();
        let mut arn = String::new();
        let mut region = String::new();
        let mut expires_at = String::new();
        let mut client_id = String::new();
        let mut client_secret = String::new();

        for key in KIRO_TOKEN_KEYS {
            let Some(raw) = kv(key) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            access = pick_str(&v, &["access_token", "accessToken"]);
            refresh = pick_str(&v, &["refresh_token", "refreshToken"]);
            arn = pick_str(&v, &["profile_arn", "profileArn"]);
            region = pick_str(&v, &["region"]);
            expires_at = pick_str(&v, &["expires_at", "expiresAt"]);
            break;
        }
        for key in KIRO_REGISTRATION_KEYS {
            let Some(raw) = kv(key) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            client_id = pick_str(&v, &["client_id", "clientId"]);
            client_secret = pick_str(&v, &["client_secret", "clientSecret"]);
            if region.is_empty() {
                region = pick_str(&v, &["region"]);
            }
            break;
        }
        // Older DBs may lack the `state` table — the profile arn is a bonus.
        if let Ok(raw) = conn.query_row(
            "SELECT value FROM state WHERE key = 'api.codewhisperer.profile'",
            [],
            |r| r.get::<_, String>(0),
        ) && arn.is_empty()
            && let Ok(v) = serde_json::from_str::<Value>(&raw)
        {
            arn = pick_str(&v, &["arn"]);
        }

        if refresh.is_empty() && access.is_empty() {
            continue;
        }
        let id = if !arn.is_empty() {
            format!("kiro-profile-{}", sha256_short(&arn))
        } else if !refresh.is_empty() {
            format!("kiro-refresh-{}", sha256_short(&refresh))
        } else {
            format!("kiro-access-{}", sha256_short(&access))
        };
        let mut acc = AccountFile {
            id,
            enabled: true,
            label: Some(format!("CLI {}", chrono::Local::now().format("%Y-%m-%d"))),
            ..Default::default()
        };
        let mut put = |k: &str, v: String| {
            if !v.is_empty() {
                acc.fields.insert(k.to_string(), json!(v));
            }
        };
        put("refreshToken", refresh);
        put("accessToken", access);
        put("expiresAt", normalize_expires_at(&expires_at).unwrap_or_default());
        put("profileArn", arn);
        put("clientId", client_id);
        put("clientSecret", client_secret);
        put("region", if region.is_empty() { "us-east-1".into() } else { region });
        return Ok(acc);
    }
    bail!("No kiro-cli database found in temp profile")
}

/// `resolveEmailFromAccount` — best-effort `/getUsageLimits` lookup for the
/// label; any failure just leaves the `CLI <date>` label.
async fn resolve_kiro_email(acc: &AccountFile, http: &reqwest::Client) -> Option<String> {
    let region = acc.field_str("region").unwrap_or("us-east-1");
    let auth = KiroAuth::new(acc, region, None, None, http.clone(), None).ok()?;
    let arn = auth.profile_arn().await;
    if arn.is_empty() {
        return None;
    }
    let usage = tokio::time::timeout(
        Duration::from_secs(15),
        auth.api_get(
            "/getUsageLimits",
            &[
                ("profileArn", arn.as_str()),
                ("origin", "AI_EDITOR"),
                ("resourceType", "AGENTIC_REQUEST"),
                ("isEmailRequired", "true"),
            ],
        ),
    )
    .await
    .ok()?
    .ok()?;
    let email = usage.pointer("/userInfo/email")?.as_str()?.trim().to_lowercase();
    email.contains('@').then_some(email)
}

/// `normalizeKiroExpiresAt` — ISO in/out; bare numbers are epoch (sec below
/// 1e12, ms otherwise). Shared with `discover`.
pub(crate) fn normalize_expires_at(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let ms = if trimmed.chars().all(|c| c.is_ascii_digit()) {
        trimmed.parse::<u64>().ok().map(|v| {
            if v < 1_000_000_000_000 { v * 1000 } else { v }
        })?
    } else {
        chrono::DateTime::parse_from_rfc3339(trimmed)
            .ok()?
            .timestamp_millis() as u64
    };
    chrono::DateTime::from_timestamp_millis(ms as i64).map(|t| t.to_rfc3339())
}

// ==================== qoder ====================

/// `loginWithQoderCli` — `qodercli login` in a temp `QODER_CLI_HOME`, then
/// copy `.qoder/.auth` into the managed auth dir on clean exit.
pub async fn qoder_login(
    cli_path: &str,
    auth_dir: PathBuf,
    label: Option<String>,
    cancelled: Arc<AtomicBool>,
    mut cancel_rx: UnboundedReceiver<()>,
    tx: UnboundedSender<CliLoginEvent>,
) {
    let login_env = match LoginEnv::prepare("qoder-cli") {
        Ok(e) => e,
        Err(e) => {
            let _ = tx.send(CliLoginEvent::Error(e.to_string()));
            return;
        }
    };
    let mut vars = login_env.env();
    vars.insert("QODER_CLI_HOME".into(), login_env.home.display().to_string());
    scrub_qoder_env(&mut vars);

    let (cmd, args) = sandboxed(cli_path, &["login"]);
    let spawned = Command::new(&cmd)
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(vars)
        .spawn();
    let child = match spawned {
        Ok(c) => c,
        Err(e) => {
            login_env.cleanup();
            let _ = tx.send(CliLoginEvent::Error(e.to_string()));
            return;
        }
    };

    let (code, _output) = pump(child, cancelled.clone(), &mut cancel_rx, &tx).await;
    let _ = std::fs::remove_dir_all(&login_env.fake_bin);
    if cancelled.load(Ordering::Relaxed) {
        login_env.cleanup();
        return;
    }

    if code == 0 {
        match extract_qoder_account(&login_env.home, &auth_dir, cli_path, label).await {
            Ok(acc) => {
                login_env.cleanup();
                let _ = tx.send(CliLoginEvent::Exit {
                    code: 0,
                    account: Some(acc),
                    error: None,
                });
            }
            Err(e) => {
                login_env.cleanup();
                let _ = tx.send(CliLoginEvent::Exit {
                    code: 0,
                    account: None,
                    error: Some(e.to_string()),
                });
            }
        }
    } else {
        login_env.cleanup();
        let _ = tx.send(CliLoginEvent::Exit {
            code,
            account: None,
            error: None,
        });
    }
}

/// `importCurrentQoderCliAuth` — harvest an already-logged-in qodercli from
/// the real home dir (or `$QODER_CLI_HOME`) without running `login`.
pub async fn qoder_import_current(
    auth_dir: PathBuf,
    cli_path: Option<String>,
) -> Result<AccountFile> {
    let det = detect_cli("qoder", cli_path.as_deref()).await?;
    if !det.found {
        bail!("qodercli not found");
    }
    let source_home = std::env::var_os("QODER_CLI_HOME")
        .map(PathBuf::from)
        .or_else(home::home_dir)
        .context("no home dir")?;
    extract_qoder_account(&source_home, &auth_dir, &det.path, None).await
}

/// `extractAccountFromQoderHome` — copy `{home}/.qoder/.auth` into
/// `{auth_dir}/qoder-cli-<fp>` and verify the copy is usable.
async fn extract_qoder_account(
    source_home: &Path,
    auth_dir: &Path,
    cli_path: &str,
    label: Option<String>,
) -> Result<AccountFile> {
    let source_auth = source_home.join(".qoder").join(".auth");
    let user_blob = std::fs::read_to_string(source_auth.join("user"))
        .context("read qoder auth user blob")?;
    let machine_id = std::fs::read_to_string(source_auth.join("machine_id"))
        .context("read qoder auth machine_id")?;

    let status = qoder_status(cli_path, source_home).await?;
    if !status.get("logged_in").and_then(Value::as_bool).unwrap_or(false) {
        bail!("qodercli is not logged in");
    }
    let email = status
        .get("email")
        .and_then(Value::as_str)
        .map(str::trim)
        .map(str::to_lowercase)
        .filter(|e| e.contains('@'));
    let username = status
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let fingerprint = sha256_short(&format!("{user_blob}\n{machine_id}"));
    let identity = email.clone().or(username.clone()).unwrap_or(fingerprint.clone());
    let id = format!("qoder-cli-{}", sha256_short(&format!("{identity}:{fingerprint}")));

    let target_home = auth_dir.join(&id);
    let target_auth = target_home.join(".qoder").join(".auth");
    let _ = std::fs::remove_dir_all(&target_home);
    std::fs::create_dir_all(&target_auth)?;
    copy_dir(&source_auth, &target_auth)?;
    chmod(&target_home, 0o700);
    chmod(&target_home.join(".qoder"), 0o700);
    chmod(&target_auth, 0o700);

    // The copied bundle must resolve to a logged-in session on its own —
    // otherwise requests would read a dead credential at runtime.
    let copied = qoder_status(cli_path, &target_home).await?;
    if !copied.get("logged_in").and_then(Value::as_bool).unwrap_or(false) {
        let _ = std::fs::remove_dir_all(&target_home);
        bail!("Copied Qoder auth bundle is not usable");
    }

    let mut acc = AccountFile {
        id,
        enabled: true,
        email: email.clone(),
        label: label
            .filter(|l| !l.trim().is_empty())
            .or(email)
            .or(username)
            .or_else(|| Some("Qoder CLI Login".into())),
        ..Default::default()
    };
    acc.fields
        .insert("authType".into(), json!("qoder-cli-auth"));
    acc.fields.insert("qoderCliPath".into(), json!(cli_path));
    acc.fields.insert(
        "qoderCliHome".into(),
        json!(target_home.display().to_string()),
    );
    Ok(acc)
}

/// `readQoderStatusJson` — `qodercli status -o json` scoped to a CLI home,
/// with proxy/PAT env scrubbed so status reflects the bundle, not the env.
async fn qoder_status(cli_path: &str, home: &Path) -> Result<Value> {
    let mut cmd = Command::new(cli_path);
    cmd.args(["status", "-o", "json"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("QODER_CLI_HOME", home);
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "QODER_PERSONAL_ACCESS_TOKEN",
    ] {
        cmd.env_remove(key);
    }
    let out = tokio::time::timeout(Duration::from_secs(15), cmd.output())
        .await
        .context("qodercli status timed out")??;
    if !out.status.success() {
        bail!(
            "qodercli status exited {}: {}",
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(serde_json::from_str(&raw).unwrap_or_else(|_| json!({})))
}

fn scrub_qoder_env(env: &mut HashMap<String, String>) {
    for key in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "QODER_PERSONAL_ACCESS_TOKEN",
    ] {
        env.remove(key);
    }
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

// ==================== macOS temporary keychain ====================

/// The kiro CLI writes tokens to the login keychain — swap in a throwaway
/// keychain as the user default for the duration of the login, then restore.
/// Everything is `security(1)` invocations, like the TS implementation.
#[cfg(target_os = "macos")]
struct MacosKeychain {
    path: PathBuf,
    previous_default: Option<String>,
    previous_list: Vec<String>,
}

#[cfg(target_os = "macos")]
impl MacosKeychain {
    fn setup(profile_home: &Path) -> Option<Self> {
        let dir = profile_home.join("Library/Keychains");
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join("login.keychain-db");
        let state = Self {
            previous_default: security(&["default-keychain", "-d", "user"]),
            previous_list: security_lines(&["list-keychains", "-d", "user"]),
            path,
        };
        let ok = run_security(&[
            "create-keychain",
            "-p",
            "",
            &state.path.display().to_string(),
        ]) && run_security(&["unlock-keychain", "-p", "", &state.path.display().to_string()])
            && run_security(&security_args(
                "list-keychains",
                &state.path,
                &state.previous_list,
            ))
            && run_security(&[
                "default-keychain",
                "-d",
                "user",
                "-s",
                &state.path.display().to_string(),
            ]);
        if ok { Some(state) } else { state.restore(); None }
    }

    fn restore(&self) {
        let mut list: Vec<String> = self
            .previous_list
            .iter()
            .filter(|p| **p != self.path.display().to_string())
            .filter(|p| Path::new(p).exists())
            .cloned()
            .collect();
        let default = self
            .previous_default
            .as_ref()
            .filter(|p| Path::new(p).exists())
            .cloned()
            .or_else(|| list.first().cloned())
            .or_else(fallback_login_keychain);
        if let Some(d) = &default
            && !list.contains(d)
        {
            list.insert(0, d.clone());
        }
        if !list.is_empty() {
            let mut args = vec!["list-keychains", "-d", "user", "-s"];
            args.extend(list.iter().map(String::as_str));
            let _ = run_security(&args);
        }
        if let Some(d) = default {
            let _ = run_security(&["default-keychain", "-d", "user", "-s", &d]);
        }
    }
}

#[cfg(not(target_os = "macos"))]
struct MacosKeychain;

#[cfg(not(target_os = "macos"))]
impl MacosKeychain {
    fn setup(_profile_home: &Path) -> Option<Self> {
        None
    }
    fn restore(&self) {}
}

#[cfg(target_os = "macos")]
fn security_raw(args: &[&str]) -> Option<String> {
    std::process::Command::new("/usr/bin/security")
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
}

/// Single-value `security` output — trimmed, quotes stripped (TS
/// `normalizeSecurityPath`).
#[cfg(target_os = "macos")]
fn security(args: &[&str]) -> Option<String> {
    security_raw(args).map(|s| s.trim().trim_matches('"').to_string())
}

#[cfg(target_os = "macos")]
fn security_lines(args: &[&str]) -> Vec<String> {
    security_raw(args)
        .map(|s| {
            s.lines()
                .map(|l| l.trim().trim_matches('"').to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn security_args(op: &str, first: &Path, rest: &[String]) -> Vec<String> {
    let mut args: Vec<String> = [op, "-d", "user", "-s"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    args.push(first.display().to_string());
    args.extend(
        rest.iter()
            .filter(|p| Path::new(p).exists())
            .cloned(),
    );
    args
}

#[cfg(target_os = "macos")]
fn run_security<S: AsRef<str>>(args: &[S]) -> bool {
    std::process::Command::new("/usr/bin/security")
        .args(args.iter().map(|s| s.as_ref()))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn fallback_login_keychain() -> Option<String> {
    let dir = home::home_dir()?.join("Library/Keychains");
    let standard = dir.join("login.keychain-db");
    if standard.exists() {
        return Some(standard.display().to_string());
    }
    std::fs::read_dir(&dir).ok()?.flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("login") && n.ends_with(".keychain-db"))
        })
        .map(|e| e.path().display().to_string())
        .min()
}

// ==================== shared helpers ====================

pub(crate) fn pick_str(v: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(Value::as_str))
        .unwrap_or("")
        .to_string()
}

/// `isPathInside` — lexical containment check so account JSON can't point
/// `qoderCliHome` outside the managed auth dir. `..` components are resolved
/// textually; no filesystem access needed.
pub fn path_inside(path: &Path, root: &Path) -> bool {
    fn normalize(p: &Path) -> PathBuf {
        let mut out = PathBuf::new();
        for c in p.components() {
            match c {
                Component::CurDir => {}
                Component::ParentDir => {
                    out.pop();
                }
                other => out.push(other.as_os_str()),
            }
        }
        out
    }
    normalize(path).starts_with(normalize(root))
}
