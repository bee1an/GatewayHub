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
use crate::cli_login::{KIRO_REGISTRATION_KEYS, KIRO_TOKEN_KEYS, normalize_expires_at, pick_str};
use crate::store::ConfigStore;
use crate::types::{AccountFile, JsonMap};

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
        "kiro" => scan_kiro(),
        "trae" => scan_trae(),
        "traework" => scan_traework(),
        "workbuddy" => scan_workbuddy(),
        "windsurf" => scan_windsurf(),
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

// ==================== kiro ====================

/// `extractAccountFromJson` — one kiro credential object per JSON file.
fn kiro_from_json(path: &Path, label: &str) -> Option<AccountFile> {
    let data = read_json_file(path)?;
    let refresh = pick_str(&data, &["refreshToken", "refresh_token"]);
    let access = pick_str(&data, &["accessToken", "access_token"]);
    if refresh.is_empty() && access.is_empty() {
        return None;
    }
    let arn = pick_str(&data, &["profileArn", "profile_arn"]);
    let mut acc = AccountFile {
        id: kiro_stable_id_parts(&arn, &refresh, &access),
        label: Some(label.to_string()),
        email: normalize_email(
            data.get("email")
                .or_else(|| data.pointer("/userInfo/email")),
        ),
        enabled: true,
        ..Default::default()
    };
    put(&mut acc.fields, "refreshToken", refresh);
    put(&mut acc.fields, "accessToken", access);
    put(&mut acc.fields, "profileArn", arn);
    put(
        &mut acc.fields,
        "clientId",
        pick_str(&data, &["clientId", "client_id"]),
    );
    put(
        &mut acc.fields,
        "clientSecret",
        pick_str(&data, &["clientSecret", "client_secret"]),
    );
    put_opt(
        &mut acc.fields,
        "expiresAt",
        iso_from_value(data.get("expiresAt").or_else(|| data.get("expires_at"))),
    );
    put(&mut acc.fields, "region", pick_str(&data, &["region"]));
    put(
        &mut acc.fields,
        "apiRegion",
        pick_str(&data, &["apiRegion", "api_region"]),
    );
    Some(acc)
}

/// `extractAccountsFromKiroAccountManager` — kiro-accounts.backup.json holds
/// several accounts under `accounts` (array or map), active first.
fn kiro_from_account_manager(path: &Path) -> Vec<AccountFile> {
    let Some(data) = read_json_file(path) else {
        return Vec::new();
    };
    let active = pick_str(&data, &["activeAccountId"]);
    let mut entries: Vec<(String, &Value)> = match data.get("accounts") {
        Some(Value::Array(list)) => list
            .iter()
            .enumerate()
            .map(|(i, a)| {
                let id = pick_str(a, &["id"]);
                (if id.is_empty() { i.to_string() } else { id }, a)
            })
            .collect(),
        Some(Value::Object(map)) => map.iter().map(|(k, v)| (k.clone(), v)).collect(),
        _ => Vec::new(),
    };
    entries.sort_by_key(|(id, _)| if id == &active { 0 } else { 1 });

    let mut out = Vec::new();
    for (entry_id, account) in entries {
        if !account.is_object() {
            continue;
        }
        // credentials may be a nested object or a JSON-encoded string.
        let creds = match account.get("credentials") {
            Some(v @ Value::Object(_)) => Some(v.clone()),
            Some(Value::String(s)) => serde_json::from_str::<Value>(s)
                .ok()
                .filter(|v| v.is_object()),
            _ => None,
        };
        let Some(creds) = creds else { continue };
        let refresh = pick_str(&creds, &["refreshToken", "refresh_token"]);
        let access = pick_str(&creds, &["accessToken", "access_token"]);
        if refresh.is_empty() && access.is_empty() {
            continue;
        }
        let arn = {
            let v = pick_str(&creds, &["profileArn", "profile_arn"]);
            if v.is_empty() {
                pick_str(account, &["profileArn", "profile_arn"])
            } else {
                v
            }
        };
        let email = normalize_email(account.get("email").or_else(|| creds.get("email")));
        let nickname = pick_str(account, &["nickname"]);
        let label = email.clone().unwrap_or_else(|| {
            if !nickname.is_empty() {
                nickname
            } else if entry_id == active {
                "Kiro account-manager active account".into()
            } else {
                "Kiro account-manager".into()
            }
        });
        let mut acc = AccountFile {
            id: kiro_stable_id_parts(&arn, &refresh, &access),
            label: Some(label),
            email,
            enabled: true,
            ..Default::default()
        };
        put(&mut acc.fields, "refreshToken", refresh);
        put(&mut acc.fields, "accessToken", access);
        put_opt(
            &mut acc.fields,
            "expiresAt",
            iso_from_value(creds.get("expiresAt").or_else(|| creds.get("expires_at"))),
        );
        put(&mut acc.fields, "profileArn", arn);
        put(
            &mut acc.fields,
            "clientId",
            pick_str(&creds, &["clientId", "client_id"]),
        );
        put(
            &mut acc.fields,
            "clientSecret",
            pick_str(&creds, &["clientSecret", "client_secret"]),
        );
        let region = pick_str(&creds, &["region"]);
        put(
            &mut acc.fields,
            "region",
            if region.is_empty() {
                pick_str(account, &["region"])
            } else {
                region
            },
        );
        let api_region = pick_str(&creds, &["apiRegion", "api_region"]);
        put(
            &mut acc.fields,
            "apiRegion",
            if api_region.is_empty() {
                pick_str(account, &["apiRegion"])
            } else {
                api_region
            },
        );
        out.push(acc);
    }
    out
}

