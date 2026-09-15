//! Provider registry — port of `providerRegistry.ts`: adapter map,
//! alias resolution (`alias` mappings + `provider/model` prefix),
//! dispatch and aggregated status/models.

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::provider::ProviderAdapter;
use crate::types::{
    GatewayHubConfig, GatewayRequestContext, GatewayResponse, ModelMapping, ProviderModel,
    ProviderStatus,
};

pub struct Registry {
    providers: HashMap<String, Arc<dyn ProviderAdapter>>,
    route_to_name: HashMap<String, String>,
    alias_map: HashMap<String, ModelMapping>,
}

impl Registry {
    pub fn new(config: &GatewayHubConfig) -> Self {
        let mut alias_map = HashMap::new();
        for mapping in &config.model_mappings {
            if !mapping.enabled || alias_map.contains_key(&mapping.alias) {
                continue;
            }
            alias_map.insert(mapping.alias.clone(), mapping.clone());
        }
        Self {
            providers: HashMap::new(),
            route_to_name: HashMap::new(),
            alias_map,
        }
    }

    pub fn register(
        &mut self,
        name: impl Into<String>,
        adapter: Arc<dyn ProviderAdapter>,
        route_name: impl Into<String>,
    ) {
        let name = name.into();
        let route = route_name.into();
        self.providers.insert(name.clone(), adapter);
        self.route_to_name.insert(route, name);
    }

    pub fn provider(&self, name: &str) -> Option<Arc<dyn ProviderAdapter>> {
        self.providers.get(name).cloned()
    }

    pub fn provider_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.providers.keys().cloned().collect();
        names.sort();
        names
    }

    /// `resolve(model)` port: alias map → `provider/model` prefix → error.
    /// Colon-before-slash is rejected to match the colon-notation guard.
    pub fn resolve(
        &self,
        model: &str,
    ) -> anyhow::Result<(Arc<dyn ProviderAdapter>, String, String)> {
        let raw = model;
        let slash = raw.find('/');
        if raw.contains(':') && (slash.is_none() || raw.find(':').unwrap() < slash.unwrap()) {
            anyhow::bail!(
                "Invalid model format \"{raw}\". Use \"provider/model\" instead of colon notation."
            );
        }
        if let Some(mapping) = self.alias_map.get(raw) {
            let target = self
                .providers
                .get(&mapping.provider)
                .or_else(|| {
                    self.route_to_name
                        .get(&mapping.provider)
                        .and_then(|n| self.providers.get(n))
                })
                .ok_or_else(|| {
                    anyhow::anyhow!(
                        "Model mapping \"{raw}\" targets unknown provider \"{}\"",
                        mapping.provider
                    )
                })?;
            return Ok((target.clone(), mapping.model.clone(), target.name().into()));
        }
        match slash {
            Some(0) | None => anyhow::bail!(
                "Model \"{raw}\" must be prefixed with a provider, e.g. \"kiro/{raw}\""
            ),
            Some(slash) => {
                let explicit = &raw[..slash];
                let name = self
                    .route_to_name
                    .get(explicit)
                    .ok_or_else(|| anyhow::anyhow!("Unknown provider: {explicit}"))?;
                let provider = self
                    .providers
                    .get(name)
                    .ok_or_else(|| anyhow::anyhow!("Unknown provider: {name}"))?;
                Ok((provider.clone(), raw[slash + 1..].to_string(), name.clone()))
            }
        }
    }

    pub fn route_name(&self, provider_name: &str) -> String {
        self.route_to_name
            .iter()
            .find(|(_, n)| n.as_str() == provider_name)
            .map(|(r, _)| r.clone())
            .unwrap_or_else(|| provider_name.to_string())
    }

    /// `chatCompletions` dispatch: resolve model → provider.
    pub async fn chat_completions(
        &self,
        mut body: Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        match self.resolve(body.get("model").and_then(Value::as_str).unwrap_or("")) {
            Ok((provider, model, _)) => {
                body["model"] = Value::String(model);
                provider.chat_completions(body, ctx).await
            }
            Err(e) => GatewayResponse::error(400, e.to_string(), "invalid_request_error"),
        }
    }

    pub async fn messages(&self, mut body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        match self.resolve(body.get("model").and_then(Value::as_str).unwrap_or("")) {
            Ok((provider, model, _)) => {
                body["model"] = Value::String(model);
                provider.messages(body, ctx).await
            }
            Err(e) => GatewayResponse::error(400, e.to_string(), "invalid_request_error"),
        }
    }

    pub async fn count_tokens(
        &self,
        mut body: Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        match self.resolve(body.get("model").and_then(Value::as_str).unwrap_or("")) {
            Ok((provider, model, _)) => {
                body["model"] = Value::String(model);
                provider.count_tokens(body, ctx).await.unwrap_or_else(|| {
                    GatewayResponse::error(
                        501,
                        "count_tokens is not implemented for this provider",
                        "not_implemented",
                    )
                })
            }
            Err(e) => GatewayResponse::error(400, e.to_string(), "invalid_request_error"),
        }
    }

    /// `listModels` port: aliases first (marked by their target), then each
    /// provider's models as `routeName/model`, deduped.
    pub async fn list_models(&self) -> Vec<ProviderModel> {
        let mut result = Vec::new();
        let mut mapped_originals = std::collections::HashSet::new();
        for mapping in self.alias_map.values() {
            let route = self.route_name(&mapping.provider);
            result.push(ProviderModel {
                id: mapping.alias.clone(),
                provider: mapping.provider.clone(),
                owned_by: Some(route.clone()),
                description: Some(
                    mapping
                        .note
                        .clone()
                        .unwrap_or_else(|| format!("→ {route}/{}", mapping.model)),
                ),
            });
            mapped_originals.insert(format!("{route}/{}", mapping.model));
        }
        for (name, provider) in &self.providers {
            let route = self.route_name(name);
            for model in provider.list_models().await {
                let full = format!("{route}/{}", model.id);
                if mapped_originals.contains(&full) {
                    continue;
                }
                result.push(ProviderModel {
                    id: full,
                    provider: name.clone(),
                    owned_by: Some(route.clone()),
                    description: model.description,
                });
            }
        }
        let mut seen = std::collections::HashSet::new();
        result
            .into_iter()
            .filter(|m| seen.insert(m.id.clone()))
            .collect()
    }

    pub fn statuses(&self) -> Vec<ProviderStatus> {
        let mut out: Vec<ProviderStatus> = self
            .providers
            .iter()
            .map(|(name, p)| {
                let mut s = p.status();
                s.name = self.route_name(name);
                s.provider_type = name.clone();
                s
            })
            .collect();
        out.sort_by(|a, b| a.provider_type.cmp(&b.provider_type));
        out
    }
}
