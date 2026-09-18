//! TraeWork auth — port of `providers/traework/client.ts` + `constants.ts`
//! + `headers.ts`. ExchangeToken refresh, GetUserInfo, batch_get_detail_param
//! model catalog, TraeWork IDE header set.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::pool::now_ms;
use crate::types::AccountFile;

pub const DEFAULT_TRAEWORK_CORE_BASE_URL: &str = "https://api5-normal.mchost.guru";
pub const DEFAULT_TRAEWORK_AUTH_BASE_URL: &str = "https://api.trae.cn";
pub const DEFAULT_TRAEWORK_CLIENT_ID: &str = "ono9krqynydwx5";
pub const DEFAULT_TRAEWORK_RAW_CHAT_PATH: &str = "/api/agent/v3/llm_utils_chat";
pub const DEFAULT_TRAEWORK_DETAIL_PARAM_PATH: &str = "/api/ide/v1/batch_get_detail_param";
pub const DEFAULT_TRAEWORK_APP_ID: &str = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
pub const DEFAULT_TRAEWORK_VERSION_CODE: &str = "20260901";
pub const DEFAULT_TRAEWORK_IDE_VERSION: &str = "0.1.64";
pub const DEFAULT_TRAEWORK_PACKAGE_TYPE: &str = "stable_cn";
pub const DEFAULT_TRAEWORK_FUNCTION: &str = "chat_v3";

pub const TRAEWORK_DETAIL_FUNCTIONS: &[&str] = &[
    "assistant",
    "solo_agent_lite",
    "solo_coder",
    "solo_agent_remote",
    "solo_work_lite",
    "solo_work_remote",
    "solo_design_lite",
    "solo_design_remote",
    "builder",
    "chat_v3",
    "chat",
    "inline_chat",
    "multimodal",
];

/// (id, displayName) fallback/description table. Model ids are the
/// user-facing config_name values, never the internal `__dev` variants.
pub const TRAEWORK_BUILT_IN_MODELS: &[(&str, &str)] = &[
    ("glm-5.3", "GLM-5.3"),
    ("glm-5.2", "GLM-5.2"),
    ("kimi-k3", "Kimi K3"),
    ("kimi-k2.7-code", "Kimi K2.7 Code"),
    ("kimi-k2.6", "Kimi K2.6"),
    ("minimax-m3", "MiniMax M3"),
    ("qwen3.8-max", "Qwen 3.8 Max"),
    ("qwen-3.7-plus", "Qwen 3.7 Plus"),
    ("Doubao-Seed-2.1-Pro", "Doubao Seed 2.1 Pro"),
    ("Doubao-Seed-2.1-Turbo", "Doubao Seed 2.1 Turbo"),
    ("Doubao-Seed-Evolving", "Doubao Seed Evolving"),
    ("Doubao-Seed-Code", "Doubao Seed Code"),
    ("DeepSeek-V4-Flash-Official", "DeepSeek V4 Flash"),
    ("DeepSeek-V4-Pro-Official", "DeepSeek V4 Pro"),
];

/// `normalizeTraeWorkModel` — case-sensitive; trim + alias only.
pub fn normalize_traework_model(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return trimmed.to_string();
    }
    let loose: String = trimmed
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    for (id, display) in TRAEWORK_BUILT_IN_MODELS {
        if loose == loose_id(id) || loose == loose_id(display) {
            return (*id).to_string();
        }
    }
    match loose.as_str() {
        "glm53" => "glm-5.3",
        "glm52" => "glm-5.2",
        "doubaoseed21pro" => "Doubao-Seed-2.1-Pro",
        "deepseekv4flash" => "DeepSeek-V4-Flash-Official",
        "deepseekv4pro" => "DeepSeek-V4-Pro-Official",
        _ => trimmed,
    }
    .to_string()
}

