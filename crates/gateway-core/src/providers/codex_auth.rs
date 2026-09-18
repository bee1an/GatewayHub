//! Codex OAuth auth — port of `providers/codex/auth.ts` + `normalize.ts`.
//! Access token is a short-lived JWT (exp from the token itself); the
//! refresh token hits `auth.openai.com/oauth/token`. Refreshes are deduped
//! per account; permanent 401/403 failures are cached to avoid spamming.

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine;
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::pool::now_ms;
use crate::types::AccountFile;

pub const OPENAI_TOKEN_URL: &str = "https://auth.openai.com/oauth/token";
pub const OPENAI_OAUTH_CLIENT_ID: &str = "app_EMoamEZ73f0CkXaXp7hrann";
pub const CODEX_ORIGINATOR: &str = "codex_cli_rs";
pub const CODEX_USER_AGENT: &str = "gatewayhub-codex";

const OAI_AUTH_NS: &str = "https://api.openai.com/auth.";
const OAI_PROFILE_NS: &str = "https://api.openai.com/profile.";

/// `CodexAuthRefreshError` — `permanent` marks unrecoverable refresh failures.
#[derive(Debug)]
pub struct CodexAuthError {
    pub message: String,
    pub status: u16,
    pub permanent: bool,
}

impl std::fmt::Display for CodexAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}
impl std::error::Error for CodexAuthError {}

#[derive(Debug, Clone, Default)]
pub struct AuthSnapshot {
    pub access_token: String,
    pub refresh_token: String,
    pub id_token: String,
    pub gpt_web_account_id: String,
    pub expires_at_ms: i64,
    pub last_refresh_iso: String,
    pub subscription_active_until: String,
    pub email: String,
    pub name: String,
}

#[derive(Default)]
struct AuthInner {
    snap: AuthSnapshot,
    /// Cached permanent failure so we don't hammer a dead refresh token.
    permanent_failure: Option<(String, String)>, // (refresh_token, error message)
}

pub struct CodexAuth {
    account_id: String,
    inner: Mutex<AuthInner>,
    /// Raw client (no base URL — token endpoint is a fixed absolute URL).
    client: reqwest::Client,
    refresh_skew_ms: i64,
    on_change: Option<Arc<dyn Fn(&str, &AuthSnapshot) + Send + Sync>>,
}

impl CodexAuth {
    pub fn new(
        account: &AccountFile,
        refresh_skew_seconds: u64,
        client: reqwest::Client,
        on_change: Option<Arc<dyn Fn(&str, &AuthSnapshot) + Send + Sync>>,
    ) -> Self {
        let access_token = field(account, "accessToken");
        let id_token = field(account, "idToken");
        let snap = AuthSnapshot {
            access_token: access_token.clone(),
            refresh_token: field(account, "refreshToken"),
            id_token: id_token.clone(),
            gpt_web_account_id: {
                let stored = field(account, "gptWebAccountId");
                if !stored.is_empty() {
                    stored
                } else {
                    resolve_gpt_web_account_id(&access_token, &id_token, "").unwrap_or_default()
                }
            },
            expires_at_ms: account
                .fields
                .get("expiresAt")
                .and_then(Value::as_i64)
                .or_else(|| resolve_access_token_expiry(&access_token))
                .unwrap_or(0),
            last_refresh_iso: field(account, "lastRefresh"),
            subscription_active_until: field(account, "subscriptionActiveUntil"),
            email: account.email.clone().unwrap_or_default(),
            name: field(account, "name"),
        };
        Self {
            account_id: account.id.clone(),
            inner: Mutex::new(AuthInner {
                snap,
                ..Default::default()
            }),
            client,
            refresh_skew_ms: refresh_skew_seconds as i64 * 1000,
            on_change,
        }
    }

