//! Kiro auth — port of `providers/kiro/auth.ts`: kiro_desktop refresh
//! (`prod.{region}.auth.desktop.kiro.dev/refreshToken`) and AWS SSO OIDC
//! refresh (`oidc.{region}.amazonaws.com/token`). Access-only mode never
//! refreshes and refuses expired tokens outright.

use std::sync::Arc;

use serde_json::{Value, json};
use sha2::Digest;
use tokio::sync::Mutex;

use crate::pool::now_ms;
use crate::types::AccountFile;

pub const KIRO_REFRESH_URL_TEMPLATE: &str =
    "https://prod.{region}.auth.desktop.kiro.dev/refreshToken";
pub const AWS_SSO_OIDC_URL_TEMPLATE: &str = "https://oidc.{region}.amazonaws.com/token";
pub const KIRO_RUNTIME_URL_TEMPLATE: &str = "https://runtime.{region}.kiro.dev";
pub const KIRO_API_URL_TEMPLATE: &str = "https://q.{region}.amazonaws.com";

pub fn kiro_refresh_url(region: &str) -> String {
    KIRO_REFRESH_URL_TEMPLATE.replace("{region}", region)
}
pub fn aws_sso_oidc_url(region: &str) -> String {
    AWS_SSO_OIDC_URL_TEMPLATE.replace("{region}", region)
}
pub fn runtime_url(region: &str) -> String {
    KIRO_RUNTIME_URL_TEMPLATE.replace("{region}", region)
}
pub fn api_url(region: &str) -> String {
    KIRO_API_URL_TEMPLATE.replace("{region}", region)
}

