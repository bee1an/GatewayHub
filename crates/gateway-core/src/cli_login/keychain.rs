//! macOS temporary login keychain — the kiro CLI writes tokens to the user
//! default keychain, so a throwaway keychain under the temp profile is
//! swapped in for the login duration, then the original is restored.
//! Everything is `security(1)` invocations, like the TS implementation.

use std::path::{Path, PathBuf};

/// The kiro CLI writes tokens to the login keychain — swap in a throwaway
/// keychain as the user default for the duration of the login, then restore.
/// Everything is `security(1)` invocations, like the TS implementation.
#[cfg(target_os = "macos")]
pub(super) struct MacosKeychain {
    path: PathBuf,
    previous_default: Option<String>,
    previous_list: Vec<String>,
}

#[cfg(target_os = "macos")]
impl MacosKeychain {
    pub(super) fn setup(profile_home: &Path) -> Option<Self> {
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
        ]) && run_security(&[
            "unlock-keychain",
            "-p",
            "",
            &state.path.display().to_string(),
        ]) && run_security(&security_args(
            "list-keychains",
            &state.path,
            &state.previous_list,
        )) && run_security(&[
            "default-keychain",
            "-d",
            "user",
            "-s",
            &state.path.display().to_string(),
        ]);
        if ok {
            Some(state)
        } else {
            state.restore();
            None
        }
    }

    pub(super) fn restore(&self) {
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
pub(super) struct MacosKeychain;

#[cfg(not(target_os = "macos"))]
impl MacosKeychain {
    pub(super) fn setup(_profile_home: &Path) -> Option<Self> {
        None
    }
    pub(super) fn restore(&self) {}
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
    args.extend(rest.iter().filter(|p| Path::new(p).exists()).cloned());
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
    std::fs::read_dir(&dir)
        .ok()?
        .flatten()
        .filter(|e| {
            e.file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("login") && n.ends_with(".keychain-db"))
        })
        .map(|e| e.path().display().to_string())
        .min()
}
