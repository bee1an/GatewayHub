//! WorkBuddy auth — port of `providers/workbuddy/client.ts` + `constants.ts`
//! + `localState.ts` (product.json model catalog). Token refresh via
//! POST /v2/plugin/auth/token/refresh with X-Refresh-Token.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::pool::now_ms;
use crate::types::AccountFile;

pub const DEFAULT_WORKBUDDY_BACKEND: &str = "https://copilot.tencent.com";
pub const DEFAULT_WORKBUDDY_BILLING_HOSTS: &[&str] = &["www.workbuddy.cn", "www.codebuddy.cn"];
pub const DEFAULT_WORKBUDDY_DOMAIN: &str = "www.workbuddy.cn";
pub const DEFAULT_WORKBUDDY_MODEL: &str = "auto";
pub const WORKBUDDY_CHAT_PATH: &str = "/v2/chat/completions";
pub const WORKBUDDY_TOKEN_REFRESH_PATH: &str = "/v2/plugin/auth/token/refresh";
pub const WORKBUDDY_CHECKIN_STATUS_PATH: &str = "/v2/billing/meter/checkin-activity-status";
pub const WORKBUDDY_CHECKIN_STATUS_LEGACY_PATH: &str = "/v2/billing/meter/checkin-status";
pub const WORKBUDDY_CHECKIN_CLAIM_PATH: &str = "/v2/billing/meter/daily-checkin";
pub const WORKBUDDY_CREDITS_SUMMARY_PATH: &str = "/billing/meter/get-user-resource-summary";
pub const WORKBUDDY_USER_AGENT: &str = "WorkBuddy/GatewayHub";

pub const WORKBUDDY_BUILT_IN_MODELS: &[&str] = &[
    "auto",
    "default",
    "default-1.1",
    "default-1.2",
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "deepseek-v3-2-volc",
    "deepseek-v3-1-volc",
    "deepseek-v3-1-lkeap",
    "deepseek-v3-1",
    "deepseek-v3-0324-lkeap",
    "deepseek-r1-0528-lkeap",
    "minimax-m2.5",
    "minimax-m3",
    "minimax-m2.7",
    "glm-5.2",
    "glm-5.1",
    "glm-5.0",
    "glm-5.0-turbo",
    "glm-5v-turbo",
    "glm-4.7",
    "glm-4.6",
    "glm-4.6v",
    "kimi-k3-1",
    "kimi-k2.7",
    "kimi-k2.6",
    "kimi-k2.5",
    "kimi-k2-thinking",
    "kimi-k2-instruct-taiji",
    "hy3",
    "hy3-preview",
    "hunyuan-chat",
    "hunyuan-2.0-thinking",
    "hunyuan-2.0-instruct",
    "kling-v3-i2v",
];

pub fn normalize_workbuddy_model(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        DEFAULT_WORKBUDDY_MODEL.into()
    } else {
        trimmed.to_string()
    }
}

/// `buildWorkBuddyHeaders`.
pub fn build_workbuddy_headers(account: &AccountFile, token: &str) -> Vec<(String, String)> {
    let f = |k: &str| {
        account
            .fields
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let domain = {
        let d = f("domain");
        if d.is_empty() {
            DEFAULT_WORKBUDDY_DOMAIN.into()
        } else {
            d
        }
    };
    let mut headers = vec![
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "application/json".into()),
        ("authorization".into(), format!("Bearer {token}")),
        ("x-user-id".into(), f("uid")),
        ("x-domain".into(), domain),
        ("user-agent".into(), WORKBUDDY_USER_AGENT.into()),
    ];
    let enterprise = f("enterpriseId");
    if !enterprise.is_empty() {
        headers.push(("x-enterprise-id".into(), enterprise.clone()));
        headers.push(("x-tenant-id".into(), enterprise));
    }
    headers
}

#[derive(Debug)]
pub struct WorkBuddyAuthError(pub String, pub u16, pub bool);
impl std::fmt::Display for WorkBuddyAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for WorkBuddyAuthError {}

#[derive(Debug, Clone, Default)]
pub struct WorkBuddyTokenSnapshot {
    pub access_token: String,
    pub refresh_token: String,
    pub token_expires_at: i64,
    pub refresh_expires_at: i64,
    pub domain: String,
}

struct AuthInner {
    snap: WorkBuddyTokenSnapshot,
}

pub struct WorkBuddyAuth {
    account_id: String,
    uid: String,
    domain: String,
    inner: Mutex<AuthInner>,
    client: reqwest::Client,
    backend: String,
    on_change: Option<Arc<dyn Fn(&str, &WorkBuddyTokenSnapshot) + Send + Sync>>,
}

