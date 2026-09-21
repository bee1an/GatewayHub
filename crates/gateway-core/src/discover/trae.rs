//! Trae / TraeWork credential scan — iCube auth blobs in each app's
//! `storage.json` (TraeWork's live under a `icube-dc:` device prefix), with
//! the AES-decrypted fallback for Trae's wrapped payload.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::cli_login::pick_str;
use crate::types::AccountFile;

use super::{
    epoch_ms, existing_files, normalize_auth_host, normalize_email, put, put_ms, put_opt,
    read_json_file, sha12,
};

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

pub(super) fn scan_trae() -> Vec<(AccountFile, String)> {
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

pub(super) fn scan_traework() -> Vec<(AccountFile, String)> {
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
