//! Trae auth — port of `providers/trae/client.ts`: ExchangeToken refresh,
//! GetUserInfo, GetModelList (get_detail_param / model_list) and the deep
//! model-list payload walker.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::pool::now_ms;
use crate::types::AccountFile;

pub const DEFAULT_TRAE_AUTH_BASE_URL: &str = "https://grow-normal.traeapi.us";
pub const DEFAULT_TRAE_CORE_BASE_URL: &str = "https://core-normal.traeapi.us";
pub const DEFAULT_TRAE_CLIENT_ID: &str = "ono9krqynydwx5";
pub const DEFAULT_TRAE_RAW_CHAT_PATH: &str = "/api/ide/v2/llm_raw_chat";
pub const DEFAULT_TRAE_MODEL_LIST_PATH: &str = "/api/ide/v1/get_detail_param";
pub const TRAE_APP_ID: &str = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
pub const TRAE_VERSION_CODE: &str = "20260509";

#[derive(Debug)]
pub struct TraeAuthError(pub String, pub u16, pub bool);
impl std::fmt::Display for TraeAuthError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}
impl std::error::Error for TraeAuthError {}

#[derive(Debug, Clone, Default)]
pub struct TraeTokenSnapshot {
    pub jwt_token: String,
    pub refresh_token: String,
    pub token_expires_at: i64,
    pub refresh_expires_at: i64,
}

/// `normalizeTraeModel` — loose alias map over built-in ids.
pub fn normalize_trae_model(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return DEFAULT_TRAE_MODEL.into();
    }
    let loose: String = trimmed
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    let alias = match loose.as_str() {
        "gemini25flash" | "gemini25flashpremium" => "gemini_2.5_flash",
        "gemini25pro" | "gemini25prolatest" => "gemini-2.5-pro-latest",
        "gemini3flash" | "gemini3flashpreview" => "gemini-3-flash-premium",
        "gemini3pro" | "gemini3propreview" => "gemini-3-pro",
        "deepseekv32" | "deepseekv3" => "deepseek-v3.2",
        "dolaseed20code" => "dola-seed-2.0-code",
        "minimaxm27" => "minimax-m2.7",
        "kimik25" | "kimik2" | "kimik20905" => "kimi-k2",
        "grok4" => "grok-4",
        _ => "",
    };
    if !alias.is_empty() {
        return alias.to_string();
    }
    trimmed.to_lowercase()
}

/// `buildTraeIdeHeaders`.
pub fn build_trae_ide_headers(token: &str, ide_version: &str) -> Vec<(String, String)> {
    let device = "mac";
    vec![
        ("authorization".into(), format!("Cloud-IDE-JWT {token}")),
        ("x-cloudide-token".into(), token.to_string()),
        ("x-app-id".into(), TRAE_APP_ID.into()),
        ("x-app-version".into(), "default".into()),
        ("x-ide-version".into(), ide_version.to_string()),
        ("x-ide-version-code".into(), TRAE_VERSION_CODE.into()),
        ("x-app-version-code".into(), TRAE_VERSION_CODE.into()),
        ("x-device-type".into(), device.into()),
        ("request-traffic-type".into(), "prod".into()),
        (
            "x-custom-trace-id".into(),
            uuid::Uuid::new_v4().simple().to_string()[..32].to_string(),
        ),
        (
            "x-flow-traceparent".into(),
            format!(
                "00-{}-{}-01",
                uuid::Uuid::new_v4().simple().to_string()[..32].to_string(),
                &uuid::Uuid::new_v4().simple().to_string()[..16]
            ),
        ),
    ]
}

struct AuthInner {
    snap: TraeTokenSnapshot,
}

pub struct TraeAuth {
    account_id: String,
    inner: Mutex<AuthInner>,
    client: reqwest::Client,
    auth_base_url: String,
    core_base_url: String,
    client_id: String,
    ide_version: String,
    model_list_path: String,
    on_change: Option<Arc<dyn Fn(&str, &TraeTokenSnapshot) + Send + Sync>>,
}

impl TraeAuth {
    pub fn new(
        account: &AccountFile,
        auth_base_url: &str,
        core_base_url: &str,
        client_id: &str,
        ide_version: &str,
        model_list_path: &str,
        client: reqwest::Client,
        on_change: Option<Arc<dyn Fn(&str, &TraeTokenSnapshot) + Send + Sync>>,
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
        let auth_base = {
            let v = field("authBaseUrl");
            if v.is_empty() {
                auth_base_url.to_string()
            } else {
                v
            }
        };
        let core_base = {
            let v = field("coreBaseUrl");
            if v.is_empty() {
                core_base_url.to_string()
            } else {
                v
            }
        };
        Self {
            account_id: account.id.clone(),
            inner: Mutex::new(AuthInner {
                snap: TraeTokenSnapshot {
                    jwt_token: field("jwtToken"),
                    refresh_token: field("refreshToken"),
                    token_expires_at: num_field("tokenExpiresAt"),
                    refresh_expires_at: num_field("refreshExpiresAt"),
                },
            }),
            client,
            auth_base_url: auth_base,
            core_base_url: core_base,
            client_id: client_id.to_string(),
            ide_version: ide_version.to_string(),
            model_list_path: model_list_path.to_string(),
            on_change,
        }
    }