/// `machineFingerprint` — sha256(hostname-username-gatewayhub).
pub fn machine_fingerprint() -> String {
    let host = hostname::get()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "unknown".into());
    let who = std::env::var("USER").unwrap_or_else(|_| "unknown".into());
    format!(
        "{:x}",
        sha2::Sha256::digest(format!("{host}-{who}-gatewayhub"))
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KiroAuthType {
    KiroDesktop,
    AwsSsoOidc,
}

#[derive(Debug, Clone, Default)]
pub struct KiroSnapshot {
    pub refresh_token: String,
    pub access_token: String,
    pub expires_at_ms: i64,
    pub profile_arn: String,
    pub client_id: String,
    pub client_secret: String,
}

struct AuthInner {
    snap: KiroSnapshot,
    access_only: bool,
}

pub struct KiroAuth {
    account_id: String,
    inner: Mutex<AuthInner>,
    client: reqwest::Client,
    sso_region: String,
    api_region: String,
    runtime_base_url: Option<String>,
    fingerprint: String,
    auth_type: Mutex<KiroAuthType>,
    on_change: Option<Arc<dyn Fn(&str, &KiroSnapshot) + Send + Sync>>,
}

impl KiroAuth {
    /// `initialize()` — loadFromJson + authType resolution. `path`-based
    /// credential files are a gateway-CLI concern; account-file fields carry
    /// the same keys so we read them directly.
    pub fn new(
        account: &AccountFile,
        region: &str,
        api_region: Option<&str>,
        runtime_base_url: Option<String>,
        client: reqwest::Client,
        on_change: Option<Arc<dyn Fn(&str, &KiroSnapshot) + Send + Sync>>,
    ) -> anyhow::Result<Self> {
        let field = |k: &str| {
            account
                .fields
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let snap = KiroSnapshot {
            refresh_token: field("refreshToken"),
            access_token: field("accessToken"),
            expires_at_ms: parse_iso_ms(&field("expiresAt")).unwrap_or(0),
            profile_arn: field("profileArn"),
            client_id: field("clientId"),
            client_secret: field("clientSecret"),
        };
        let sso_region = {
            let r = field("region");
            if !r.is_empty() { r } else { region.to_string() }
        };
        let api_region = api_region
            .map(str::to_string)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let r = field("apiRegion");
                (!r.is_empty()).then_some(r)
            })
            .unwrap_or_else(|| sso_region.clone());
        let access_only = snap.refresh_token.is_empty() && snap.client_id.is_empty();
        if access_only && snap.access_token.is_empty() {
            anyhow::bail!("Kiro account has no tokens");
        }
        let auth_type = if !snap.client_id.is_empty() && !snap.client_secret.is_empty() {
            KiroAuthType::AwsSsoOidc
        } else {
            KiroAuthType::KiroDesktop
        };
        Ok(Self {
            account_id: account.id.clone(),
            inner: Mutex::new(AuthInner { snap, access_only }),
            client,
            sso_region,
            api_region,
            runtime_base_url,
            fingerprint: machine_fingerprint(),
            auth_type: Mutex::new(auth_type),
            on_change,
        })
    }

    pub async fn auth_type(&self) -> KiroAuthType {
        *self.auth_type.lock().await
    }

    pub fn api_host(&self) -> String {
        self.runtime_base_url
            .clone()
            .unwrap_or_else(|| runtime_url(&self.api_region))
            .trim_end_matches('/')
            .to_string()
    }

    pub fn rest_api_host(&self) -> String {
        api_url(&self.api_region)
    }

    pub async fn profile_arn(&self) -> String {
        self.inner.lock().await.snap.profile_arn.clone()
    }

    pub async fn expires_at_iso(&self) -> Option<String> {
        let inner = self.inner.lock().await;
        (inner.snap.expires_at_ms > 0).then(|| {
            chrono::DateTime::from_timestamp_millis(inner.snap.expires_at_ms)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default()
        })
    }

    /// `getAccessToken` — 10-minute expiry skew; access-only accounts
    /// error instead of handing out a stale token.
    pub async fn get_access_token(&self) -> anyhow::Result<String> {
        {
            let inner = self.inner.lock().await;
            if !inner.snap.access_token.is_empty() && !expiring_soon(inner.snap.expires_at_ms) {
                return Ok(inner.snap.access_token.clone());
            }
            if inner.access_only {
                if expiring_soon(inner.snap.expires_at_ms) {
                    anyhow::bail!(
                        "Access token expired (access-only mode). Please add a new access token."
                    );
                }
                if !inner.snap.access_token.is_empty() {
                    return Ok(inner.snap.access_token.clone());
                }
                anyhow::bail!("Access token is missing (access-only mode).");
            }
        }
        self.start_refresh().await
    }

    pub async fn force_refresh(&self) -> anyhow::Result<String> {
        {
            let inner = self.inner.lock().await;
            if inner.access_only {
                anyhow::bail!("Access token is invalid or expired. Please add a new access token.");
            }
        }
        self.start_refresh().await
    }

    /// Mutex-serialized refresh (TS `refreshInFlight` promise dedup).
    async fn start_refresh(&self) -> anyhow::Result<String> {
        let mut inner = self.inner.lock().await;
        if !inner.snap.access_token.is_empty() && !expiring_soon(inner.snap.expires_at_ms) {
            return Ok(inner.snap.access_token.clone());
        }
        match self.auth_type.lock().await.to_owned() {
            KiroAuthType::KiroDesktop => self.refresh_kiro_desktop(&mut inner).await?,
            KiroAuthType::AwsSsoOidc => self.refresh_aws_sso_oidc(&mut inner).await?,
        }
        if inner.snap.access_token.is_empty() {
            anyhow::bail!("Failed to obtain Kiro access token");
        }
        let token = inner.snap.access_token.clone();
        let snap = inner.snap.clone();
        drop(inner);
        if let Some(cb) = &self.on_change {
            cb(&self.account_id, &snap);
        }
        Ok(token)
    }

    async fn refresh_kiro_desktop(&self, inner: &mut AuthInner) -> anyhow::Result<()> {
        if inner.snap.refresh_token.is_empty() {
            anyhow::bail!("Kiro refresh token is missing");
        }
        let res = self
            .client
            .post(kiro_refresh_url(&self.sso_region))
            .header("content-type", "application/json")
            .header("user-agent", format!("GatewayHub-0.1-{}", self.fingerprint))
            .timeout(std::time::Duration::from_secs(20))
            .json(&json!({ "refreshToken": inner.snap.refresh_token }))
            .send()
            .await?;
        let status = res.status().as_u16();
        if status >= 400 {
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "Kiro Desktop token refresh failed: HTTP {} {}",
                status,
                redact(&text.chars().take(1000).collect::<String>())
            );
        }
        let data: Value = res.json().await?;
        let snap = &mut inner.snap;
        snap.access_token = str_of(&data, "accessToken")
            .or_else(|| str_of(&data, "access_token"))
            .unwrap_or_default();
        if let Some(t) = str_of(&data, "refreshToken").or_else(|| str_of(&data, "refresh_token")) {
            snap.refresh_token = t;
        }
        if let Some(a) = str_of(&data, "profileArn").or_else(|| str_of(&data, "profile_arn")) {
            snap.profile_arn = a;
        }
        let expires_in = num_of(&data, "expiresIn")
            .or_else(|| num_of(&data, "expires_in"))
            .unwrap_or(3600)
            .max(60);
        snap.expires_at_ms = now_ms() + (expires_in - 60) * 1000;
        Ok(())
    }

    async fn refresh_aws_sso_oidc(&self, inner: &mut AuthInner) -> anyhow::Result<()> {
        if inner.snap.refresh_token.is_empty() {
            anyhow::bail!("AWS SSO refresh token is missing");
        }
        if inner.snap.client_id.is_empty() || inner.snap.client_secret.is_empty() {
            anyhow::bail!("AWS SSO clientId/clientSecret are missing");
        }
        let res = self
            .client
            .post(aws_sso_oidc_url(&self.sso_region))
            .header("content-type", "application/json")
            .timeout(std::time::Duration::from_secs(20))
            .json(&json!({
                "grantType": "refresh_token",
                "clientId": inner.snap.client_id,
                "clientSecret": inner.snap.client_secret,
                "refreshToken": inner.snap.refresh_token,
            }))
            .send()
            .await?;
        let status = res.status().as_u16();
        if status >= 400 {
            let text = res.text().await.unwrap_or_default();
            anyhow::bail!(
                "AWS SSO token refresh failed: HTTP {} {}",
                status,
                redact(&text.chars().take(1000).collect::<String>())
            );
        }
        let data: Value = res.json().await?;
        let snap = &mut inner.snap;
        snap.access_token = str_of(&data, "accessToken").unwrap_or_default();
        if let Some(t) = str_of(&data, "refreshToken") {
            snap.refresh_token = t;
        }
        let expires_in = num_of(&data, "expiresIn").unwrap_or(3600).max(60);
        snap.expires_at_ms = now_ms() + (expires_in - 60) * 1000;
        Ok(())
    }

    /// `buildHeaders` for the runtime `generateAssistantResponse` endpoint.
    pub fn build_headers(&self, token: &str) -> Vec<(String, String)> {
        let os = std::env::consts::OS;
        let os_token = if os == "macos" { "darwin" } else { os };
        vec![
            ("authorization".into(), format!("Bearer {token}")),
            ("content-type".into(), "application/x-amz-json-1.0".into()),
            (
                "x-amz-target".into(),
                "AmazonCodeWhispererStreamingService.GenerateAssistantResponse".into(),
            ),
            (
                "user-agent".into(),
                format!(
                    "aws-sdk-js/1.0.27 ua/2.1 os/{os_token} lang/js md/nodejs api/codewhispererstreaming#1.0.27 m/E GatewayHub-0.1-{}",
                    self.fingerprint
                ),
            ),
            (
                "x-amz-user-agent".into(),
                format!("aws-sdk-js/1.0.27 GatewayHub-0.1-{}", self.fingerprint),
            ),
            ("x-amzn-codewhisperer-optout".into(), "true".into()),
            ("x-amzn-kiro-agent-mode".into(), "vibe".into()),
            (
                "amz-sdk-invocation-id".into(),
                uuid::Uuid::new_v4().to_string(),
            ),
            ("amz-sdk-request".into(), "attempt=1; max=3".into()),
        ]
    }

    /// `apiGet` — REST host GET with one 403→force-refresh retry.
    pub async fn api_get(&self, path: &str, params: &[(&str, &str)]) -> anyhow::Result<Value> {
        let os = std::env::consts::OS;
        let os_token = if os == "macos" { "darwin" } else { os };
        let ua = format!(
            "aws-sdk-js/1.0.27 ua/2.1 os/{os_token} lang/js md/nodejs api/codewhispererruntime#1.0.27 m/E KiroIDE 1.0.0 {}",
            self.fingerprint
        );
        let mut url = reqwest::Url::parse(&format!("{}{}", self.rest_api_host(), path))?;
        for (k, v) in params {
            url.query_pairs_mut().append_pair(k, v);
        }
        let do_fetch = |token: &str| {
            self.client
                .get(url.clone())
                .header("authorization", format!("Bearer {token}"))
                .header("user-agent", ua.clone())
                .timeout(std::time::Duration::from_secs(20))
                .send()
        };
        let token = self.get_access_token().await?;
        let mut resp = do_fetch(&token).await?;
        if resp.status().as_u16() == 403 {
            let token = self.force_refresh().await?;
            resp = do_fetch(&token).await?;
        }
        let status = resp.status().as_u16();
        if status >= 400 {
            let text = resp.text().await.unwrap_or_default();
            anyhow::bail!(
                "Kiro API {} failed: HTTP {} {}",
                path,
                status,
                redact(&text.chars().take(500).collect::<String>())
            );
        }
        Ok(resp.json().await?)
    }

    pub async fn snapshot(&self) -> KiroSnapshot {
        self.inner.lock().await.snap.clone()
    }
}