fn loose_id(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

pub fn describe_traework_model(id: &str) -> Option<&'static str> {
    let normalized = normalize_traework_model(id);
    TRAEWORK_BUILT_IN_MODELS
        .iter()
        .find(|(mid, _)| *mid == normalized)
        .map(|(_, d)| *d)
}

/// `buildTraeWorkHeaders` — the api5-normal.mchost.guru header set.
pub fn build_traework_headers(
    token: &str,
    settings: &TraeWorkHeaderSettings,
    account: Option<&AccountFile>,
) -> Vec<(String, String)> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let device_type = "mac";
    let device_brand = account
        .and_then(|a| field(a, "deviceBrand"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Mac".into());
    let device_cpu = "Apple";
    let os_version = account
        .and_then(|a| field(a, "osVersion"))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{} {}", std::env::consts::OS, std::env::consts::ARCH));
    vec![
        // NOTE: no content-type here — `.json()` already sets it; a duplicate
        // header makes the upstream drop the body ("function is empty" 2001).
        (
            "accept".into(),
            "text/event-stream, application/json".into(),
        ),
        ("authorization".into(), format!("Cloud-IDE-JWT {token}")),
        ("x-cloudide-token".into(), token.into()),
        ("x-ide-token".into(), token.into()),
        ("x-app-id".into(), settings.app_id.clone()),
        ("app-version".into(), settings.ide_version.clone()),
        ("x-app-version".into(), "default".into()),
        ("x-app-version-code".into(), settings.version_code.clone()),
        ("x-ide-version".into(), settings.ide_version.clone()),
        ("x-ide-version-code".into(), settings.version_code.clone()),
        ("x-ide-version-type".into(), "stable".into()),
        ("package-type".into(), settings.package_type.clone()),
        ("x-device-type".into(), device_type.into()),
        ("x-device-brand".into(), device_brand),
        ("x-device-cpu".into(), device_cpu.into()),
        (
            "x-device-id".into(),
            account
                .and_then(|a| field(a, "deviceId"))
                .or_else(|| account.and_then(|a| field(a, "devDeviceId")))
                .unwrap_or_default(),
        ),
        (
            "x-machine-id".into(),
            account
                .and_then(|a| field(a, "machineId"))
                .unwrap_or_default(),
        ),
        ("x-os-version".into(), os_version),
        (
            "x-uid".into(),
            account.and_then(|a| field(a, "userId")).unwrap_or_default(),
        ),
        ("request-traffic-type".into(), "prod".into()),
        ("X-Trae-Client-Type".into(), "lite".into()),
        (
            "x-custom-trace-id".into(),
            uuid::Uuid::new_v4().simple().to_string(),
        ),
        ("x-request-id".into(), request_id.clone()),
        ("x-trae-request-id".into(), request_id),
        (
            "x-flow-traceparent".into(),
            format!(
                "00-{}-{}-01",
                uuid::Uuid::new_v4().simple().to_string(),
                &uuid::Uuid::new_v4().simple().to_string()[..16]
            ),
        ),
        ("user-agent".into(), "TraeClient/TTNet".into()),
    ]
}

#[derive(Debug, Clone)]
pub struct TraeWorkHeaderSettings {
    pub app_id: String,
    pub ide_version: String,
    pub version_code: String,
    pub package_type: String,
}

fn field(account: &AccountFile, key: &str) -> Option<String> {
    account
        .fields
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[derive(Debug)]
pub struct TraeWorkAuthError(pub String, pub u16, pub bool);
impl std::fmt::Display for TraeWorkAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for TraeWorkAuthError {}

#[derive(Debug, Clone, Default)]
pub struct TraeWorkTokenSnapshot {
    pub jwt_token: String,
    pub refresh_token: String,
    pub token_expires_at: i64,
    pub refresh_expires_at: i64,
}

struct AuthInner {
    snap: TraeWorkTokenSnapshot,
}

pub struct TraeWorkAuth {
    account_id: String,
    inner: Mutex<AuthInner>,
    client: reqwest::Client,
    auth_base_url: String,
    core_base_url: String,
    client_id: String,
    detail_param_path: String,
    header_settings: TraeWorkHeaderSettings,
    on_change: Option<Arc<dyn Fn(&str, &TraeWorkTokenSnapshot) + Send + Sync>>,
}

impl TraeWorkAuth {
    pub fn new(
        account: &AccountFile,
        auth_base_url: &str,
        core_base_url: &str,
        client_id: &str,
        detail_param_path: &str,
        header_settings: TraeWorkHeaderSettings,
        client: reqwest::Client,
        on_change: Option<Arc<dyn Fn(&str, &TraeWorkTokenSnapshot) + Send + Sync>>,
    ) -> Self {
        let field = |k: &str| {
            account
                .fields
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let num_field = |k: &str| account.fields.get(k).and_then(Value::as_i64).unwrap_or(0);
        Self {
            account_id: account.id.clone(),
            inner: Mutex::new(AuthInner {
                snap: TraeWorkTokenSnapshot {
                    jwt_token: field("jwtToken"),
                    refresh_token: field("refreshToken"),
                    token_expires_at: num_field("tokenExpiresAt"),
                    refresh_expires_at: num_field("refreshExpiresAt"),
                },
            }),
            client,
            auth_base_url: {
                let v = field("authBaseUrl");
                if v.is_empty() {
                    auth_base_url.to_string()
                } else {
                    v
                }
            },
            core_base_url: {
                let v = field("coreBaseUrl");
                if v.is_empty() {
                    core_base_url.to_string()
                } else {
                    v
                }
            },
            client_id: client_id.to_string(),
            detail_param_path: detail_param_path.to_string(),
            header_settings,
            on_change,
        }
    }

    pub async fn auth_type(&self) -> &'static str {
        if self.inner.lock().await.snap.refresh_token.is_empty() {
            "traework-jwt"
        } else {
            "traework-refresh-token"
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

    pub async fn get_jwt_token(&self) -> anyhow::Result<String> {
        {
            let inner = self.inner.lock().await;
            if !inner.snap.jwt_token.is_empty() && !expires_soon(inner.snap.token_expires_at) {
                return Ok(inner.snap.jwt_token.clone());
            }
            if inner.snap.refresh_token.is_empty() {
                if !inner.snap.jwt_token.is_empty() {
                    return Ok(inner.snap.jwt_token.clone());
                }
                return Err(TraeWorkAuthError(
                    "No TraeWork JWT or refresh token available".into(),
                    0,
                    true,
                )
                .into());
            }
        }
        self.refresh().await
    }

    async fn refresh(&self) -> anyhow::Result<String> {
        let mut inner = self.inner.lock().await;
        if !inner.snap.jwt_token.is_empty() && !expires_soon(inner.snap.token_expires_at) {
            return Ok(inner.snap.jwt_token.clone());
        }
        let url = join_url(
            &self.auth_base_url,
            "/cloudide/api/v3/trae/oauth/ExchangeToken",
        );
        let mut req = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .timeout(Duration::from_secs(20));
        if !inner.snap.jwt_token.is_empty() {
            req = req.header("x-cloudide-token", &inner.snap.jwt_token);
        }
        let res = req
            .json(&json!({
                "ClientID": self.client_id,
                "ClientSecret": "-",
                "RefreshToken": inner.snap.refresh_token,
                "UserID": "",
            }))
            .send()
            .await?;
        let status = res.status().as_u16();
        let payload: Value = res.json().await.unwrap_or(json!({}));
        if status >= 400 || is_error_payload(&payload) {
            let text = stringify_payload(&payload);
            let permanent = status == 401
                || status == 403
                || regex::Regex::new(r"invalid|expired")
                    .unwrap()
                    .is_match(&text);
            return Err(TraeWorkAuthError(
                format!(
                    "TraeWork token refresh failed: HTTP {status} {}",
                    &text[..text.len().min(500)]
                ),
                status,
                permanent,
            )
            .into());
        }
        let snap = parse_token_payload(&payload);
        if snap.jwt_token.is_empty() {
            return Err(TraeWorkAuthError(
                format!(
                    "TraeWork token refresh returned no JWT: {}",
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
        Ok(snap.jwt_token)
    }

    /// `getUserInfo`.
    pub async fn get_user_info(&self) -> anyhow::Result<Value> {
        let token = self.get_jwt_token().await?;
        let url = join_url(&self.auth_base_url, "/cloudide/api/v3/trae/GetUserInfo");
        let res = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .header("authorization", format!("Cloud-IDE-JWT {token}"))
            .header("x-cloudide-token", &token)
            .timeout(Duration::from_secs(20))
            .json(&json!({ "ReqSource": "IDE" }))
            .send()
            .await?;
        let status = res.status().as_u16();
        let payload: Value = res.json().await.unwrap_or(json!({}));
        if status >= 400 || is_error_payload(&payload) {
            return Err(TraeWorkAuthError(
                format!(
                    "TraeWork GetUserInfo failed: HTTP {status} {}",
                    &stringify_payload(&payload)[..stringify_payload(&payload).len().min(500)]
                ),
                status,
                status == 401 || status == 403,
            )
            .into());
        }
        Ok(parse_user_info(&payload))
    }

    /// `getModelList` — batch_get_detail_param.
    pub async fn get_model_list(&self, account: &AccountFile) -> anyhow::Result<Vec<String>> {
        let token = self.get_jwt_token().await?;
        let url = join_url(&self.core_base_url, &self.detail_param_path);
        let mut req = self.client.post(&url).timeout(Duration::from_secs(20));
        for (k, v) in build_traework_headers(&token, &self.header_settings, Some(account)) {
            req = req.header(k, v);
        }
        let res = req
            .json(&json!({
                "functions": TRAEWORK_DETAIL_FUNCTIONS,
                "agent_type": "solo_agent_lite",
                "current_config_info": { "config_name": "", "is_custom_model": false },
                "mode_type": 0,
                "access_type": 1,
                "ab_force_vids": "",
                "ab_autotest_advanced_mode": 0,
                "show_custom_model": false,
            }))
            .send()
            .await?;
        let status = res.status().as_u16();
        let payload: Value = res.json().await.unwrap_or(json!({}));
        if status >= 400 || is_error_payload(&payload) {
            return Err(TraeWorkAuthError(
                format!(
                    "TraeWork model list failed: HTTP {status} {}",
                    &stringify_payload(&payload)[..stringify_payload(&payload).len().min(500)]
                ),
                status,
                status == 401 || status == 403,
            )
            .into());
        }
        Ok(parse_model_list_payload(&payload))
    }

    pub fn header_settings(&self) -> &TraeWorkHeaderSettings {
        &self.header_settings
    }
}

fn expires_soon(expires_at_ms: i64) -> bool {
    expires_at_ms > 0 && now_ms() + 5 * 60_000 > expires_at_ms
}

fn join_url(base: &str, path: &str) -> String {
    format!(
        "{}{}",
        base.trim_end_matches('/'),
        if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        }
    )
}

fn pick_string(v: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .filter_map(|k| v.get(*k).and_then(Value::as_str))
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_string)
}

fn parse_token_payload(payload: &Value) -> TraeWorkTokenSnapshot {
    let result = payload
        .get("Result")
        .or_else(|| payload.get("result"))
        .or_else(|| payload.get("data"))
        .unwrap_or(payload);
    TraeWorkTokenSnapshot {
        jwt_token: pick_string(
            result,
            &["Token", "token", "JwtToken", "jwtToken", "accessToken"],
        )
        .unwrap_or_default(),
        refresh_token: pick_string(result, &["RefreshToken", "refreshToken", "refresh_token"])
            .unwrap_or_default(),
        token_expires_at: normalize_epoch(
            result
                .get("TokenExpireAt")
                .or_else(|| result.get("tokenExpireAt"))
                .or_else(|| result.get("TokenExpiresAt"))
                .or_else(|| result.get("expiresAt"))
                .unwrap_or(&Value::Null),
        )
        .unwrap_or(0),
        refresh_expires_at: normalize_epoch(
            result
                .get("RefreshExpireAt")
                .or_else(|| result.get("refreshExpireAt"))
                .or_else(|| result.get("refreshExpiresAt"))
                .unwrap_or(&Value::Null),
        )
        .unwrap_or(0),
    }
}

fn parse_user_info(payload: &Value) -> Value {
    let result = payload
        .get("Result")
        .or_else(|| payload.get("result"))
        .or_else(|| payload.get("data"))
        .unwrap_or(payload);
    let email = pick_string(
        result,
        &["Email", "email", "NonPlainTextEmail", "nonPlainTextEmail"],
    )
    .filter(|e| {
        regex::Regex::new(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
            .unwrap()
            .is_match(e)
    });
    json!({
        "email": email,
        "userId": pick_string(result, &["UserID", "UserId", "userId", "id"]),
        "countryCode": pick_string(result, &["StoreCountryCode", "storeCountryCode", "CountryCode", "countryCode", "AIRegion", "aiRegion"])
            .map(|c| c.to_uppercase()),
        "raw": result,
    })
}

/// `parseModelListPayload` — function_configs[].config_info_list, filtered
/// to usage=chat_completion + config_switch + !is_invisible_to_user.
fn parse_model_list_payload(payload: &Value) -> Vec<String> {
    let root = payload
        .get("Result")
        .or_else(|| payload.get("result"))
        .or_else(|| payload.get("data"))
        .unwrap_or(payload);
    let mut models = std::collections::BTreeSet::new();
    if let Some(fns) = root
        .get("function_configs")
        .or_else(|| root.get("functionConfigs"))
        .and_then(Value::as_array)
    {
        for f in fns {
            collect_detail_param_models(
                f.get("config_info_list")
                    .or_else(|| f.get("configInfoList")),
                &mut models,
            );
        }
    }
    collect_detail_param_models(
        root.get("config_info_list")
            .or_else(|| root.get("configInfoList")),
        &mut models,
    );
    models.into_iter().collect()
}

fn collect_detail_param_models(
    list: Option<&Value>,
    models: &mut std::collections::BTreeSet<String>,
) {
    let Some(list) = list.and_then(Value::as_array) else {
        return;
    };
    for item in list {
        if !item.is_object() {
            continue;
        }
        let usage = pick_string(item, &["usage", "Usage"]);
        if let Some(u) = &usage
            && u != "chat_completion"
        {
            continue;
        }
        if item
            .get("config_switch")
            .or_else(|| item.get("configSwitch"))
            .and_then(Value::as_bool)
            == Some(false)
        {
            continue;
        }
        if item
            .get("is_invisible_to_user")
            .or_else(|| item.get("isInvisibleToUser"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            continue;
        }
        let id = pick_string(
            item,
            &["config_name", "configName", "model_name", "modelName"],
        );
        if let Some(id) = id
            && id.chars().any(|c| c.is_ascii_alphabetic())
        {
            models.insert(normalize_traework_model(&id));
        }
    }
}

fn is_error_payload(payload: &Value) -> bool {
    let code = payload
        .get("code")
        .or_else(|| payload.get("Code"))
        .or_else(|| payload.pointer("/error/code"));
    match code {
        None | Some(Value::Null) => false,
        Some(c) => {
            !(c.as_i64() == Some(0) || c.as_str().is_some_and(|s| matches!(s, "0" | "OK" | "ok")))
        }
    }
}

fn stringify_payload(payload: &Value) -> String {
    payload
        .get("rawText")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| serde_json::to_string(payload).unwrap_or_else(|_| "null".into()))
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