    pub async fn auth_type(&self) -> &'static str {
        if self.inner.lock().await.snap.refresh_token.is_empty() {
            "trae-jwt"
        } else {
            "trae-refresh-token"
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

    /// `getJwtToken` — 5min expiry skew; refresh dedup via the mutex.
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
                return Err(TraeAuthError(
                    "No Trae JWT or refresh token available".into(),
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
            return Err(TraeAuthError(
                format!(
                    "Trae token refresh failed: HTTP {status} {}",
                    &text[..text.len().min(500)]
                ),
                status,
                permanent,
            )
            .into());
        }
        let snap = parse_token_payload(&payload);
        if snap.jwt_token.is_empty() {
            return Err(TraeAuthError(
                format!(
                    "Trae token refresh returned no JWT: {}",
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

    pub fn build_authorization_headers(&self, token: &str) -> Vec<(String, String)> {
        vec![
            ("authorization".into(), format!("Cloud-IDE-JWT {token}")),
            ("x-cloudide-token".into(), token.to_string()),
        ]
    }

    /// `getUserInfo`.
    pub async fn get_user_info(&self) -> anyhow::Result<Value> {
        let token = self.get_jwt_token().await?;
        let url = join_url(&self.auth_base_url, "/cloudide/api/v3/trae/GetUserInfo");
        let mut req = self
            .client
            .post(&url)
            .header("content-type", "application/json")
            .timeout(Duration::from_secs(20))
            .json(&json!({ "ReqSource": "IDE" }));
        for (k, v) in self.build_authorization_headers(&token) {
            req = req.header(k, v);
        }
        let res = req.send().await?;
        let status = res.status().as_u16();
        let payload: Value = res.json().await.unwrap_or(json!({}));
        if status >= 400 || is_error_payload(&payload) {
            return Err(TraeAuthError(
                format!(
                    "Trae GetUserInfo failed: HTTP {status} {}",
                    &stringify_payload(&payload)[..stringify_payload(&payload).len().min(500)]
                ),
                status,
                status == 401 || status == 403,
            )
            .into());
        }
        Ok(parse_user_info(&payload))
    }

    /// `getModelList` — POST get_detail_param or GET model_list.
    pub async fn get_model_list(&self) -> anyhow::Result<Vec<String>> {
        let token = self.get_jwt_token().await?;
        let path = &self.model_list_path;
        let is_detail_param = regex::Regex::new(r"/get_detail_param(?:$|\?)")
            .unwrap()
            .is_match(path);
        let url = join_url(&self.core_base_url, path);
        let mut req = if is_detail_param {
            self.client
                .post(&url)
                .header("content-type", "application/json")
                .json(&json!({
                    "function": "chat",
                    "need_prompt": true,
                    "poly_prompt": true,
                    "omit_encrypted_model_param": false,
                }))
        } else {
            self.client.get(&url)
        };
        req = req
            .header("accept", "application/json")
            .header("x-app-function", "chat")
            .header("x-ide-function", "chat")
            .timeout(Duration::from_secs(20));
        for (k, v) in build_trae_ide_headers(&token, &self.ide_version) {
            req = req.header(k, v);
        }
        let res = req.send().await?;
        let status = res.status().as_u16();
        let payload: Value = res.json().await.unwrap_or(json!({}));
        if status >= 400 || is_error_payload(&payload) {
            return Err(TraeAuthError(
                format!(
                    "Trae model list failed: HTTP {status} {}",
                    &stringify_payload(&payload)[..stringify_payload(&payload).len().min(500)]
                ),
                status,
                status == 401 || status == 403,
            )
            .into());
        }
        Ok(parse_model_list_payload(&payload))
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

fn parse_token_payload(payload: &Value) -> TraeTokenSnapshot {
    let result = payload
        .get("Result")
        .or_else(|| payload.get("result"))
        .or_else(|| payload.get("data"))
        .unwrap_or(payload);
    TraeTokenSnapshot {
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

fn is_error_payload(payload: &Value) -> bool {
    let code = payload
        .get("code")
        .or_else(|| payload.get("Code"))
        .or_else(|| payload.pointer("/error/code"));
    match code {
        None | Some(Value::Null) => false,
        Some(c) => {
            !(c.is_i64() && c.as_i64() == Some(0)
                || c.as_str().is_some_and(|s| matches!(s, "0" | "OK" | "ok")))
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

/// `parseModelListPayload` — detail-param list, then a depth-limited walk
/// over known model containers.
pub fn parse_model_list_payload(payload: &Value) -> Vec<String> {
    let root = payload
        .get("Result")
        .or_else(|| payload.get("result"))
        .or_else(|| payload.get("data"))
        .unwrap_or(payload);
    let detail = parse_detail_param_models(root);
    if !detail.is_empty() {
        return detail;
    }
    let mut models = std::collections::BTreeSet::new();
    let candidates = [
        root.get("model_configs"),
        root.get("modelConfigs"),
        root.get("models"),
        root.get("items"),
        root.get("list"),
        root.get("function_model_list"),
        root.get("functionModelList"),
        Some(root),
    ];
    for (i, c) in candidates.iter().enumerate() {
        if let Some(v) = c {
            collect_model_ids(v, &mut models, 0, i < candidates.len() - 1);
        }
    }
    models.into_iter().collect()
}

fn parse_detail_param_models(root: &Value) -> Vec<String> {
    let list = root
        .get("config_info_list")
        .or_else(|| root.get("configInfoList"))
        .and_then(Value::as_array);
    let Some(list) = list else { return Vec::new() };
    let mut models = std::collections::BTreeSet::new();
    for item in list {
        if !item.is_object() || is_disabled_model_entry(item) {
            continue;
        }
        let usage = pick_string(item, &["usage", "Usage"]);
        if let Some(u) = &usage
            && u != "chat_completion"
        {
            continue;
        }
        let id = pick_string(
            item,
            &["config_name", "configName", "model_name", "modelName"],
        );
        if let Some(id) = id
            && let Some(n) = normalize_maybe_model(&id)
        {
            models.insert(n);
        }
    }
    models.into_iter().collect()
}

fn collect_model_ids(
    value: &Value,
    models: &mut std::collections::BTreeSet<String>,
    depth: usize,
    in_model_container: bool,
) {
    if depth > 6 {
        return;
    }
    match value {
        Value::String(s) => {
            if in_model_container && let Some(n) = normalize_maybe_model(s) {
                models.insert(n);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                collect_model_ids(item, models, depth + 1, in_model_container);
            }
        }
        Value::Object(map) => {
            if is_disabled_model_entry(value) {
                return;
            }
            if in_model_container {
                for (key, child) in map {
                    if is_schema_key(key) {
                        continue;
                    }
                    if child.is_object() && is_disabled_model_entry(child) {
                        continue;
                    }
                    if let Some(n) = normalize_maybe_model(key) {
                        models.insert(n);
                    }
                }
            }
            if let Some(id) = pick_string(
                value,
                &[
                    "model_name",
                    "modelName",
                    "model_id",
                    "modelId",
                    "name",
                    "id",
                    "key",
                ],
            ) && let Some(n) = normalize_maybe_model(&id)
            {
                models.insert(n);
            }
            for key in [
                "models",
                "model_configs",
                "modelConfigs",
                "children",
                "selectables",
                "function_model_list",
                "functionModelList",
                "items",
                "list",
            ] {
                if let Some(child) = value.get(key) {
                    collect_model_ids(child, models, depth + 1, true);
                }
            }
            if in_model_container {
                for child in map.values() {
                    if child.is_object() || child.is_array() {
                        collect_model_ids(child, models, depth + 1, true);
                    }
                }
            }
        }
        _ => {}
    }
}

fn is_schema_key(key: &str) -> bool {
    regex::Regex::new(
        r"(?i)^(model_name|modelName|model_id|modelId|name|id|key|models|model_configs|modelConfigs|children|selectables|function_model_list|functionModelList|items|list|enabled|enable|available|status|state|description|displayName|display_name|title|label)$",
    )
    .unwrap()
    .is_match(key)
}

fn is_disabled_model_entry(value: &Value) -> bool {
    for key in ["enabled", "enable", "available"] {
        if value.get(key).and_then(Value::as_bool) == Some(false) {
            return true;
        }
    }
    for key in ["disabled", "disable", "invisible"] {
        if value.get(key).and_then(Value::as_bool) == Some(true) {
            return true;
        }
    }
    let status = value
        .get("status")
        .or_else(|| value.get("state"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    matches!(
        status.as_str(),
        "disabled" | "unavailable" | "not_available"
    )
}

fn normalize_maybe_model(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if regex::Regex::new(
        r"(?i)^(ok|success|available|enabled|disabled|unavailable|not_available|chat|default|models?|selectables?|function_model_list)$",
    )
    .unwrap()
    .is_match(trimmed)
    {
        return None;
    }
    if !trimmed.chars().any(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    let looks_model = trimmed.contains(['-', '_', '.'])
        || trimmed.chars().any(|c| c.is_ascii_digit())
        || regex::Regex::new(
            r"(?i)^(gpt|gemini|deepseek|kimi|mini|max|minimax|dola|claude|qwen|llama|mistral|seed|o\d)",
        )
        .unwrap()
        .is_match(trimmed);
    if !looks_model {
        return None;
    }
    Some(normalize_trae_model(trimmed))
}