fn expiring_soon(expires_at_ms: i64) -> bool {
    expires_at_ms == 0 || expires_at_ms - now_ms() <= 10 * 60 * 1000
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}
fn num_of(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(Value::as_i64)
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    if s.is_empty() {
        return None;
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|d| d.timestamp_millis())
        .or_else(|| s.parse::<i64>().ok())
}

/// `redactStringSecrets` — strip token-like runs from error text.
fn redact(text: &str) -> String {
    static RE_LONG: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let out = RE_LONG
        .get_or_init(|| regex::Regex::new(r"[A-Za-z0-9_\-]{32,}").unwrap())
        .replace_all(text, |caps: &regex::Captures| {
            let m = &caps[0];
            if m.len() > 12 {
                format!("{}…(redacted)", &m[..6])
            } else {
                m.to_string()
            }
        });
    static RE_FIELD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE_FIELD
        .get_or_init(|| {
            regex::Regex::new(r#""(?:access|refresh|id)_token"\s*:\s*"[^"]+""#).unwrap()
        })
        .replace_all(&out, |caps: &regex::Captures| {
            let m = caps[0].to_string();
            let mut parts = m.rsplitn(2, '"');
            let _tail = parts.next();
            let _val = parts.next();
            m.replacen(&m[m.find(':').unwrap_or(0) + 1..], "\"***\"", 1)
        })
        .to_string()
}