/// `extractAccountFromSqlite` — kiro-cli / amazon-q `data.sqlite3` (read-only;
/// the real DB is opened with SQLITE_OPEN_READ_ONLY so no WAL is created).
fn kiro_from_sqlite(db_path: &Path) -> Option<AccountFile> {
    if !db_path.is_file() {
        return None;
    }
    let conn =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
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
        return None;
    }
    let mut acc = AccountFile {
        id: if !arn.is_empty() {
            format!("kiro-profile-{}", sha256_short(&arn))
        } else {
            format!("kiro-refresh-{}", sha256_short(&refresh))
        },
        label: Some(
            if db_path.to_string_lossy().contains("amazon-q") {
                "Amazon Q CLI"
            } else {
                "kiro-cli"
            }
            .to_string(),
        ),
        enabled: true,
        ..Default::default()
    };
    put(&mut acc.fields, "refreshToken", refresh);
    put(&mut acc.fields, "accessToken", access);
    put_opt(
        &mut acc.fields,
        "expiresAt",
        normalize_expires_at(&expires_at),
    );
    put(&mut acc.fields, "profileArn", arn);
    put(&mut acc.fields, "clientId", client_id);
    put(&mut acc.fields, "clientSecret", client_secret);
    put(&mut acc.fields, "region", region);
    Some(acc)
}

/// `readLocalKiroProfileArn` — the IDE writes the active profile ARN to
/// profile.json; it survives refresh-token rotation so it anchors dedupe.
fn read_local_kiro_profile_arn(home: &Path) -> Option<String> {
    for path in [
        home.join(
            "Library/Application Support/Kiro/User/globalStorage/kiro.kiroagent/profile.json",
        ),
        home.join(".config/Kiro/User/globalStorage/kiro.kiroagent/profile.json"),
    ] {
        if let Some(data) = read_json_file(&path)
            && let Some(arn) = data.get("arn").and_then(Value::as_str)
            && !arn.is_empty()
        {
            return Some(arn.to_string());
        }
    }
    None
}

/// `makeStableId` for kiro.
fn kiro_stable_id_parts(arn: &str, refresh: &str, access: &str) -> String {
    if !arn.is_empty() {
        format!("kiro-profile-{}", sha256_short(arn))
    } else if !refresh.is_empty() {
        format!("kiro-refresh-{}", sha256_short(refresh))
    } else {
        format!("kiro-access-{}", sha256_short(access))
    }
}

