//! `scanExternal*Accounts` — read each provider's local credential stores
//! (storage.json / sqlite / .info / auth.json) into `AccountFile` candidates,
//! then mark which ones already exist in the managed accounts dir.
//!
//! Ported from the Electron `configStore.scan*Accounts` + provider
//! `localState.ts` scanners. Everything is synchronous fs/sqlite — callers run
//! it on the tokio runtime via `service.spawn_ui`.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::apikey::sha256_short;
use crate::cli_login::normalize_expires_at;
use crate::store::ConfigStore;
use crate::types::{AccountFile, JsonMap};

mod kiro;
mod trae;
mod windsurf;
mod workbuddy;

/// One discovered credential bundle plus how it relates to the managed store.
#[derive(Debug, Clone)]
pub struct ScanCandidate {
    pub account: AccountFile,
    /// `sourceType` — where the credential was read from (json / sqlite /
    /// account-manager / *_storage / *_state / workbuddy_auth_file).
    pub source: String,
    /// An account sharing an identity key already exists.
    pub existing: bool,
    /// The existing account's id (kiro only uses this to update in place).
    pub existing_id: Option<String>,
    /// Kiro only — the scan carries fresher fields than the stored account.
    pub updatable: bool,
}

/// Providers that support the Discover (本机扫描) tab.
pub fn discover_capable(provider: &str) -> bool {
    matches!(
        provider,
        "kiro" | "trae" | "traework" | "workbuddy" | "windsurf"
    )
}

/// Providers where the scan is actually live — tracks provider liveness, so
/// the other `discover_capable` providers show a "coming soon" placeholder
/// and scans short-circuit.
pub fn discover_live(provider: &str) -> bool {
    crate::provider::provider_live(provider)
}

/// `scan*Accounts` — external scan, then flag `existing`/`updatable` against
/// the managed accounts dir via per-provider identity keys.
pub fn scan_provider_accounts(store: &ConfigStore, provider: &str) -> Vec<ScanCandidate> {
    if !discover_live(provider) {
        return Vec::new();
    }
    let scanned = match provider {
        "kiro" => kiro::scan_kiro(),
        "trae" => trae::scan_trae(),
        "traework" => trae::scan_traework(),
        "workbuddy" => workbuddy::scan_workbuddy(),
        "windsurf" => windsurf::scan_windsurf(),
        _ => Vec::new(),
    };
    let existing = store.scan_accounts(provider);
    // key → first account carrying it (TS keeps the first writer).
    let mut existing_by_key: HashMap<String, &AccountFile> = HashMap::new();
    for acc in &existing {
        for k in identity_keys(provider, acc) {
            existing_by_key.entry(k).or_insert(acc);
        }
    }
    scanned
        .into_iter()
        .map(|(account, source)| {
            let found = identity_keys(provider, &account)
                .iter()
                .find_map(|k| existing_by_key.get(k))
                .copied();
            let updatable =
                provider == "kiro" && found.is_some_and(|e| kiro_candidate_newer(&account, e));
            ScanCandidate {
                account,
                source,
                existing: found.is_some(),
                existing_id: found.map(|a| a.id.clone()),
                updatable,
            }
        })
        .collect()
}

/// `*IdentityKeys` — stable keys used to match a scan candidate against an
/// existing account file.
fn identity_keys(provider: &str, acc: &AccountFile) -> Vec<String> {
    let f = |k: &str| acc.field_str(k).unwrap_or("").to_string();
    let email = acc.email.clone().unwrap_or_default().to_lowercase();
    let mut keys = Vec::new();
    match provider {
        "kiro" => {
            let arn = f("profileArn");
            if !arn.is_empty() {
                keys.push(format!("profile:{}", sha256_short(&arn)));
            }
            let rt = f("refreshToken");
            if !rt.is_empty() {
                keys.push(format!("refresh:{}", sha256_short(&rt)));
            }
            if !email.is_empty() {
                keys.push(format!("email:{email}"));
            }
            let at = f("accessToken");
            if keys.is_empty() && !at.is_empty() {
                keys.push(format!("access:{}", sha256_short(&at)));
            }
        }
        "windsurf" => {
            if !email.is_empty() {
                keys.push(format!("windsurf-email:{email}"));
            }
            let key = f("apiKey");
            if !key.is_empty() {
                keys.push(format!("windsurf-api:{}", sha256_short(&key)));
            }
            if keys.is_empty() && !acc.id.is_empty() {
                keys.push(format!("windsurf-id:{}", acc.id));
            }
        }
        "trae" | "traework" => {
            let p = provider;
            let uid = f("userId");
            if !uid.is_empty() {
                keys.push(format!("{p}-user:{uid}"));
            }
            if !email.is_empty() {
                keys.push(format!("{p}-email:{email}"));
            }
            let rt = f("refreshToken");
            if !rt.is_empty() {
                keys.push(format!("{p}-refresh:{}", sha256_short(&rt)));
            }
            let jwt = f("jwtToken");
            if keys.is_empty() && !jwt.is_empty() {
                keys.push(format!("{p}-jwt:{}", sha256_short(&jwt)));
            }
            if keys.is_empty() && !acc.id.is_empty() {
                keys.push(format!("{p}-id:{}", acc.id));
            }
        }
        "workbuddy" => {
            let uid = f("uid");
            if !uid.is_empty() {
                keys.push(format!("workbuddy-uid:{uid}"));
            }
            if !email.is_empty() {
                keys.push(format!("workbuddy-email:{email}"));
            }
            let rt = f("refreshToken");
            if !rt.is_empty() {
                keys.push(format!("workbuddy-refresh:{}", sha256_short(&rt)));
            }
            let at = f("accessToken");
            if keys.is_empty() && !at.is_empty() {
                keys.push(format!("workbuddy-token:{}", sha256_short(&at)));
            }
            if keys.is_empty() && !acc.id.is_empty() {
                keys.push(format!("workbuddy-id:{}", acc.id));
            }
        }
        _ => {}
    }
    keys
}

