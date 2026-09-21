//! Qoder `login` flow — `qodercli login` inside a temp `QODER_CLI_HOME`,
//! plus `qoder_import_current`: harvest an already-logged-in CLI bundle
//! straight from the real home dir.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::apikey::sha256_short;
use crate::types::AccountFile;

use super::sandbox::{LoginEnv, chmod, pump, sandboxed};
use super::{CliLoginEvent, copy_dir, detect_cli};

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
    vars.insert(
        "QODER_CLI_HOME".into(),
        login_env.home.display().to_string(),
    );
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
    let user_blob =
        std::fs::read_to_string(source_auth.join("user")).context("read qoder auth user blob")?;
    let machine_id = std::fs::read_to_string(source_auth.join("machine_id"))
        .context("read qoder auth machine_id")?;

    let status = qoder_status(cli_path, source_home).await?;
    if !status
        .get("logged_in")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
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
    let identity = email
        .clone()
        .or(username.clone())
        .unwrap_or(fingerprint.clone());
    let id = format!(
        "qoder-cli-{}",
        sha256_short(&format!("{identity}:{fingerprint}"))
    );

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
    if !copied
        .get("logged_in")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
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