impl WorkBuddyAuth {
    pub fn new(
        account: &AccountFile,
        backend: &str,
        client: reqwest::Client,
        on_change: Option<Arc<dyn Fn(&str, &WorkBuddyTokenSnapshot) + Send + Sync>>,
    ) -> Self {
        let f = |k: &str| {
            account
                .fields
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let num = |k: &str| account.fields.get(k).and_then(Value::as_i64).unwrap_or(0);
        Self {
            account_id: account.id.clone(),
            uid: f("uid"),
            domain: f("domain"),
            inner: Mutex::new(AuthInner {
                snap: WorkBuddyTokenSnapshot {
                    access_token: f("accessToken"),
                    refresh_token: f("refreshToken"),
                    token_expires_at: num("tokenExpiresAt"),
                    refresh_expires_at: num("refreshExpiresAt"),
                    domain: f("domain"),
                },
            }),
            client,
            backend: backend.to_string(),
            on_change,
        }
    }

    pub async fn auth_type(&self) -> &'static str {
        if self.inner.lock().await.snap.refresh_token.is_empty() {
            "workbuddy-token"
        } else {
            "workbuddy-refresh-token"
        }
    }

    pub async fn expires_at_iso(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        (inner.snap.token_expires_at > 0).then(|| {
            chrono::DateTime::from_timestamp_millis(inner.snap.token_expires_at)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default()
        })
    }

    /// `getAccessToken` — 5min expiry skew.
    pub async fn get_access_token(&self) -> anyhow::Result<String> {
        {
            let inner = self.inner.lock().await;
            if !inner.snap.access_token.is_empty() && !expires_soon(inner.snap.token_expires_at) {
                return Ok(inner.snap.access_token.clone());
            }
            if inner.snap.refresh_token.is_empty() {
                if !inner.snap.access_token.is_empty() {
                    return Ok(inner.snap.access_token.clone());
                }
                return Err(WorkBuddyAuthError(
                    "No WorkBuddy access or refresh token available".into(),
                    0,
                    true,
                )
                .into());
            }
        }
        self.refresh().await
    }

    /// `refreshWithWorkBuddy` — X-Refresh-Token header, '{}' body.
    async fn refresh(&self) -> anyhow::Result<String> {
        let mut inner = self.inner.lock().await;
        if !inner.snap.access_token.is_empty() && !expires_soon(inner.snap.token_expires_at) {
            return Ok(inner.snap.access_token.clone());
        }
        let url = format!(
            "{}{}",
            self.backend.trim_end_matches('/'),
            WORKBUDDY_TOKEN_REFRESH_PATH
        );
        let domain = if inner.snap.domain.is_empty() {
            if self.domain.is_empty() {
                DEFAULT_WORKBUDDY_DOMAIN.into()
            } else {
                self.domain.clone()
            }
        } else {
            inner.snap.domain.clone()
        };
        let res = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("accept", "application/json")
            .header("x-refresh-token", &inner.snap.refresh_token)
            .header("x-auth-refresh-source", "plugin")
            .header("x-user-id", &self.uid)
            .header("x-domain", &domain)
            .header("user-agent", WORKBUDDY_USER_AGENT)
            .timeout(Duration::from_secs(20))
            .body("{}")
            .send()
            .await?;
        let status = res.status().as_u16();
        let payload: Value = res.json().await.unwrap_or(json!({}));
        let code = payload.get("code").or_else(|| payload.get("Code"));
        let failed = status >= 400
            || code.is_some_and(|c| {
                !c.is_null() && !(c.as_i64() == Some(0) || c.as_str() == Some("0"))
            });
        if failed {
            let text = stringify_payload(&payload);
            let permanent = status == 401
                || status == 403
                || regex::Regex::new(r"invalid|expired")
                    .unwrap()
                    .is_match(&text);
            return Err(WorkBuddyAuthError(
                format!(
                    "WorkBuddy token refresh failed: HTTP {status} {}",
                    &text[..text.len().min(500)]
                ),
                status,
                permanent,
            )
            .into());
        }
        let data = payload
            .get("data")
            .or_else(|| payload.get("Data"))
            .unwrap_or(&payload);
        let snap = parse_token_payload(data);
        if snap.access_token.is_empty() {
            return Err(WorkBuddyAuthError(
                format!(
                    "WorkBuddy token refresh returned no token: {}",
                    &stringify_payload(&payload)[..stringify_payload(&payload).len().min(500)]
                ),
                0,
                false,
            )
            .into());
        }
        inner.snap = snap.clone();
        let account_id = self.account_id.clone();
        drop(inner);
        if let Some(cb) = &self.on_change {
            cb(&account_id, &snap);
        }
        Ok(snap.access_token)
    }
}

