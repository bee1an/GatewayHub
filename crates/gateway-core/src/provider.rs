//! Provider registry: the canonical provider list plus status derivation
//! from config + state. Upstream adapters land per-provider on top of this.

use serde_json::Value;

use crate::types::{
    AccountFile, AccountRuntimeState, GatewayHubConfig, JsonMap, ProviderConfig, ProviderState,
    ProviderStatus,
};

/// Canonical provider order — same set the Electron registry knows.
pub const PROVIDERS: &[&str] = &[
    "kiro",
    "codex",
    "windsurf",
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

pub fn provider_config<'a>(config: &'a GatewayHubConfig, name: &str) -> ProviderConfig {
    config
        .providers
        .get(name)
        .map(ProviderConfig::from_value)
        .unwrap_or_default()
}

fn provider_state<'a>(state: &'a JsonMap, name: &str) -> ProviderState {
    state.get(name).map(ProviderState::from_value).unwrap_or_default()
}

fn provider_models(state: &ProviderState) -> Vec<String> {
    let mut ids: Vec<String> = state
        .accounts
        .values()
        .flat_map(|v| AccountRuntimeState::from_value(v).model_ids)
        .collect();
    ids.sort();
    ids.dedup();
    ids
}

/// Build the status snapshot for one provider — enabled/configured flags
/// come from config + scanned accounts; models come from cached state.
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
        use_proxy: cfg.use_proxy,
        accounts: accounts.len(),
    }
}

pub fn describe_all(
    config: &GatewayHubConfig,
    state: &JsonMap,
    accounts: &dyn Fn(&str) -> Vec<AccountFile>,
) -> Vec<ProviderStatus> {
    PROVIDERS
        .iter()
        .map(|name| describe_provider(name, config, state, &accounts(name)))
        .collect()
}

/// The account-request surface every provider adapter will implement.
/// `body` is the raw client payload (OpenAI/Anthropic/Responses shape
/// already normalized upstream of the adapter).
#[allow(dead_code)]
pub trait ProviderAdapter: Send + Sync {
    fn name(&self) -> &'static str;
    fn list_models(&self) -> Vec<String> {
        Vec::new()
    }
}

/// Raw upstream response placeholder — SSE streaming lands with the first
/// real provider; for now everything funnels through `Value` bodies.
#[allow(dead_code)]
pub struct UpstreamResponse {
    pub status: u16,
    pub body: Value,
}