/// `dedupeKiroCandidates` — union-find over every identity key a candidate
/// carries, then merge each group into the freshest member.
fn dedupe_kiro(
    mut candidates: Vec<(AccountFile, String)>,
    local_arn: Option<String>,
) -> Vec<(AccountFile, String)> {
    // Backfill the machine-local profile ARN — safe because profile.json is
    // the *active* account; candidates with their own arn keep it.
    if let Some(arn) = &local_arn {
        for (acc, _) in &mut candidates {
            if acc.field_str("profileArn").is_none() {
                acc.fields.insert("profileArn".into(), json!(arn));
            }
        }
    }

    let mut parent: HashMap<String, String> = HashMap::new();
    fn find(parent: &mut HashMap<String, String>, x: &str) -> String {
        let mut root = x.to_string();
        while parent.get(&root).is_some_and(|r| r != &root) {
            root = parent[&root].clone();
        }
        let mut cur = x.to_string();
        while let Some(next) = parent.get(&cur).cloned() {
            if next == root {
                break;
            }
            parent.insert(cur.clone(), root.clone());
            cur = next;
        }
        root
    }
    let candidate_keys: Vec<Vec<String>> = candidates
        .iter()
        .map(|(acc, _)| identity_keys("kiro", acc))
        .collect();
    for keys in &candidate_keys {
        for k in keys {
            parent.entry(k.clone()).or_insert_with(|| k.clone());
        }
        for k in keys.iter().skip(1) {
            let ra = find(&mut parent, &keys[0]);
            let rb = find(&mut parent, k);
            if ra != rb {
                parent.insert(ra, rb);
            }
        }
    }

    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    let mut ungrouped: Vec<usize> = Vec::new();
    for (i, keys) in candidate_keys.iter().enumerate() {
        if keys.is_empty() {
            ungrouped.push(i);
        } else {
            let root = find(&mut parent, &keys[0]);
            groups.entry(root).or_default().push(i);
        }
    }

    let mut merged: Vec<(AccountFile, String)> = ungrouped
        .into_iter()
        .map(|i| candidates[i].clone())
        .collect();
    for (_, idxs) in groups {
        if idxs.len() == 1 {
            merged.push(candidates[idxs[0]].clone());
            continue;
        }
        merged.push(merge_kiro_group(idxs.iter().map(|i| &candidates[*i])));
    }
    merged
}

/// `mergeKiroCandidateGroup` — freshest expiresAt wins as the base; gaps are
/// filled from siblings; id is re-derived from the merged identity.
fn merge_kiro_group<'a>(
    group: impl Iterator<Item = &'a (AccountFile, String)>,
) -> (AccountFile, String) {
    let members: Vec<&(AccountFile, String)> = group.collect();
    let base_idx = members
        .iter()
        .enumerate()
        .max_by_key(|(_, (acc, _))| {
            acc.field_str("expiresAt")
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
                .unwrap_or(0)
        })
        .map(|(i, _)| i)
        .unwrap_or(0);
    let mut base = members[base_idx].0.clone();
    for (sibling, _) in &members {
        let fill = |fields: &mut JsonMap, key: &str| {
            if fields.get(key).is_none()
                && let Some(v) = sibling.fields.get(key)
            {
                fields.insert(key.to_string(), v.clone());
            }
        };
        for key in [
            "refreshToken",
            "accessToken",
            "clientId",
            "clientSecret",
            "region",
            "apiRegion",
            "profileArn",
        ] {
            fill(&mut base.fields, key);
        }
        if base.email.is_none() {
            base.email = sibling.email.clone();
        }
        if base.label.is_none() {
            base.label = sibling.label.clone();
        }
    }
    base.id = kiro_stable_id_parts(
        base.field_str("profileArn").unwrap_or(""),
        base.field_str("refreshToken").unwrap_or(""),
        base.field_str("accessToken").unwrap_or(""),
    );
    if base.email.is_some()
        && (base.label.is_none() || base.label.as_deref() == Some(base.id.as_str()))
    {
        base.label = base.email.clone();
    }
    let mut seen = HashSet::new();
    let source = members
        .iter()
        .map(|(_, s)| s.as_str())
        .filter(|s| seen.insert(*s))
        .collect::<Vec<_>>()
        .join("+");
    (base, source)
}

