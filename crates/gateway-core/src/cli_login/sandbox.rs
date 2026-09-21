//! Shared login scaffolding — an isolated temp `HOME` with stubbed browser
//! openers, the `sandbox-exec` wrapper, and the child-process output pump
//! that streams stdout/stderr to the dialog.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::Result;
use tokio::io::AsyncReadExt;
use tokio::process::Child;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use super::CliLoginEvent;

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
pub(super) struct LoginEnv {
    pub(super) home: PathBuf,
    pub(super) fake_bin: PathBuf,
}

impl LoginEnv {
    pub(super) fn prepare(tag: &str) -> Result<Self> {
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
            std::fs::write(
                &p,
                format!("#!/bin/sh\nexec \"{}\" \"$@\"\n", opener.display()),
            )?;
            chmod(&p, 0o755);
        }
        Ok(Self { home, fake_bin })
    }

    /// HOME + XDG redirection with the fake openers first on PATH.
    pub(super) fn env(&self) -> HashMap<String, String> {
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
            self.fake_bin
                .join("gatewayhub-noopen")
                .display()
                .to_string(),
        );
        env.insert("DISPLAY".into(), String::new());
        env.insert("WAYLAND_DISPLAY".into(), String::new());
        env.remove("ELECTRON_RUN_AS_NODE");
        let path = env.get("PATH").cloned().unwrap_or_default();
        env.insert("PATH".into(), format!("{}:{path}", self.fake_bin.display()));
        env
    }

    pub(super) fn cleanup(&self) {
        let _ = std::fs::remove_dir_all(&self.fake_bin);
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

#[cfg(unix)]
pub(super) fn chmod(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
}

#[cfg(not(unix))]
pub(super) fn chmod(_path: &Path, _mode: u32) {}

/// Wrap the command in `sandbox-exec` when available (TS `buildSpawnArgs`).
pub(super) fn sandboxed(cli: &str, args: &[&str]) -> (String, Vec<String>) {
    #[cfg(target_os = "macos")]
    if Path::new("/usr/bin/sandbox-exec").exists() {
        let mut full = vec![
            "-p".to_string(),
            MACOS_SANDBOX_PROFILE.to_string(),
            cli.to_string(),
        ];
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
pub(super) async fn pump(
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
