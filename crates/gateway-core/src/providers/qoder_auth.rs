//! Qoder auth — port of `providers/qoder/client.ts` token resolution:
//! PAT (or PAT → jobToken exchange), qodercli AES-128-CBC credential bundle
//! decrypt + deviceToken refresh, plus the model tables from constants.ts.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::pool::now_ms;
use crate::types::AccountFile;

pub const DEFAULT_QODER_MODEL_SERVER_BASE_URL: &str = "https://api2-v2.qoder.sh";
pub const DEFAULT_QODER_LEGACY_API_BASE_URL: &str = "https://api3.qoder.sh";
pub const DEFAULT_QODER_OPENAPI_BASE_URL: &str = "https://openapi.qoder.sh";
pub const MODEL_CHAT_PATH: &str = "/model/v1/chat/completions";
pub const PERSONAL_TOKEN_EXCHANGE_PATH: &str = "/api/v1/jobToken/exchange";
pub const DEVICE_TOKEN_REFRESH_PATH: &str = "/api/v1/deviceToken/refresh";
pub const QUOTA_USAGE_PATH: &str = "/api/v2/quota/usage";
pub const USER_PLAN_PATH: &str = "/api/v2/user/plan";
pub const USER_STATUS_PATH: &str = "/api/v3/user/status";
pub const QODER_CLI_USER_AGENT: &str = "qoder/1.0.19";
pub const DEFAULT_QODER_MODEL: &str = "auto";
const TOKEN_REFRESH_SKEW_MS: i64 = 5 * 60_000;

pub const QODER_DIRECT_MODEL_IDS: &[&str] =
    &["lite", "efficient", "auto", "performance", "ultimate"];

/// (id, label, tier, description) — QODER_KNOWN_MODELS.
pub const QODER_KNOWN_MODELS: &[(&str, &str, &str, &str)] = &[
    (
        "lite",
        "Lite",
        "free",
        "Qoder Lite tier — free lightweight tasks and quick Q&A.",
    ),
    (
        "efficient",
        "Efficient",
        "low",
        "Qoder Efficient tier — low-credit everyday coding and completion.",
    ),
    (
        "auto",
        "Auto",
        "standard",
        "Qoder Auto tier — smart routing for most multi-step coding tasks.",
    ),
    (
        "performance",
        "Performance",
        "high",
        "Qoder Performance tier — challenging engineering work and large codebases.",
    ),
    (
        "ultimate",
        "Ultimate",
        "highest",
        "Qoder Ultimate tier — maximum reasoning and output quality.",
    ),
    (
        "qmodel_latest",
        "Qwen3.7 Max",
        "frontier",
        "Qoder legacy model key for Qwen3.7-Max.",
    ),
    (
        "qmodel",
        "Qwen3.7 Plus",
        "high",
        "Qoder legacy model key for Qwen3.7-Plus.",
    ),
    (
        "qwen3.7-max",
        "Qwen3.7 Max",
        "frontier",
        "Compatibility alias routed to qmodel_latest.",
    ),
    (
        "qwen3.7-plus",
        "Qwen3.7 Plus",
        "high",
        "Compatibility alias routed to qmodel.",
    ),
    (
        "dmodel",
        "DeepSeek-V4-Pro",
        "frontier",
        "Qoder legacy model key for DeepSeek-V4-Pro.",
    ),
    (
        "dfmodel",
        "DeepSeek-V4-Flash",
        "high",
        "Qoder legacy model key for DeepSeek-V4-Flash.",
    ),
    (
        "gm51model",
        "GLM-5.1",
        "frontier",
        "Qoder legacy model key for GLM-5.1.",
    ),
    (
        "kmodel",
        "Kimi-K2.6",
        "high",
        "Qoder legacy model key for Kimi-K2.6.",
    ),
    (
        "mmodel",
        "MiniMax-M3",
        "high",
        "Qoder legacy model key for MiniMax-M3.",
    ),
];

pub const QODER_LEGACY_MODEL_IDS: &[&str] = &[
    "qmodel_latest",
    "qmodel",
    "dmodel",
    "dfmodel",
    "gm51model",
    "kmodel",
    "mmodel",
];