/// `isKiroAccountCandidateNewer` — the scan has a field the stored account
/// lacks or that differs.
fn kiro_candidate_newer(candidate: &AccountFile, existing: &AccountFile) -> bool {
    for key in [
        "refreshToken",
        "accessToken",
        "expiresAt",
        "profileArn",
        "clientId",
        "clientSecret",
        "region",
        "apiRegion",
    ] {
        match (candidate.fields.get(key), existing.fields.get(key)) {
            (Some(new), old) if Some(new) != old => return true,
            _ => {}
        }
    }
    candidate.email.is_some() && candidate.email != existing.email
}

// ==================== shared helpers ====================

fn sha12(value: &str) -> String {
    sha256_short(value)[..12].to_string()
}

fn put(fields: &mut JsonMap, key: &str, value: String) {
    if !value.is_empty() {
        fields.insert(key.to_string(), json!(value));
    }
}

fn put_opt(fields: &mut JsonMap, key: &str, value: Option<String>) {
    if let Some(v) = value.filter(|s| !s.is_empty()) {
        fields.insert(key.to_string(), json!(v));
    }
}

fn put_ms(fields: &mut JsonMap, key: &str, value: Option<i64>) {
    if let Some(v) = value.filter(|ms| *ms > 0) {
        fields.insert(key.to_string(), json!(v));
    }
}

/// `normalizeEmail` — trimmed/lowercased `a@b.c` (`^[^\s@]+@[^\s@]+\.[^\s@]+$`),
/// else None.
fn normalize_email(value: Option<&Value>) -> Option<String> {
    normalize_email_str(value.and_then(Value::as_str)?)
}

fn normalize_email_str(value: &str) -> Option<String> {
    let raw = value.trim().to_lowercase();
    if raw.is_empty() || raw.contains(char::is_whitespace) {
        return None;
    }
    let (user, domain) = raw.split_once('@')?;
    let valid = !user.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.');
    valid.then_some(raw)
}

/// `normalizeEpoch` — seconds below 1e12, ms above; strings may be numeric or
/// ISO. Returns epoch milliseconds.
fn epoch_ms(value: Option<&Value>) -> Option<i64> {
    let v = value?;
    let scaled = |x: f64| {
        (x.is_finite() && x > 0.0).then_some(if x < 1e12 {
            (x * 1000.0) as i64
        } else {
            x as i64
        })
    };
    match v {
        Value::Number(n) => n.as_f64().and_then(scaled),
        Value::String(s) => {
            let t = s.trim();
            if t.is_empty() {
                return None;
            }
            if let Ok(x) = t.parse::<f64>() {
                return scaled(x);
            }
            chrono::DateTime::parse_from_rfc3339(t)
                .ok()
                .map(|d| d.timestamp_millis())
        }
        _ => None,
    }
}

/// `normalizeKiroExpiresAt` on a `Value` (string or epoch number) → ISO.
fn iso_from_value(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Number(_) => epoch_ms(value)
            .and_then(chrono::DateTime::from_timestamp_millis)
            .map(|d| d.to_rfc3339()),
        Value::String(s) => normalize_expires_at(s),
        _ => None,
    }
}

fn read_json_file(path: &Path) -> Option<Value> {
    let raw = fs::read(path).ok()?;
    serde_json::from_slice(&raw).ok()
}

fn existing_files(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for p in paths {
        if seen.insert(p.clone()) && p.is_file() {
            out.push(p);
        }
    }
    out
}

/// `new URL(v)` → origin, when the hostname ends with one of `suffixes`.
fn normalize_auth_host(value: &Value, suffixes: &[&str]) -> Option<String> {
    let raw = value.as_str()?.trim();
    if raw.is_empty() {
        return None;
    }
    let url = reqwest::Url::parse(raw).ok()?;
    let host = url.host_str()?;
    suffixes
        .iter()
        .any(|s| host.ends_with(s))
        .then(|| url.origin().ascii_serialization())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Manual smoke check against the real machine — run with
    /// `cargo test -p gateway-core discover::tests::real_scan -- --ignored`.
    /// Prints only label/id/source — never credential material.
    #[test]
    #[ignore = "reads real local credential stores"]
    fn real_scan() {
        let Some(store) = ConfigStore::detect() else {
            return;
        };
        for p in ["kiro", "trae", "traework", "workbuddy", "windsurf"] {
            let cands = scan_provider_accounts(&store, p);
            eprintln!("== {p}: {} candidates", cands.len());
            for c in cands {
                eprintln!(
                    "   {} | {} | src={} existing={} updatable={}",
                    c.account.id,
                    c.account.display_label(),
                    c.source,
                    c.existing,
                    c.updatable
                );
            }
        }
    }
}