fn scan_kiro() -> Vec<(AccountFile, String)> {
    let Some(home) = home::home_dir() else {
        return Vec::new();
    };
    let mut out: Vec<(AccountFile, String)> = Vec::new();

    let kiro_json = home.join(".aws/sso/cache/kiro-auth-token.json");
    if let Some(acc) = kiro_from_json(&kiro_json, "Kiro IDE credentials") {
        out.push((acc, "json".into()));
    }
    for acc in kiro_from_account_manager(
        &home.join("Library/Application Support/kiro-account-manager/kiro-accounts.backup.json"),
    ) {
        out.push((acc, "account-manager".into()));
    }
    let sso_cache = home.join(".aws/sso/cache");
    if let Ok(rd) = fs::read_dir(&sso_cache) {
        let mut names: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| n.ends_with(".json") && n != "kiro-auth-token.json")
            .collect();
        names.sort();
        for name in names {
            if let Some(acc) =
                kiro_from_json(&sso_cache.join(&name), &format!("AWS SSO cache {name}"))
            {
                out.push((acc, "json".into()));
            }
        }
    }
    for db in [
        home.join("Library/Application Support/kiro-cli/data.sqlite3"),
        home.join("Library/Application Support/amazon-q/data.sqlite3"),
        home.join(".local/share/kiro-cli/data.sqlite3"),
        home.join(".local/share/amazon-q/data.sqlite3"),
    ] {
        if let Some(acc) = kiro_from_sqlite(&db) {
            out.push((acc, "sqlite".into()));
        }
    }
    dedupe_kiro(out, read_local_kiro_profile_arn(&home))
}

// ==================== trae / traework ====================

const TRAE_AUTH_KEY: &str = "iCubeAuthInfo://icube.cloudide";
const TRAEWORK_DEVICE_PREFIX: &str = "iCubeAuthInfo://icube-dc:";

/// Trae storage.json paths — macOS appSupport + XDG + %APPDATA% variants and
/// the `/^Trae(?! CN)/i` glob for renamed international builds.
fn trae_storage_paths(home: &Path) -> Vec<PathBuf> {
    let app_support = home.join("Library/Application Support");
    let mut paths = vec![
        app_support.join("Trae/User/globalStorage/storage.json"),
        app_support.join("Trae Beta/User/globalStorage/storage.json"),
        home.join(".config/Trae/User/globalStorage/storage.json"),
        home.join(".config/trae/User/globalStorage/storage.json"),
    ];
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push(Path::new(&appdata).join("Trae/User/globalStorage/storage.json"));
        paths.push(Path::new(&appdata).join("Trae Beta/User/globalStorage/storage.json"));
    }
    if let Ok(rd) = fs::read_dir(&app_support) {
        for name in rd
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
        {
            if name.to_ascii_lowercase().starts_with("trae")
                && !name.to_ascii_lowercase().starts_with("trae cn")
            {
                paths.push(app_support.join(format!("{name}/User/globalStorage/storage.json")));
            }
        }
    }
    existing_files(paths)
}

fn traework_storage_paths(home: &Path) -> Vec<PathBuf> {
    let app_support = home.join("Library/Application Support");
    let mut paths = vec![
        app_support.join("TRAE SOLO CN/User/globalStorage/storage.json"),
        app_support.join("TRAE SOLO/User/globalStorage/storage.json"),
    ];
    if let Ok(rd) = fs::read_dir(&app_support) {
        for name in rd
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
        {
            if name.to_ascii_lowercase().starts_with("trae solo") {
                paths.push(app_support.join(format!("{name}/User/globalStorage/storage.json")));
            }
        }
    }
    if let Ok(appdata) = std::env::var("APPDATA") {
        paths.push(Path::new(&appdata).join("TRAE SOLO CN/User/globalStorage/storage.json"));
        paths.push(Path::new(&appdata).join("TRAE SOLO/User/globalStorage/storage.json"));
    }
    existing_files(paths)
}

/// The stored value may already be an object, plain JSON text, or the
/// AES-CBC-wrapped byteCrypto form — try each representation.
fn parse_stored_user_info(raw: Option<&Value>) -> Option<Value> {
    match raw? {
        v @ Value::Object(_) => Some(v.clone()),
        Value::String(s) => {
            for candidate in [s.clone(), decrypt_trae_storage(s).unwrap_or_default()] {
                if candidate.is_empty() {
                    continue;
                }
                if let Ok(v) = serde_json::from_str::<Value>(&candidate)
                    && v.is_object()
                {
                    return Some(v);
                }
            }
            None
        }
        _ => None,
    }
}

