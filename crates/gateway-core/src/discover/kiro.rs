//! Kiro credential scan — `storage.json`, the Kiro Account Manager DB and
//! the IDE's sqlite state; results are deduped and freshness-merged per
//! profile identity.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

use serde_json::{Value, json};

use crate::apikey::sha256_short;
use crate::cli_login::{KIRO_REGISTRATION_KEYS, KIRO_TOKEN_KEYS, normalize_expires_at, pick_str};
use crate::types::{AccountFile, JsonMap};

use super::{identity_keys, iso_from_value, normalize_email, put, put_opt, read_json_file};

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

pub(super) fn scan_kiro() -> Vec<(AccountFile, String)> {
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
