//! Windsurf credential scan — the IDE's sqlite state DB.

use std::collections::HashMap;

use serde_json::Value;

use crate::apikey::sha256_short;
use crate::cli_login::pick_str;
use crate::types::AccountFile;

use super::{normalize_email, normalize_email_str, put};

pub(super) fn scan_windsurf() -> Vec<(AccountFile, String)> {
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