fn scan_trae() -> Vec<(AccountFile, String)> {
    let Some(home) = home::home_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for path in trae_storage_paths(&home) {
        let Some(storage) = read_json_file(&path) else {
            continue;
        };
        let source = if path.to_string_lossy().contains("/Trae/") {
            "trae_storage"
        } else {
            "trae_storage_alt"
        };
        let Some(info) = parse_stored_user_info(storage.get(TRAE_AUTH_KEY)) else {
            continue;
        };
        let country = pick_str(&info, &["aiRegion", "region", "countryCode"]);
        let country = if country.is_empty() {
            pick_str(
                info.get("userRegion").unwrap_or(&Value::Null),
                &["_aiRegion", "region"],
            )
        } else {
            country
        };
        let country = if country.is_empty() {
            pick_str(
                info.get("account").unwrap_or(&Value::Null),
                &["storeRegion", "storeCountryCode"],
            )
        } else {
            country
        }
        .to_uppercase();
        let refresh = pick_str(&info, &["refreshToken"]);
        let jwt = strip_cloud_ide_jwt(&pick_str(&info, &["token"]));
        if jwt.is_empty() && refresh.is_empty() {
            continue;
        }
        let user_id = pick_str(&info, &["userId"]);
        let id = if !user_id.is_empty() {
            format!("trae-user-{}", sha12(&user_id))
        } else if !refresh.is_empty() {
            format!("trae-refresh-{}", sha12(&refresh))
        } else {
            format!("trae-jwt-{}", sha12(&jwt))
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let email = normalize_email(info.pointer("/account/email"));
        let username = pick_str(info.get("account").unwrap_or(&Value::Null), &["username"]);
        let mut acc = AccountFile {
            id,
            label: Some(if username.is_empty() {
                "Trae local session".to_string()
            } else {
                username
            }),
            email,
            enabled: true,
            ..Default::default()
        };
        put(&mut acc.fields, "jwtToken", jwt);
        put(&mut acc.fields, "refreshToken", refresh);
        put_ms(
            &mut acc.fields,
            "tokenExpiresAt",
            epoch_ms(info.get("expiredAt")),
        );
        put_ms(
            &mut acc.fields,
            "refreshExpiresAt",
            epoch_ms(info.get("refreshExpiredAt")),
        );
        put(&mut acc.fields, "userId", user_id);
        put(&mut acc.fields, "countryCode", country);
        put(&mut acc.fields, "authType", "trae-local-storage".into());
        put_opt(
            &mut acc.fields,
            "authBaseUrl",
            normalize_auth_host(
                info.get("host").unwrap_or(&Value::Null),
                &[".traeapi.us", ".trae.ai"],
            ),
        );
        out.push((acc, source.to_string()));
    }
    out
}

fn scan_traework() -> Vec<(AccountFile, String)> {
    let Some(home) = home::home_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for path in traework_storage_paths(&home) {
        let Some(storage) = read_json_file(&path) else {
            continue;
        };
        let Some(info) = parse_stored_user_info(storage.get(TRAE_AUTH_KEY)) else {
            continue;
        };
        // `iCubeAuthInfo://icube-dc:<id>` — the numeric x-device-id.
        let device_id = storage.as_object().and_then(|m| {
            m.keys().find_map(|k| {
                k.strip_prefix(TRAEWORK_DEVICE_PREFIX)
                    .map(str::trim)
                    .filter(|id| id.len() >= 6 && id.chars().all(|c| c.is_ascii_digit()))
                    .map(String::from)
            })
        });
        let country = pick_str(
            info.get("userRegion").unwrap_or(&Value::Null),
            &["_aiRegion", "region"],
        );
        let country = if country.is_empty() {
            pick_str(
                info.get("account").unwrap_or(&Value::Null),
                &["storeRegion", "storeCountryCode"],
            )
        } else {
            country
        }
        .to_uppercase();
        let refresh = pick_str(&info, &["refreshToken"]);
        let jwt = strip_cloud_ide_jwt(&pick_str(&info, &["token"]));
        if jwt.is_empty() && refresh.is_empty() {
            continue;
        }
        let user_id = pick_str(&info, &["userId"]);
        let id = if !user_id.is_empty() {
            format!("traework-user-{}", sha12(&user_id))
        } else if !refresh.is_empty() {
            format!("traework-refresh-{}", sha12(&refresh))
        } else {
            format!("traework-jwt-{}", sha12(&jwt))
        };
        if !seen.insert(id.clone()) {
            continue;
        }
        let email = normalize_email(info.pointer("/account/email"));
        let username = pick_str(info.get("account").unwrap_or(&Value::Null), &["username"]);
        let mut acc = AccountFile {
            id,
            label: Some(if username.is_empty() {
                "TraeWork local session".to_string()
            } else {
                username
            }),
            email,
            enabled: true,
            ..Default::default()
        };
        put(&mut acc.fields, "jwtToken", jwt);
        put(&mut acc.fields, "refreshToken", refresh);
        put_ms(
            &mut acc.fields,
            "tokenExpiresAt",
            epoch_ms(info.get("expiredAt")),
        );
        put_ms(
            &mut acc.fields,
            "refreshExpiresAt",
            epoch_ms(info.get("refreshExpiredAt")),
        );
        put(&mut acc.fields, "userId", user_id);
        put(&mut acc.fields, "countryCode", country);
        put(&mut acc.fields, "authType", "traework-local-storage".into());
        put_opt(
            &mut acc.fields,
            "authBaseUrl",
            normalize_auth_host(
                info.get("host").unwrap_or(&Value::Null),
                &[".trae.cn", ".mchost.guru", ".traeapi.us", ".trae.ai"],
            ),
        );
        put_opt(&mut acc.fields, "deviceId", device_id);
        put_opt(
            &mut acc.fields,
            "machineId",
            storage
                .get("telemetry.machineId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from),
        );
        put_opt(
            &mut acc.fields,
            "devDeviceId",
            storage
                .get("telemetry.devDeviceId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from),
        );
        out.push((acc, "traework_storage".to_string()));
    }
    out
}

/// `stripCloudIdeJwtPrefix` — `/^Cloud-IDE-JWT\s+/i`.
fn strip_cloud_ide_jwt(value: &str) -> String {
    let t = value.trim();
    match t.get(..13) {
        Some(p)
            if p.eq_ignore_ascii_case("cloud-ide-jwt")
                && t[13..].starts_with(char::is_whitespace) =>
        {
            t[13..].trim().to_string()
        }
        _ => t.to_string(),
    }
}

/// `decryptTraeStorageValue` — byteCrypto AES-128-CBC: `tc\x05\x10\x00\x00`
/// header + 32-byte random key + ciphertext; plaintext = sha512(payload) ||
/// payload.
fn decrypt_trae_storage(value: &str) -> Option<String> {
    use base64::Engine;
    use cipher::block_padding::Pkcs7;
    use cipher::{BlockModeDecrypt, KeyIvInit};
    use sha2::{Digest, Sha512};
    type Dec = cbc::Decryptor<aes::Aes128>;

    const HEADER: usize = 6;
    const KEY: usize = 32;
    const HASH: usize = 64;
    let data = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .ok()?;
    if data.len() <= HEADER + KEY + 16 || data[..HEADER] != [116, 99, 5, 16, 0, 0] {
        return None;
    }
    let random_key = &data[HEADER..HEADER + KEY];
    let mut secret = [0u8; 64];
    for i in 0..64 {
        secret[i] = TRAE_UK[i] ^ TRAE_JK[i];
    }
    let mut material = Sha512::digest(random_key).to_vec();
    material.extend_from_slice(&secret);
    let expanded = Sha512::digest(&material);
    let mut buf = data[HEADER + KEY..].to_vec();
    let plain = Dec::new_from_slices(&expanded[..16], &expanded[16..32])
        .ok()?
        .decrypt_padded::<Pkcs7>(&mut buf)
        .ok()?;
    if plain.len() < HASH || Sha512::digest(&plain[HASH..]).as_slice() != &plain[..HASH] {
        return None;
    }
    String::from_utf8(plain[HASH..].to_vec()).ok()
}

const TRAE_UK: [u8; 64] = [
    82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
    155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
    238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109,
    139, 209, 37,
];

const TRAE_JK: [u8; 64] = [
    31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
    181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200,
    235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33,
    12, 125,
];

// ==================== workbuddy ====================

/// `scanExternalWorkBuddyAccounts` — `CodeBuddyExtension/Data/Public/auth/*.info`
/// documents (`session.auth` + `session.account`).
fn scan_workbuddy() -> Vec<(AccountFile, String)> {
    let Some(home) = home::home_dir() else {
        return Vec::new();
    };
    let mut dirs =
        vec![home.join("Library/Application Support/CodeBuddyExtension/Data/Public/auth")];
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        dirs.push(Path::new(&local).join("CodeBuddyExtension/Data/Public/auth"));
    }
    let xdg = std::env::var("XDG_DATA_HOME")
        .unwrap_or_else(|_| home.join(".local/share").display().to_string());
    dirs.push(Path::new(&xdg).join("CodeBuddyExtension/Data/Public/auth"));

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for dir in dirs {
        let Ok(rd) = fs::read_dir(&dir) else {
            continue;
        };
        let mut names: Vec<String> = rd
            .flatten()
            .filter_map(|e| e.file_name().to_str().map(String::from))
            .filter(|n| n.ends_with(".info"))
            .collect();
        names.sort();
        for name in names {
            let Some(data) = read_json_file(&dir.join(&name)) else {
                continue;
            };
            let Some(acc) = workbuddy_from_input(&data) else {
                continue;
            };
            if !seen.insert(acc.id.clone()) {
                continue;
            }
            out.push((acc, "workbuddy_auth_file".to_string()));
        }
    }
    out
}

/// `buildWorkBuddyAccountFromInput` — accepts `{session:{auth,account}}` or a
/// flat credentials object.
fn workbuddy_from_input(input: &Value) -> Option<AccountFile> {
    if !input.is_object() {
        return None;
    }
    let session = input
        .get("session")
        .filter(|v| v.is_object())
        .unwrap_or(input);
    let auth = session
        .get("auth")
        .filter(|v| v.is_object())
        .unwrap_or(session);
    let account = session.get("account").filter(|v| v.is_object());

    let access = strip_bearer(&{
        let v = pick_str(auth, &["accessToken", "access_token", "token"]);
        if v.is_empty() {
            pick_str(input, &["accessToken", "access_token", "token"])
        } else {
            v
        }
    });
    let refresh = {
        let v = pick_str(auth, &["refreshToken", "refresh_token"]);
        if v.is_empty() {
            pick_str(input, &["refreshToken", "refresh_token"])
        } else {
            v
        }
    };
    if access.is_empty() && refresh.is_empty() {
        return None;
    }
    let uid = {
        let v = account
            .map(|a| pick_str(a, &["uid", "userId", "user_id"]))
            .unwrap_or_default();
        if v.is_empty() {
            pick_str(input, &["uid", "userId", "user_id"])
        } else {
            v
        }
    };
    let nickname = {
        let v = account
            .map(|a| pick_str(a, &["nickname", "username", "name"]))
            .unwrap_or_default();
        if v.is_empty() {
            pick_str(input, &["nickname", "label", "name"])
        } else {
            v
        }
    };
    let email = normalize_email(
        account
            .and_then(|a| a.get("email").or_else(|| a.get("mail")))
            .or_else(|| input.get("email").or_else(|| input.get("mail"))),
    );
    let id = if !uid.is_empty() {
        format!("workbuddy-user-{}", sha12(&uid))
    } else if !refresh.is_empty() {
        format!("workbuddy-refresh-{}", sha12(&refresh))
    } else {
        format!("workbuddy-token-{}", sha12(&access))
    };
    let label = {
        let v = pick_str(input, &["label", "name"]);
        if !v.is_empty() {
            v
        } else if !nickname.is_empty() {
            nickname.clone()
        } else {
            email
                .clone()
                .unwrap_or_else(|| format!("WorkBuddy {}", &id[id.len().saturating_sub(6)..]))
        }
    };
    let domain = {
        let v = pick_str(auth, &["domain"]);
        let v = if v.is_empty() {
            pick_str(input, &["domain"])
        } else {
            v
        };
        if v.is_empty() {
            crate::providers::workbuddy_auth::DEFAULT_WORKBUDDY_DOMAIN.to_string()
        } else {
            v
        }
    };
    let mut acc = AccountFile {
        id,
        label: Some(label),
        email,
        enabled: true,
        ..Default::default()
    };
    put(&mut acc.fields, "accessToken", access);
    put(&mut acc.fields, "refreshToken", refresh.clone());
    put_ms(
        &mut acc.fields,
        "tokenExpiresAt",
        epoch_ms(
            auth.get("expiresAt")
                .or_else(|| auth.get("expires_at"))
                .or_else(|| input.get("tokenExpiresAt"))
                .or_else(|| input.get("expiresAt")),
        ),
    );
    put_ms(
        &mut acc.fields,
        "refreshExpiresAt",
        epoch_ms(
            auth.get("refreshExpiresAt")
                .or_else(|| auth.get("refresh_expires_at"))
                .or_else(|| input.get("refreshExpiresAt")),
        ),
    );
    put(&mut acc.fields, "uid", uid);
    put_opt(
        &mut acc.fields,
        "enterpriseId",
        account
            .map(|a| pick_str(a, &["enterpriseId", "enterprise_id"]))
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let v = pick_str(input, &["enterpriseId"]);
                (!v.is_empty()).then_some(v)
            }),
    );
    put(&mut acc.fields, "nickname", nickname);
    put(&mut acc.fields, "domain", domain);
    put(
        &mut acc.fields,
        "authType",
        if refresh.is_empty() {
            "workbuddy-token".to_string()
        } else {
            "workbuddy-refresh-token".to_string()
        },
    );
    Some(acc)
}

