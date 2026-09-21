//! CLI login — port of `providers/{kiro,qoder}/cliLogin.ts`: detect a locally
//! installed CLI, run its `login` inside an isolated temp HOME (sandboxed on
//! macOS, browser openers stubbed so the device flow stays in-terminal), then
//! harvest the resulting credentials into a managed account file.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::Value;
use tokio::process::Command;
use tokio::sync::mpsc::UnboundedSender;

use crate::types::AccountFile;

mod keychain;
mod kiro;
mod qoder;
mod sandbox;

pub use kiro::kiro_login;
pub(crate) use kiro::{KIRO_REGISTRATION_KEYS, KIRO_TOKEN_KEYS, normalize_expires_at};
pub use qoder::{qoder_import_current, qoder_login};

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

// ==================== shared helpers ====================

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
