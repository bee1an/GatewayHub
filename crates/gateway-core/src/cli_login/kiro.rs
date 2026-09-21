//! Kiro `login` flow — `kiro-cli login --use-device-flow` inside the temp
//! profile, then a sqlite harvest of the token + device-registration bundle
//! into an `AccountFile`.

use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::process::Command;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};

use crate::apikey::sha256_short;
use crate::providers::kiro_auth::KiroAuth;
use crate::types::AccountFile;

use super::keychain::MacosKeychain;
use super::sandbox::{LoginEnv, pump, sandboxed};
use super::{CliLoginEvent, pick_str};

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

    let (cmd, args) = sandboxed(
        cli_path,
        &["login", "--license", "free", "--use-device-flow"],
    );
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
        put(
            "expiresAt",
            normalize_expires_at(&expires_at).unwrap_or_default(),
        );
        put("profileArn", arn);
        put("clientId", client_id);
        put("clientSecret", client_secret);
        put(
            "region",
            if region.is_empty() {
                "us-east-1".into()
            } else {
                region
            },
        );
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
    let email = usage
        .pointer("/userInfo/email")?
        .as_str()?
        .trim()
        .to_lowercase();
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
        trimmed
            .parse::<u64>()
            .ok()
            .map(|v| if v < 1_000_000_000_000 { v * 1000 } else { v })?
    } else {
        chrono::DateTime::parse_from_rfc3339(trimmed)
            .ok()?
            .timestamp_millis() as u64
    };
    chrono::DateTime::from_timestamp_millis(ms as i64).map(|t| t.to_rfc3339())
}