/// `stripBearerPrefix` — `/^Bearer\s+/i`.
fn strip_bearer(value: &str) -> String {
    let t = value.trim();
    match t.get(..6) {
        Some(p) if p.eq_ignore_ascii_case("bearer") && t[6..].starts_with(char::is_whitespace) => {
            t[6..].trim().to_string()
        }
        _ => t.to_string(),
    }
}

// ==================== windsurf ====================

/// `scanExternalWindsurfAccounts` — Windsurf `state.vscdb` ItemTable keys
/// `windsurfAuthStatus` + `codeium.windsurf`.
fn scan_windsurf() -> Vec<(AccountFile, String)> {
    let Some(home) = home::home_dir() else {
        return Vec::new();
    };
    let db_path = home.join("Library/Application Support/Windsurf/User/globalStorage/state.vscdb");
    if !db_path.is_file() {
        return Vec::new();
    }
    let Ok(conn) =
        rusqlite::Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
    else {
        return Vec::new();
    };
    let mut values: HashMap<String, Value> = HashMap::new();
    let Ok(mut stmt) = conn.prepare(
        "SELECT key, value FROM ItemTable WHERE key IN ('windsurfAuthStatus', 'codeium.windsurf')",
    ) else {
        return Vec::new();
    };
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map(|r| r.flatten().collect::<Vec<_>>())
        .unwrap_or_default();
    for (k, v) in rows {
        if let Ok(parsed) = serde_json::from_str::<Value>(&v) {
            values.insert(k, parsed);
        }
    }
    let auth = values
        .get("windsurfAuthStatus")
        .cloned()
        .unwrap_or(Value::Null);
    let api_key = pick_str(&auth, &["apiKey"]);
    if api_key.is_empty() {
        return Vec::new();
    }
    let storage = values
        .get("codeium.windsurf")
        .cloned()
        .unwrap_or(Value::Null);
    let email = {
        let v = pick_str(&storage, &["lastLoginEmail"]);
        if v.is_empty() {
            normalize_email(auth.get("email"))
        } else {
            normalize_email_str(&v)
        }
    };
    let label = email.clone().unwrap_or_else(|| {
        let name = pick_str(&auth, &["name"]);
        if name.is_empty() {
            "Windsurf local session".to_string()
        } else {
            name
        }
    });
    let mut acc = AccountFile {
        id: format!("windsurf-{}", sha256_short(&api_key)),
        label: Some(label),
        email,
        enabled: true,
        ..Default::default()
    };
    put(&mut acc.fields, "apiKey", api_key);
    put(
        &mut acc.fields,
        "apiServerUrl",
        pick_str(&storage, &["apiServerUrl"]),
    );
    put(
        &mut acc.fields,
        "inferenceApiServerUrl",
        pick_str(&storage, &["inferenceApiServerUrl"]),
    );
    put(&mut acc.fields, "authType", "windsurf-local-state".into());
    vec![(acc, "windsurf_state".into())]
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