/// (key, display_name, is_vl, is_reasoning, max_input_tokens)
pub const QODER_LEGACY_MODEL_CONFIGS: &[(&str, &str, bool, bool, u64)] = &[
    ("qmodel_latest", "Qwen3.7-Max", true, false, 180_000),
    ("qmodel", "Qwen3.7-Plus", true, false, 180_000),
    ("dmodel", "DeepSeek-V4-Pro", true, false, 128_000),
    ("dfmodel", "DeepSeek-V4-Flash", true, false, 128_000),
    ("gm51model", "GLM-5.1", true, false, 128_000),
    ("kmodel", "Kimi-K2.6", true, false, 128_000),
    ("mmodel", "MiniMax-M3", true, false, 128_000),
];

fn alias_map() -> &'static [(&'static str, &'static str)] {
    &[
        ("claude-opus", "ultimate"),
        ("claude-sonnet", "auto"),
        ("claude-haiku", "efficient"),
        ("qwen3.7-max", "qmodel_latest"),
        ("qwen3.7-plus", "qmodel"),
    ]
}

/// `normalizeQoderModel`.
pub fn normalize_qoder_model(requested: &str) -> String {
    let raw = requested.trim();
    if raw.is_empty() {
        return DEFAULT_QODER_MODEL.into();
    }
    if QODER_DIRECT_MODEL_IDS.contains(&raw) {
        return raw.into();
    }
    let lower = raw.to_lowercase();
    if QODER_DIRECT_MODEL_IDS.contains(&lower.as_str()) {
        return lower;
    }
    if let Some((_, target)) = alias_map().iter().find(|(k, _)| *k == lower) {
        return (*target).to_string();
    }
    if lower.contains("claude") {
        if lower.contains("opus") {
            return "ultimate".into();
        }
        if lower.contains("haiku") {
            return "efficient".into();
        }
        return "auto".into();
    }
    if lower.contains("gpt-4") || lower.contains("gpt4") {
        if lower.contains("mini") {
            return "efficient".into();
        }
        return "auto".into();
    }
    if QODER_LEGACY_MODEL_IDS.contains(&lower.as_str()) {
        return lower;
    }
    lower
}

pub fn is_qoder_legacy_model(model: &str) -> bool {
    QODER_LEGACY_MODEL_IDS.contains(&model)
}

pub fn legacy_model_config(
    model: &str,
) -> Option<&'static (&'static str, &'static str, bool, bool, u64)> {
    QODER_LEGACY_MODEL_CONFIGS
        .iter()
        .find(|(k, ..)| *k == model)
}