    pub fn auth_type(&self) -> &'static str {
        "gptWeb-oauth"
    }

    pub async fn expires_at_iso(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        (inner.snap.expires_at_ms > 0).then(|| {
            chrono::DateTime::from_timestamp_millis(inner.snap.expires_at_ms)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default()
        })
    }

    /// `getAccessToken` — return the cached JWT or refresh when it expires
    /// inside the skew window. Concurrent callers share one refresh via the
    /// mutex + `refresh_in_flight` flag.
    pub async fn get_access_token(&self) -> Result<String, CodexAuthError> {
        {
            let inner = self.inner.lock().await;
            if !inner.snap.access_token.is_empty()
                && !expires_soon(&inner.snap, self.refresh_skew_ms)
            {
                return Ok(inner.snap.access_token.clone());
            }
            if inner.snap.refresh_token.is_empty() {
                if !inner.snap.access_token.is_empty() {
                    return Ok(inner.snap.access_token.clone());
                }
                return Err(CodexAuthError {
                    message: "No access or refresh token available".into(),
                    status: 0,
                    permanent: true,
                });
            }
        }
        self.do_refresh(false).await
    }

    /// `forceRefresh` — used after an upstream 401; skips the
    /// expiry re-check so a revoked-but-unexpired token is actually rotated.
    pub async fn force_refresh(&self) -> Result<String, CodexAuthError> {
        {
            let inner = self.inner.lock().await;
            if inner.snap.refresh_token.is_empty() {
                return Err(CodexAuthError {
                    message: "No refresh token available".into(),
                    status: 0,
                    permanent: true,
                });
            }
        }
        self.do_refresh(true).await
    }

    /// The mutex serializes refreshers — a caller that loses the race
    /// re-checks expiry and returns the fresh token without a second POST.
    async fn do_refresh(&self, force: bool) -> Result<String, CodexAuthError> {
        let mut inner = self.inner.lock().await;
        if !force
            && !inner.snap.access_token.is_empty()
            && !expires_soon(&inner.snap, self.refresh_skew_ms)
        {
            return Ok(inner.snap.access_token.clone());
        }
        if let Some((failed_token, message)) = &inner.permanent_failure {
            if *failed_token == inner.snap.refresh_token {
                return Err(CodexAuthError {
                    message: message.clone(),
                    status: 401,
                    permanent: true,
                });
            }
        }
        let refresh_token = inner.snap.refresh_token.clone();
        match self.refresh_tokens(&refresh_token).await {
            Ok(resp) => match apply_token_response(&mut inner.snap, resp) {
                Ok(token) => {
                    inner.permanent_failure = None;
                    let snap = inner.snap.clone();
                    drop(inner);
                    if let Some(cb) = &self.on_change {
                        cb(&self.account_id, &snap);
                    }
                    Ok(token)
                }
                Err(e) => Err(e),
            },
            Err(e) => {
                if e.permanent {
                    inner.permanent_failure = Some((refresh_token, e.message.clone()));
                }
                Err(e)
            }
        }
    }

    async fn refresh_tokens(&self, refresh_token: &str) -> Result<Value, CodexAuthError> {
        let body = json!({
            "client_id": OPENAI_OAUTH_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        });
        let res = self
            .client
            .post(OPENAI_TOKEN_URL)
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_secs(20))
            .json(&body)
            .send()
            .await
            .map_err(|e| CodexAuthError {
                message: format!("Codex token refresh failed: {e}"),
                status: 0,
                permanent: false,
            })?;
        let status = res.status().as_u16();
        if !res.status().is_success() {
            let text = res.text().await.unwrap_or_default();
            return Err(CodexAuthError {
                message: format!(
                    "Codex token refresh failed: HTTP {} {}",
                    status,
                    text.chars().take(500).collect::<String>()
                ),
                status,
                permanent: status == 401 || status == 403,
            });
        }
        res.json::<Value>().await.map_err(|e| CodexAuthError {
            message: format!("Codex token refresh parse failed: {e}"),
            status: 0,
            permanent: false,
        })
    }

    /// `buildHeaders` — the gptWeb backend's mandatory auth headers.
    pub async fn build_headers(
        &self,
        token: &str,
    ) -> Result<HashMap<String, String>, CodexAuthError> {
        let inner = self.inner.lock().await;
        if inner.snap.gpt_web_account_id.is_empty() {
            return Err(CodexAuthError {
                message: format!(
                    "Codex account {} is missing gptWeb-account-id; please re-login",
                    self.account_id
                ),
                status: 0,
                permanent: true,
            });
        }
        Ok(HashMap::from([
            ("authorization".into(), format!("Bearer {token}")),
            (
                "gptWeb-account-id".into(),
                inner.snap.gpt_web_account_id.clone(),
            ),
            ("originator".into(), CODEX_ORIGINATOR.into()),
            ("user-agent".into(), CODEX_USER_AGENT.into()),
            ("content-type".into(), "application/json".into()),
        ]))
    }

    pub async fn snapshot(&self) -> AuthSnapshot {
        self.inner.lock().await.snap.clone()
    }
}

