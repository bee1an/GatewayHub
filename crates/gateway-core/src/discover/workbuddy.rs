//! WorkBuddy credential scan — the `workbuddy_auth_file` JSON, normalized
//! into an `AccountFile` candidate.

use std::collections::HashSet;
use std::fs;
use std::path::Path;

use serde_json::Value;

use crate::cli_login::pick_str;
use crate::types::AccountFile;

use super::{epoch_ms, normalize_email, put, put_ms, put_opt, read_json_file, sha12};

pub(super) fn scan_workbuddy() -> Vec<(AccountFile, String)> {
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
