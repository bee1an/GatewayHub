//! Serde models for `gatewayhub.config.json` / `gatewayhub.state.json` /
//! per-provider account files. Field names stay camelCase to remain
//! byte-compatible with the Electron app's on-disk format; `#[serde(flatten)]`
//! extras preserve provider-specific keys this port doesn't model yet.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub type JsonMap = Map<String, Value>;

fn default_version() -> u32 {
    3
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHubConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub server: GatewayServerConfig,
    #[serde(default = "default_provider_name")]
    pub default_provider: String,
    #[serde(default)]
    pub providers: JsonMap,
    #[serde(default)]
    pub model_mappings: Vec<ModelMapping>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

fn default_provider_name() -> String {
    "kiro".to_string()
}

impl Default for GatewayHubConfig {
    fn default() -> Self {
        Self {
            version: default_version(),
            server: GatewayServerConfig::default(),
            default_provider: default_provider_name(),
            providers: JsonMap::new(),
            model_mappings: Vec::new(),
            extra: JsonMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayServerConfig {
    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub api_keys: Vec<ApiKeyEntry>,
    #[serde(default)]
    pub auto_start: bool,
    #[serde(default)]
    pub proxy_url: String,
    #[serde(flatten)]
    pub extra: JsonMap,
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}
fn default_port() -> u16 {
    9741
}

impl Default for GatewayServerConfig {
    fn default() -> Self {
        Self {
            host: default_host(),
            port: default_port(),
            api_keys: Vec::new(),
            auto_start: false,
            proxy_url: String::new(),
            extra: JsonMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiKeyEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub last_used_at: Option<i64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub scopes: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMapping {
    #[serde(default)]
    pub alias: String,
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

/// Generic per-provider config entry. Provider-specific `settings` contents
/// are kept as raw JSON until each provider is ported — they round-trip
/// untouched on save.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub use_proxy: Option<bool>,
    #[serde(default)]
    pub route_name: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub settings: JsonMap,
    #[serde(flatten)]
    pub extra: JsonMap,
}

impl ProviderConfig {
    pub fn from_value(v: &Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }
}

/// Per-account file: base fields plus arbitrary provider credential fields
/// preserved via `fields` (apiKey, refreshToken, cookieHeader, …).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountFile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(flatten)]
    pub fields: JsonMap,
}

impl AccountFile {
    pub fn field_str(&self, key: &str) -> Option<&str> {
        self.fields.get(key).and_then(Value::as_str)
    }

    /// Display label: explicit label → email → id.
    pub fn display_label(&self) -> &str {
        self.label
            .as_deref()
            .or(self.email.as_deref())
            .unwrap_or(self.id.as_str())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayHubState {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub providers: JsonMap,
    #[serde(flatten)]
    pub extra: JsonMap,
}

fn one() -> u32 {
    1
}

impl Default for GatewayHubState {
    fn default() -> Self {
        Self {
            version: 1,
            providers: JsonMap::new(),
            extra: JsonMap::new(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderState {
    #[serde(default)]
    pub accounts: JsonMap,
    #[serde(default)]
    pub current_account_index: i64,
    #[serde(default)]
    pub logs: Vec<GatewayLogEntry>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

impl ProviderState {
    pub fn from_value(v: &Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccountStatus {
    #[default]
    Available,
    Cooling,
    RateLimited,
    QuotaExceeded,
    AuthFailed,
    ManualDisabled,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountRuntimeState {
    #[serde(default)]
    pub failures: u64,
    #[serde(default)]
    pub last_failure_at: i64,
    #[serde(default)]
    pub last_success_at: i64,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(default)]
    pub models_cached_at: i64,
    #[serde(default)]
    pub model_ids: Vec<String>,
    #[serde(default)]
    pub status: AccountStatus,
    #[serde(default)]
    pub status_reason: Option<String>,
    #[serde(default)]
    pub status_updated_at: i64,
    #[serde(default)]
    pub cooldown_until: Option<i64>,
    #[serde(default)]
    pub last_response_kind: Option<String>,
    #[serde(default)]
    pub checkin: Option<CheckinState>,
    #[serde(default)]
    pub stats: AccountStats,
    #[serde(flatten)]
    pub extra: JsonMap,
}

impl AccountRuntimeState {
    pub fn from_value(v: &Value) -> Self {
        serde_json::from_value(v.clone()).unwrap_or_default()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStats {
    #[serde(default)]
    pub total_requests: u64,
    #[serde(default)]
    pub successful_requests: u64,
    #[serde(default)]
    pub failed_requests: u64,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckinState {
    #[serde(default)]
    pub last_day: Option<String>,
    #[serde(default)]
    pub last_at: Option<i64>,
    #[serde(default)]
    pub last_credits: Option<f64>,
    #[serde(default)]
    pub last_error: Option<String>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayLogEntry {
    #[serde(default)]
    pub ts: i64,
    pub level: LogLevel,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub account_id: Option<String>,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub status_code: Option<u16>,
    #[serde(default)]
    pub duration: Option<u64>,
    #[serde(default)]
    pub streaming: Option<bool>,
    #[serde(default)]
    pub time_to_first_token: Option<u64>,
    #[serde(default)]
    pub chunk_count: Option<u64>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub api_format: Option<String>,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub cost: Option<Value>,
    #[serde(default)]
    pub error: Option<Value>,
    #[serde(flatten)]
    pub extra: JsonMap,
}

/// Status surface for the UI — mirrors `ProviderStatus` in the Electron app.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub name: String,
    pub provider_type: String,
    pub display_name: Option<String>,
    pub enabled: bool,
    pub configured: bool,
    pub status: &'static str,
    pub message: Option<String>,
    pub models: Vec<String>,
    pub use_proxy: Option<bool>,
    pub accounts: usize,
}

// ---------------------------------------------------------------------------
// Runtime request/response surface (not persisted)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiFormat {
    #[serde(rename = "openai")]
    OpenAi,
    Anthropic,
    Responses,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseKind {
    Success,
    RateLimit,
    Quota,
    Auth,
    ModelError,
    ServerError,
    Network,
    Timeout,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageStats {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_read_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write5m_tokens: Option<u64>,
    #[serde(default)]
    pub cache_write1h_tokens: Option<u64>,
    #[serde(default)]
    pub credits: Option<f64>,
    #[serde(default)]
    pub estimated: Option<bool>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageMeta {
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
}

pub type UsageSink = std::sync::Arc<dyn Fn(UsageStats, UsageMeta) + Send + Sync>;

/// Per-request context handed to provider adapters — the Rust twin of
/// `GatewayRequestContext`. `cancel` is a `CancellationToken` because tokio
/// drops/abort-scopes are the native equivalent of `AbortSignal`.
pub struct GatewayRequestContext {
    pub request_id: String,
    pub session_id: Option<String>,
    pub session_source: Option<&'static str>,
    pub api_format: ApiFormat,
    pub on_usage: Option<UsageSink>,
    pub cancel: tokio_util::sync::CancellationToken,
}

/// A ready-to-write upstream reply. `Sse` items are raw event-stream text
/// chunks (the upstream passthrough already contains `data:` framing).
pub enum GatewayResponse {
    Json {
        status: u16,
        body: serde_json::Value,
    },
    Sse {
        status: u16,
        stream: std::pin::Pin<Box<dyn futures::Stream<Item = String> + Send>>,
    },
}

impl GatewayResponse {
    pub fn json(status: u16, body: serde_json::Value) -> Self {
        Self::Json { status, body }
    }

    pub fn error(status: u16, message: impl Into<String>, kind: &str) -> Self {
        Self::Json {
            status,
            body: serde_json::json!({ "error": { "message": message.into(), "type": kind } }),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct AccountTestResult {
    pub ok: bool,
    pub account_id: String,
    pub message: String,
    pub models: Vec<String>,
    pub auth_type: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ProviderModel {
    pub id: String,
    pub provider: String,
    pub owned_by: Option<String>,
    pub description: Option<String>,
}

/// Shared classified upstream error driving status transitions.
#[derive(Debug, Clone)]
pub struct ClassifiedError {
    pub kind: ResponseKind,
    pub cooldown_ms: i64,
    pub reset_at_iso: Option<String>,
}

/// Structured logger sink — service provides one per provider; appends to
/// `state.providers[name].logs` and emits via `tracing`.
pub type LogSink = std::sync::Arc<dyn Fn(GatewayLogEntry) + Send + Sync>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevelFilter {
    Debug,
    Info,
    Warn,
    Error,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSnapshot {
    pub running: bool,
    pub url: String,
    pub host: String,
    pub port: u16,
    pub api_keys: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayStatusSnapshot {
    pub server: ServerSnapshot,
    pub config_path: String,
    pub state_path: String,
    pub providers: Vec<ProviderStatus>,
    pub logs: Vec<GatewayLogEntry>,
}