fn expires_soon(expires_at_ms: i64) -> bool {
    expires_at_ms > 0 && now_ms() + 5 * 60_000 > expires_at_ms
}

/// `parseTokenPayload` — expiresAt epoch ms or expiresIn seconds-from-now.
fn parse_token_payload(data: &Value) -> WorkBuddyTokenSnapshot {
    let pick = |keys: &[&str]| {
        keys.iter()
            .filter_map(|k| data.get(*k).and_then(Value::as_str))
            .map(str::trim)
            .find(|s| !s.is_empty())
            .unwrap_or("")
            .to_string()
    };
    let expiry = |epoch_keys: &[&str], seconds_keys: &[&str]| {
        for k in epoch_keys {
            if let Some(v) = data.get(*k)
                && let Some(e) = normalize_epoch(v)
            {
                return e;
            }
        }
        for k in seconds_keys {
            if let Some(s) = data.get(*k).and_then(Value::as_f64)
                && s > 0.0
            {
                return now_ms() + (s * 1000.0) as i64;
            }
        }
        0
    };
    WorkBuddyTokenSnapshot {
        access_token: pick(&["accessToken", "access_token", "token"]),
        refresh_token: pick(&["refreshToken", "refresh_token"]),
        token_expires_at: expiry(&["expiresAt", "expires_at"], &["expiresIn"]),
        refresh_expires_at: expiry(
            &["refreshExpiresAt", "refresh_expires_at"],
            &["refreshExpiresIn"],
        ),
        domain: pick(&["domain"]),
    }
}

fn normalize_epoch(value: &Value) -> Option<i64> {
    let n = value
        .as_i64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<i64>().ok()));
    if let Some(n) = n
        && n > 0
    {
        return Some(if n < 1_000_000_000_000 { n * 1000 } else { n });
    }
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.timestamp_millis())
}

fn stringify_payload(payload: &Value) -> String {
    payload
        .get("rawText")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(payload).unwrap_or_else(|_| "null".into()))
}

// ---------------------------------------------------------------------------
// localState.ts — product.json catalog
// ---------------------------------------------------------------------------

const NON_CHAT_MODEL_TAGS: &[&str] = &["text-to-image", "image-to-image", "text-to-video"];
const INTERNAL_MODEL_HINTS: &[&str] = &["completion", "rewrite", "jump", "codewise"];

/// `loadWorkBuddyProductModels`.
pub fn load_workbuddy_product_models(product_json_path: &str) -> Vec<String> {
    for path in candidate_product_json_paths(product_json_path) {
        if let Ok(text) = std::fs::read_to_string(&path)
            && let Ok(data) = serde_json::from_str::<Value>(&text)
        {
            let models = extract_chat_model_ids(&data);
            if !models.is_empty() {
                return models;
            }
        }
    }
    Vec::new()
}

/// `extractChatModelIds`.
pub fn extract_chat_model_ids(data: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for model in data
        .get("models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let id = model
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }
        if model
            .get("tags")
            .and_then(Value::as_array)
            .is_some_and(|tags| {
                tags.iter()
                    .filter_map(Value::as_str)
                    .any(|t| NON_CHAT_MODEL_TAGS.contains(&t))
            })
        {
            continue;
        }
        if model.get("vendor").and_then(Value::as_str) == Some("tencent") {
            continue;
        }
        let lower = id.to_lowercase();
        if INTERNAL_MODEL_HINTS.iter().any(|h| lower.contains(h)) {
            continue;
        }
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

fn candidate_product_json_paths(product_json_path: &str) -> Vec<String> {
    let mut paths = Vec::new();
    if !product_json_path.trim().is_empty() {
        paths.push(product_json_path.trim().to_string());
    }
    #[cfg(target_os = "macos")]
    {
        paths.push(
            "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json"
                .into(),
        );
        paths.push(
            "/Applications/WorkBuddy.app/Contents/Resources/app.asar/cli/product.json".into(),
        );
    }
    if let Some(home) = dirs::home_dir() {
        paths.push(
            home.join(".local/share/WorkBuddy/cli/product.json")
                .to_string_lossy()
                .to_string(),
        );
    }
    paths.push("/opt/WorkBuddy/resources/app.asar.unpacked/cli/product.json".into());
    paths
}