/// `applyTokenResponse` — write the refresh result into the snapshot.
fn apply_token_response(snap: &mut AuthSnapshot, resp: Value) -> Result<String, CodexAuthError> {
    let access_token = resp
        .get("access_token")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if access_token.is_empty() {
        return Err(CodexAuthError {
            message: "Codex token refresh returned no access_token".into(),
            status: 0,
            permanent: false,
        });
    }
    snap.access_token = access_token.clone();
    if let Some(t) = resp.get("refresh_token").and_then(Value::as_str) {
        snap.refresh_token = t.to_string();
    }
    if let Some(t) = resp.get("id_token").and_then(Value::as_str) {
        snap.id_token = t.to_string();
    }
    snap.last_refresh_iso = now_iso();
    snap.expires_at_ms = resolve_access_token_expiry(&access_token).unwrap_or(0);
    if let Some(id) = resolve_gpt_web_account_id(&snap.access_token, &snap.id_token, "") {
        snap.gpt_web_account_id = id;
    }
    if let Some(sub) = resolve_subscription_active_until(&snap.id_token) {
        snap.subscription_active_until = sub;
    }
    let (email, name) = resolve_profile(&snap.id_token, &snap.access_token);
    if !email.is_empty() {
        snap.email = email;
    }
    if !name.is_empty() {
        snap.name = name;
    }
    Ok(access_token)
}

fn field(account: &AccountFile, key: &str) -> String {
    account
        .fields
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn expires_soon(snap: &AuthSnapshot, skew_ms: i64) -> bool {
    if snap.expires_at_ms == 0 {
        return true;
    }
    snap.expires_at_ms - now_ms() <= skew_ms
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

// --- JWT helpers (normalize.ts ports, no signature verification) ---

pub fn decode_jwt_payload(token: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn pick_claim<'a>(claims: &'a Value, prefix: &str, key: &str) -> Option<&'a Value> {
    claims
        .get(format!("{prefix}{key}"))
        .or_else(|| claims.get(key))
}

pub fn resolve_gpt_web_account_id(
    access_token: &str,
    id_token: &str,
    account_id: &str,
) -> Option<String> {
    if !account_id.is_empty() {
        return Some(account_id.to_string());
    }
    for tok in [id_token, access_token] {
        let Some(claims) = decode_jwt_payload(tok) else {
            continue;
        };
        if let Some(id) = pick_claim(&claims, OAI_AUTH_NS, "chatgpt_account_id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            return Some(id.to_string());
        }
    }
    None
}

pub fn resolve_subscription_active_until(id_token: &str) -> Option<String> {
    let claims = decode_jwt_payload(id_token)?;
    match pick_claim(&claims, OAI_AUTH_NS, "chatgpt_subscription_active_until")? {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => n
            .as_i64()
            .and_then(|s| chrono::DateTime::from_timestamp(s, 0))
            .map(|d| d.to_rfc3339()),
        _ => None,
    }
}

pub fn resolve_access_token_expiry(access_token: &str) -> Option<i64> {
    decode_jwt_payload(access_token)?
        .get("exp")?
        .as_i64()
        .map(|exp| exp * 1000)
}

pub fn resolve_profile(id_token: &str, access_token: &str) -> (String, String) {
    for tok in [id_token, access_token] {
        let Some(claims) = decode_jwt_payload(tok) else {
            continue;
        };
        let email = pick_claim(&claims, OAI_PROFILE_NS, "email")
            .or_else(|| claims.get("email"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let name = pick_claim(&claims, OAI_PROFILE_NS, "name")
            .or_else(|| claims.get("name"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !email.is_empty() || !name.is_empty() {
            return (email, name);
        }
    }
    (String::new(), String::new())
}