pub fn qoder_account_uses_direct_api(account: &AccountFile) -> bool {
    let f = |k: &str| {
        account
            .fields
            .get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    f("personalAccessToken").is_some() || f("qoderCliHome").is_some()
}

#[derive(Debug)]
pub struct QoderHttpError(pub String, pub u16, pub Option<String>);
impl std::fmt::Display for QoderHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for QoderHttpError {}

#[derive(Debug, Clone, Default)]
struct CachedToken {
    access_token: String,
    refresh_token: String,
    expires_at_ms: i64,
}

/// `resolveQoderAccessToken` — PAT straight-through / exchange, or
/// qodercli bundle + deviceToken refresh.
pub struct QoderTokenResolver {
    client: reqwest::Client,
    openapi_base: String,
    pat_cache: Mutex<std::collections::HashMap<String, CachedToken>>,
}

impl QoderTokenResolver {
    pub fn new(client: reqwest::Client, openapi_base: &str) -> Self {
        Self {
            client,
            openapi_base: openapi_base.to_string(),
            pat_cache: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub async fn resolve(&self, account: &AccountFile) -> anyhow::Result<String> {
        let f = |k: &str| {
            account
                .fields
                .get(k)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        };
        if let Some(pat) = f("personalAccessToken") {
            return self.resolve_pat(&pat).await;
        }
        if let Some(home) = f("qoderCliHome") {
            return self.resolve_cli(&home).await;
        }
        Err(QoderHttpError(
            "Qoder direct API requires a Personal Access Token or an imported qodercli auth bundle with a local access token.".into(),
            401,
            Some("missing_token".into()),
        )
        .into())
    }

    async fn resolve_pat(&self, pat: &str) -> anyhow::Result<String> {
        if looks_like_access_token(pat) {
            return Ok(pat.to_string());
        }
        let key = hex_sha256(pat);
        {
            let cache = self.pat_cache.lock().await;
            if let Some(t) = cache.get(&key)
                && !expiring(t.expires_at_ms)
            {
                return Ok(t.access_token.clone());
            }
        }
        let exchanged = self.exchange_personal_token(pat).await?;
        let token = exchanged.access_token.clone();
        self.pat_cache.lock().await.insert(key, exchanged);
        Ok(token)
    }

    async fn exchange_personal_token(&self, pat: &str) -> anyhow::Result<CachedToken> {
        let url = format!("{}{}", self.openapi_base, PERSONAL_TOKEN_EXCHANGE_PATH);
        let res = self
            .client
            .post(&url)
            .header("accept", "application/json")
            .header("user-agent", QODER_CLI_USER_AGENT)
            .timeout(Duration::from_secs(15))
            .json(&json!({ "personal_token": pat }))
            .send()
            .await?;
        let status = res.status().as_u16();
        let data = read_json_response(res, "Qoder PAT exchange").await?;
        let access = pick(&data, &["token", "device_token", "access_token"]);
        if access.is_empty() {
            return Err(QoderHttpError(
                "Qoder PAT exchange response did not contain an access token".into(),
                status,
                None,
            )
            .into());
        }
        Ok(CachedToken {
            access_token: access,
            refresh_token: pick(&data, &["refresh_token", "refreshToken"]),
            expires_at_ms: parse_expires_at(&data),
        })
    }

    /// `resolveQoderCliAccessToken` — decrypt {home}/.qoder/.auth/user with
    /// AES-128-CBC keyed by machine_id[:16], refresh when expiring.
    async fn resolve_cli(&self, home: &str) -> anyhow::Result<String> {
        let loaded = read_cli_credential(home).await?;
        let access = pick(
            &loaded.credential,
            &["access_token", "security_oauth_token"],
        );
        if access.is_empty() {
            return Err(QoderHttpError(
                "Imported Qoder auth bundle does not contain an access token".into(),
                401,
                Some("missing_token".into()),
            )
            .into());
        }
        let expires_at_ms = parse_epoch_secs(
            &loaded
                .credential
                .get("expire_time")
                .cloned()
                .unwrap_or(Value::Null),
        );
        if !expiring(expires_at_ms) {
            return Ok(access);
        }
        let refresh_token = loaded
            .credential
            .get("refresh_token")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if refresh_token.is_empty() {
            if !expired(expires_at_ms) {
                return Ok(access);
            }
            return Err(QoderHttpError(
                "Imported Qoder access token is expired and has no refresh token".into(),
                401,
                Some("token_expired".into()),
            )
            .into());
        }
        match self.refresh_device_token(&refresh_token).await {
            Ok(refreshed) => {
                let mut next = loaded.credential.clone();
                next["security_oauth_token"] = json!(refreshed.access_token);
                next["access_token"] = json!(refreshed.access_token);
                if !refreshed.refresh_token.is_empty() {
                    next["refresh_token"] = json!(refreshed.refresh_token);
                }
                if refreshed.expires_at_ms > 0 {
                    next["expire_time"] = json!(refreshed.expires_at_ms / 1000);
                }
                let blob = encrypt_cli_credential(&next, &loaded.key);
                let _ = tokio::fs::write(&loaded.user_path, blob).await;
                Ok(refreshed.access_token)
            }
            Err(e) => {
                if !expired(expires_at_ms) {
                    return Ok(access);
                }
                Err(e)
            }
        }
    }

    async fn refresh_device_token(&self, refresh_token: &str) -> anyhow::Result<CachedToken> {
        let url = format!("{}{}", self.openapi_base, DEVICE_TOKEN_REFRESH_PATH);
        let res = self
            .client
            .post(&url)
            .header("accept", "application/json")
            .header("user-agent", QODER_CLI_USER_AGENT)
            .timeout(Duration::from_secs(15))
            .json(&json!({ "refresh_token": refresh_token }))
            .send()
            .await?;
        let status = res.status().as_u16();
        let data = read_json_response(res, "Qoder device token refresh").await?;
        let access = pick(&data, &["device_token", "token", "access_token"]);
        if access.is_empty() {
            return Err(QoderHttpError(
                "Qoder token refresh response did not contain an access token".into(),
                status,
                None,
            )
            .into());
        }
        Ok(CachedToken {
            access_token: access,
            refresh_token: pick(&data, &["refresh_token", "refreshToken"]),
            expires_at_ms: parse_expires_at(&data),
        })
    }
}

struct LoadedCredential {
    credential: Value,
    user_path: String,
    key: [u8; 16],
    #[allow(dead_code)]
    machine_id: String,
}

/// `readQoderCliCredential` — {home}/.qoder/.auth/user, AES-128-CBC,
/// key = machine_id[..16] (iv == key).
async fn read_cli_credential(home: &str) -> anyhow::Result<LoadedCredential> {
    use cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
    type Aes128CbcDec = cbc::Decryptor<aes::Aes128>;

    let auth_dir = std::path::Path::new(home).join(".qoder").join(".auth");
    let user_path = auth_dir.join("user");
    let machine_path = auth_dir.join("machine_id");
    let blob = tokio::fs::read_to_string(&user_path).await?;
    let machine_id = tokio::fs::read_to_string(&machine_path)
        .await?
        .trim()
        .to_string();
    let key_text = &machine_id[..machine_id.len().min(16)];
    if key_text.len() != 16 {
        return Err(QoderHttpError(
            "Invalid Qoder machine_id in imported auth bundle".into(),
            401,
            Some("invalid_auth_bundle".into()),
        )
        .into());
    }
    let mut key = [0u8; 16];
    key.copy_from_slice(key_text.as_bytes());
    let raw = base64_decode(blob.trim())?;
    let mut buf = raw;
    let pt = Aes128CbcDec::new(&key.into(), &key.into())
        .decrypt_padded::<Pkcs7>(&mut buf)
        .map_err(|e| anyhow::anyhow!("Qoder credential decrypt failed: {e}"))?
        .to_vec();
    let credential: Value = serde_json::from_slice(&pt)?;
    Ok(LoadedCredential {
        credential,
        user_path: user_path.to_string_lossy().to_string(),
        key,
        machine_id,
    })
}

/// `encryptQoderCredential`.
fn encrypt_cli_credential(credential: &Value, key: &[u8; 16]) -> String {
    use cipher::{BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
    type Aes128CbcEnc = cbc::Encryptor<aes::Aes128>;
    let data = serde_json::to_vec(credential).unwrap_or_default();
    let padded_len = (data.len() / 16 + 1) * 16;
    let mut buf = vec![0u8; padded_len];
    buf[..data.len()].copy_from_slice(&data);
    let ct = Aes128CbcEnc::new(&(*key).into(), &(*key).into())
        .encrypt_padded::<Pkcs7>(&mut buf, data.len())
        .unwrap_or_default()
        .to_vec();
    base64_encode(&ct)
}

fn base64_encode(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(data)
}
fn base64_decode(data: &str) -> anyhow::Result<Vec<u8>> {
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.decode(data)?)
}

async fn read_json_response(res: reqwest::Response, label: &str) -> anyhow::Result<Value> {
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if status >= 400 {
        return Err(QoderHttpError(
            format!("{label} HTTP {status}: {}", &text[..text.len().min(1000)]),
            status,
            None,
        )
        .into());
    }
    serde_json::from_str(if text.is_empty() { "{}" } else { &text }).map_err(|_| {
        QoderHttpError(
            format!(
                "{label} response is not JSON: {}",
                &text[..text.len().min(500)]
            ),
            0,
            None,
        )
        .into()
    })
}

fn looks_like_access_token(token: &str) -> bool {
    regex::Regex::new(r"^(dt|jt)-[A-Za-z0-9_-]+$")
        .unwrap()
        .is_match(token)
}

fn pick(data: &Value, keys: &[&str]) -> String {
    keys.iter()
        .filter_map(|k| data.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

fn parse_epoch_secs(value: &Value) -> i64 {
    value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()))
        .map(|n| if n < 1_000_000_000_000 { n * 1000 } else { n })
        .unwrap_or(0)
}

fn parse_expires_at(data: &Value) -> i64 {
    for k in ["expires_at", "expiresAt", "expire_time", "expireTime"] {
        if let Some(v) = data.get(k) {
            let e = parse_epoch_secs(v);
            if e > 0 {
                return e;
            }
        }
    }
    for k in ["expires_in", "expiresIn"] {
        if let Some(s) = data.get(k).and_then(Value::as_i64)
            && s > 0
        {
            return now_ms() + s * 1000;
        }
    }
    0
}

fn expiring(expires_at_ms: i64) -> bool {
    expires_at_ms > 0 && now_ms() + TOKEN_REFRESH_SKEW_MS > expires_at_ms
}
fn expired(expires_at_ms: i64) -> bool {
    expires_at_ms > 0 && now_ms() > expires_at_ms
}

fn hex_sha256(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

pub type SharedResolver = Arc<QoderTokenResolver>;
