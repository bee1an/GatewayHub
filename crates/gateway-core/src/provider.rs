//! Provider adapters + the canonical provider list.

use serde_json::Value;

use crate::types::{
    AccountFile, AccountStatus, AccountTestResult, GatewayHubConfig, GatewayRequestContext,
    GatewayResponse, JsonMap, ModelMapping, ProviderConfig, ProviderModel, ProviderState,
    ProviderStatus,
};

/// Canonical provider order — same set the Electron registry knows.
pub const PROVIDERS: &[&str] = &[
    "kiro",
    "codex",
    "trae",
    "traework",
    "workbuddy",
    "openrouter",
    "nvidia",
    "gptWeb",
    "grokWeb",
    "geminiWeb",
    "qoder",
    "gemini",
];

/// Providers that have no account gateway yet (reserved slot).
pub const PLACEHOLDER_PROVIDERS: &[&str] = &["gemini"];

/// Providers that can route upstream traffic through `server.proxyUrl`.
pub const PROXY_CAPABLE: &[&str] = &[
    "kiro",
    "codex",
    "trae",
    "traework",
    "workbuddy",
    "gptWeb",
    "grokWeb",
    "qoder",
    "geminiWeb",
];

pub fn provider_config(config: &GatewayHubConfig, name: &str) -> ProviderConfig {
    config
        .providers
        .get(name)
        .map(ProviderConfig::from_value)
        .unwrap_or_default()
}

fn provider_state(state: &JsonMap, name: &str) -> ProviderState {
    state
        .get(name)
        .map(ProviderState::from_value)
        .unwrap_or_default()
}

fn provider_models(state: &ProviderState) -> Vec<String> {
    let mut ids: Vec<String> = state
        .accounts
        .values()
        .flat_map(|v| crate::types::AccountRuntimeState::from_value(v).model_ids)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Config+state+account-file derived status — used where a live adapter
/// isn't running (e.g. the status snapshot).
pub fn describe_provider(
    name: &str,
    config: &GatewayHubConfig,
    state: &JsonMap,
    accounts: &[AccountFile],
) -> ProviderStatus {
    let cfg = provider_config(config, name);
    let pstate = provider_state(state, name);
    let configured = !accounts.is_empty();
    let status = if PLACEHOLDER_PROVIDERS.contains(&name) {
        "placeholder"
    } else if !cfg.enabled {
        "disabled"
    } else {
        "ready"
    };
    let message = if cfg.enabled && !configured && status == "ready" {
        Some("no accounts configured".to_string())
    } else {
        None
    };
    ProviderStatus {
        name: cfg.route_name.clone().unwrap_or_else(|| name.to_string()),
        provider_type: name.to_string(),
        display_name: cfg.display_name.clone(),
        enabled: cfg.enabled,
        configured,
        status,
        message,
        models: provider_models(&pstate),
        use_proxy: if PROXY_CAPABLE.contains(&name) {
            Some(cfg.use_proxy.unwrap_or(false))
        } else {
            None
        },
        accounts: accounts.len(),
    }
}

/// The adapter contract — mirrors the TS `ProviderAdapter` interface.
#[async_trait::async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn status(&self) -> ProviderStatus;
    async fn list_models(&self) -> Vec<ProviderModel>;

    async fn chat_completions(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse;

    async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse;

    /// `None` → the registry replies 501 like the TS `countTokens` fallback.
    async fn count_tokens(
        &self,
        _body: Value,
        _ctx: &GatewayRequestContext,
    ) -> Option<GatewayResponse> {
        None
    }

    async fn test_account(&self, account_id: &str) -> AccountTestResult {
        AccountTestResult {
            ok: false,
            account_id: account_id.into(),
            message: format!("Provider {} cannot test accounts", self.name()),
            ..Default::default()
        }
    }

    async fn get_account_info(&self, account_id: &str) -> anyhow::Result<Value> {
        let _ = account_id;
        anyhow::bail!("Provider {} does not support getAccountInfo", self.name())
    }

    async fn refresh_account_models(&self, account_id: &str) -> anyhow::Result<Vec<String>> {
        let _ = account_id;
        anyhow::bail!(
            "Provider {} does not support refreshAccountModels",
            self.name()
        )
    }

    async fn reset_account(&self, account_id: &str) -> anyhow::Result<()> {
        let _ = account_id;
        anyhow::bail!("Provider {} does not support resetAccount", self.name())
    }

    /// Optional daily check-in (TraeWork checkin_credits).
    async fn checkin_accounts(
        &self,
        _account_id: Option<&str>,
        _force: bool,
    ) -> anyhow::Result<Value> {
        anyhow::bail!("checkin not supported")
    }

    async fn set_account_status(
        &self,
        account_id: &str,
        _status: AccountStatus,
        _reason: Option<String>,
    ) -> anyhow::Result<()> {
        let _ = account_id;
        anyhow::bail!("Provider {} does not support setAccountStatus", self.name())
    }
}

/// 501 stand-in for providers not yet ported (and reserved slots like gemini).
pub struct PlaceholderAdapter {
    name: &'static str,
    note: String,
    enabled: bool,
}

impl PlaceholderAdapter {
    pub fn new(name: &'static str, note: impl Into<String>, enabled: bool) -> Self {
        Self {
            name,
            note: note.into(),
            enabled,
        }
    }
}

#[async_trait::async_trait]
impl ProviderAdapter for PlaceholderAdapter {
    fn name(&self) -> &'static str {
        self.name
    }

    fn status(&self) -> ProviderStatus {
        ProviderStatus {
            name: self.name.into(),
            provider_type: self.name.into(),
            display_name: None,
            enabled: self.enabled,
            configured: false,
            status: "placeholder",
            message: Some(self.note.clone()),
            models: Vec::new(),
            use_proxy: None,
            accounts: 0,
        }
    }

    async fn list_models(&self) -> Vec<ProviderModel> {
        Vec::new()
    }

    async fn chat_completions(
        &self,
        _body: Value,
        _ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        GatewayResponse::error(501, self.note.clone(), "not_implemented")
    }

    async fn messages(&self, _body: Value, _ctx: &GatewayRequestContext) -> GatewayResponse {
        GatewayResponse::error(501, self.note.clone(), "not_implemented")
    }
}

/// First-enabled-alias lookup used by `/v1/models` (port of the registry's
/// `aliasMap` seeding: skip disabled, first mapping wins per alias).
pub fn enabled_mappings(config: &GatewayHubConfig) -> Vec<ModelMapping> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for m in &config.model_mappings {
        if !m.enabled || !seen.insert(m.alias.clone()) {
            continue;
        }
        out.push(m.clone());
    }
    out
}
