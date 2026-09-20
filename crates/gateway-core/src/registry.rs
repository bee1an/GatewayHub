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

/// Which provider entrypoint a failover pass invokes.
#[derive(Debug, Clone, Copy)]
enum TargetOp {
    ChatCompletions,
    Messages,
    CountTokens,
}

pub struct Registry {
    providers: HashMap<String, Arc<dyn ProviderAdapter>>,
    route_to_name: HashMap<String, String>,
    alias_map: HashMap<String, ModelMapping>,
    /// Configured `useProxy` per provider — adapters hardcode the field in
    /// their `status()`, so the registry carries the live flag itself.
    use_proxy: HashMap<String, bool>,
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
            use_proxy: HashMap::new(),
        }
    }

    pub fn register(
        &mut self,
        name: impl Into<String>,
        adapter: Arc<dyn ProviderAdapter>,
        route_name: impl Into<String>,
        use_proxy: Option<bool>,
    ) {
        let name = name.into();
        let route = route_name.into();
        if let Some(v) = use_proxy {
            self.use_proxy.insert(name.clone(), v);
        }
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

    /// `resolve(model)` port, extended for multi-target mappings: alias map →
    /// `provider/model` prefix → error. An alias resolves to its ordered
    /// failover targets (unreachable providers skipped); an explicit
    /// `provider/model` yields a single-element list.
    /// Colon-before-slash is rejected to match the colon-notation guard.
    fn resolve_targets(
        &self,
        model: &str,
    ) -> anyhow::Result<Vec<(Arc<dyn ProviderAdapter>, String)>> {
        let raw = model;
        let slash = raw.find('/');
        if raw.contains(':')
            && (slash.is_none()
                || raw.find(':').expect("validated invariant")
                    < slash.expect("validated invariant"))
        {
            anyhow::bail!(
                "Invalid model format \"{raw}\". Use \"provider/model\" instead of colon notation."
            );
        }
        if let Some(mapping) = self.alias_map.get(raw) {
            let mut resolved = Vec::new();
            for target in mapping.targets() {
                let provider = self.providers.get(&target.provider).or_else(|| {
                    self.route_to_name
                        .get(&target.provider)
                        .and_then(|n| self.providers.get(n))
                });
                match provider {
                    Some(p) => resolved.push((p.clone(), target.model)),
                    None => tracing::warn!(
                        "model mapping \"{raw}\" skips unknown provider \"{}\"",
                        target.provider
                    ),
                }
            }
            if resolved.is_empty() {
                anyhow::bail!("Model mapping \"{raw}\" has no reachable provider targets");
            }
            return Ok(resolved);
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
                Ok(vec![(provider.clone(), raw[slash + 1..].to_string())])
            }
        }
    }

    /// Ordered failover across a mapping's targets: invoke each in turn,
    /// advancing on failover-eligible statuses (5xx, 429, 401, 403 —
    /// gateway-side outages, rate limits, or dead credentials). 4xx
    /// request-shape errors are returned as-is. An `Sse` response is
    /// committed once returned — a mid-stream failure surfaces inside the
    /// stream and cannot fail over.
    async fn with_failover(
        &self,
        targets: Vec<(Arc<dyn ProviderAdapter>, String)>,
        mut body: Value,
        ctx: &GatewayRequestContext,
        op: TargetOp,
    ) -> GatewayResponse {
        let last = targets.len() - 1;
        let mut last_response = None;
        for (ix, (provider, model)) in targets.into_iter().enumerate() {
            body["model"] = Value::String(model.clone());
            let response = match op {
                TargetOp::ChatCompletions => provider.chat_completions(body.clone(), ctx).await,
                TargetOp::Messages => provider.messages(body.clone(), ctx).await,
                // `None` → 501, which is itself failover-eligible and moves
                // to the next target; an all-unsupported alias ends on 501.
                TargetOp::CountTokens => provider
                    .count_tokens(body.clone(), ctx)
                    .await
                    .unwrap_or_else(|| {
                        GatewayResponse::error(
                            501,
                            "count_tokens is not implemented for this provider",
                            "not_implemented",
                        )
                    }),
            };
            let status = response.status();
            let failover = status >= 500 || status == 429 || status == 401 || status == 403;
            if !failover || ix == last {
                return response;
            }
            tracing::warn!(
                "mapping target {}/{} returned {status}; failing over",
                provider.name(),
                model
            );
            last_response = Some(response);
        }
        last_response.expect("targets is non-empty")
    }

    pub fn route_name(&self, provider_name: &str) -> String {
        self.route_to_name
            .iter()
            .find(|(_, n)| n.as_str() == provider_name)
            .map(|(r, _)| r.clone())
            .unwrap_or_else(|| provider_name.to_string())
    }

    /// `chatCompletions` dispatch: resolve model → provider targets → failover.
    pub async fn chat_completions(
        &self,
        body: Value,
        ctx: &GatewayRequestContext,
    ) -> GatewayResponse {
        match self.resolve_targets(body.get("model").and_then(Value::as_str).unwrap_or("")) {
            Ok(targets) => {
                self.with_failover(targets, body, ctx, TargetOp::ChatCompletions)
                    .await
            }
            Err(e) => GatewayResponse::error(400, e.to_string(), "invalid_request_error"),
        }
    }

    pub async fn messages(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        match self.resolve_targets(body.get("model").and_then(Value::as_str).unwrap_or("")) {
            Ok(targets) => {
                self.with_failover(targets, body, ctx, TargetOp::Messages)
                    .await
            }
            Err(e) => GatewayResponse::error(400, e.to_string(), "invalid_request_error"),
        }
    }

    pub async fn count_tokens(&self, body: Value, ctx: &GatewayRequestContext) -> GatewayResponse {
        match self.resolve_targets(body.get("model").and_then(Value::as_str).unwrap_or("")) {
            Ok(targets) => {
                self.with_failover(targets, body, ctx, TargetOp::CountTokens)
                    .await
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
            let targets = mapping.targets();
            let Some(primary) = targets.first() else {
                continue;
            };
            let route = self.route_name(&primary.provider);
            let extra = targets.len() - 1;
            result.push(ProviderModel {
                id: mapping.alias.clone(),
                provider: primary.provider.clone(),
                owned_by: Some(route.clone()),
                description: Some(mapping.note.clone().unwrap_or_else(|| {
                    format!(
                        "→ {route}/{}{}",
                        primary.model,
                        if extra > 0 {
                            format!(" +{extra}")
                        } else {
                            String::new()
                        }
                    )
                })),
            });
            for target in &targets {
                let route = self.route_name(&target.provider);
                mapped_originals.insert(format!("{route}/{}", target.model));
            }
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
                // Adapters hardcode `use_proxy: None` — report the flag the
                // build pass recorded instead, or the proxy toggle can
                // never reflect what the user saved.
                if crate::provider::PROXY_CAPABLE.contains(&name.as_str()) {
                    s.use_proxy = Some(self.use_proxy.get(name).copied().unwrap_or(false));
                }
                s
            })
            .collect();
        out.sort_by(|a, b| a.provider_type.cmp(&b.provider_type));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ApiFormat, GatewayRequestContext, ModelTarget, ProviderStatus};
    use std::collections::VecDeque;
    use std::sync::Mutex;

    /// Provider stub that pops one status per call and records the model it
    /// was invoked with.
    struct StubProvider {
        name: &'static str,
        statuses: Mutex<VecDeque<u16>>,
        calls: Mutex<Vec<String>>,
        listed_model: Option<String>,
    }

    impl StubProvider {
        fn new(name: &'static str, statuses: &[u16], listed_model: Option<String>) -> Self {
            Self {
                name,
                statuses: Mutex::new(statuses.iter().copied().collect()),
                calls: Mutex::new(Vec::new()),
                listed_model,
            }
        }

        fn respond(&self, body: &Value) -> GatewayResponse {
            let model = body["model"].as_str().unwrap_or("").to_string();
            self.calls.lock().unwrap().push(model);
            let status = self.statuses.lock().unwrap().pop_front().unwrap_or(200);
            if status >= 400 {
                GatewayResponse::error(status, format!("status {status}"), "test_error")
            } else {
                GatewayResponse::json(status, serde_json::json!({ "ok": true }))
            }
        }
    }

    #[async_trait::async_trait]
    impl ProviderAdapter for StubProvider {
        fn name(&self) -> &'static str {
            self.name
        }

        fn status(&self) -> ProviderStatus {
            ProviderStatus {
                name: self.name.into(),
                provider_type: self.name.into(),
                display_name: None,
                enabled: true,
                configured: true,
                status: "ready",
                message: None,
                models: Vec::new(),
                use_proxy: None,
                accounts: 0,
            }
        }

        async fn list_models(&self) -> Vec<ProviderModel> {
            self.listed_model
                .iter()
                .map(|id| ProviderModel {
                    id: id.clone(),
                    provider: self.name.into(),
                    owned_by: None,
                    description: None,
                })
                .collect()
        }

        async fn chat_completions(
            &self,
            body: Value,
            _ctx: &GatewayRequestContext,
        ) -> GatewayResponse {
            self.respond(&body)
        }

        async fn messages(&self, body: Value, _ctx: &GatewayRequestContext) -> GatewayResponse {
            self.respond(&body)
        }
    }

    fn ctx() -> GatewayRequestContext {
        GatewayRequestContext {
            request_id: "test".into(),
            session_id: None,
            session_source: None,
            api_format: ApiFormat::OpenAi,
            on_usage: None,
            cancel: tokio_util::sync::CancellationToken::new(),
        }
    }

    fn target(provider: &str, model: &str) -> ModelTarget {
        ModelTarget {
            provider: provider.into(),
            model: model.into(),
        }
    }

    fn mapping(alias: &str, targets: Vec<ModelTarget>) -> ModelMapping {
        let mut m = ModelMapping {
            alias: alias.into(),
            provider: String::new(),
            model: String::new(),
            targets: Vec::new(),
            enabled: true,
            note: None,
            extra: Default::default(),
        };
        m.set_targets(targets);
        m
    }

    fn registry(mappings: Vec<ModelMapping>, providers: Vec<Arc<StubProvider>>) -> Registry {
        let config = GatewayHubConfig {
            model_mappings: mappings,
            ..Default::default()
        };
        let mut registry = Registry::new(&config);
        for provider in providers {
            let name = provider.name;
            registry.register(name, provider as Arc<dyn ProviderAdapter>, name, None);
        }
        registry
    }

    #[tokio::test]
    async fn fails_over_to_next_target_on_5xx() {
        let p1 = Arc::new(StubProvider::new("p1", &[500], None));
        let p2 = Arc::new(StubProvider::new("p2", &[200], None));
        let registry = registry(
            vec![mapping(
                "alias",
                vec![target("p1", "m1"), target("p2", "m2")],
            )],
            vec![p1.clone(), p2.clone()],
        );

        let res = registry
            .chat_completions(serde_json::json!({ "model": "alias" }), &ctx())
            .await;
        assert_eq!(res.status(), 200);
        assert_eq!(p1.calls.lock().unwrap().as_slice(), ["m1"]);
        assert_eq!(p2.calls.lock().unwrap().as_slice(), ["m2"]);
    }

    #[tokio::test]
    async fn fails_over_on_429_and_auth_errors() {
        for status in [429u16, 401, 403] {
            let p1 = Arc::new(StubProvider::new("p1", &[status], None));
            let p2 = Arc::new(StubProvider::new("p2", &[200], None));
            let registry = registry(
                vec![mapping(
                    "alias",
                    vec![target("p1", "m1"), target("p2", "m2")],
                )],
                vec![p1, p2.clone()],
            );
            let res = registry
                .messages(serde_json::json!({ "model": "alias" }), &ctx())
                .await;
            assert_eq!(res.status(), 200, "status {status} should fail over");
            assert_eq!(p2.calls.lock().unwrap().len(), 1);
        }
    }

    #[tokio::test]
    async fn does_not_fail_over_on_4xx() {
        let p1 = Arc::new(StubProvider::new("p1", &[400], None));
        let p2 = Arc::new(StubProvider::new("p2", &[200], None));
        let registry = registry(
            vec![mapping(
                "alias",
                vec![target("p1", "m1"), target("p2", "m2")],
            )],
            vec![p1, p2.clone()],
        );
        let res = registry
            .chat_completions(serde_json::json!({ "model": "alias" }), &ctx())
            .await;
        assert_eq!(res.status(), 400);
        assert!(p2.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn returns_last_response_when_all_targets_fail() {
        let p1 = Arc::new(StubProvider::new("p1", &[503], None));
        let p2 = Arc::new(StubProvider::new("p2", &[429], None));
        let registry = registry(
            vec![mapping(
                "alias",
                vec![target("p1", "m1"), target("p2", "m2")],
            )],
            vec![p1, p2],
        );
        let res = registry
            .chat_completions(serde_json::json!({ "model": "alias" }), &ctx())
            .await;
        assert_eq!(res.status(), 429);
    }

    #[tokio::test]
    async fn skips_unreachable_targets() {
        let p2 = Arc::new(StubProvider::new("p2", &[200], None));
        let registry = registry(
            vec![mapping(
                "alias",
                vec![target("gone", "m1"), target("p2", "m2")],
            )],
            vec![p2.clone()],
        );
        let res = registry
            .chat_completions(serde_json::json!({ "model": "alias" }), &ctx())
            .await;
        assert_eq!(res.status(), 200);
        assert_eq!(p2.calls.lock().unwrap().as_slice(), ["m2"]);
    }

    #[tokio::test]
    async fn legacy_provider_model_mapping_still_resolves() {
        let p1 = Arc::new(StubProvider::new("p1", &[200], None));
        // Legacy shape: provider/model fields, no targets — as written by
        // older builds and still accepted from disk.
        let json = serde_json::json!({
            "alias": "alias", "provider": "p1", "model": "m1", "enabled": true
        });
        let parsed: ModelMapping = serde_json::from_value(json).unwrap();
        assert_eq!(parsed.targets().len(), 1);
        assert_eq!(parsed.targets()[0].provider, "p1");

        let registry = registry(vec![parsed], vec![p1.clone()]);
        let res = registry
            .chat_completions(serde_json::json!({ "model": "alias" }), &ctx())
            .await;
        assert_eq!(res.status(), 200);
        assert_eq!(p1.calls.lock().unwrap().as_slice(), ["m1"]);
    }

    #[tokio::test]
    async fn explicit_provider_model_routing_unchanged() {
        let p1 = Arc::new(StubProvider::new("p1", &[200], None));
        let p2 = Arc::new(StubProvider::new("p2", &[200], None));
        let registry = registry(
            vec![mapping("alias", vec![target("p1", "m1")])],
            vec![p1.clone(), p2.clone()],
        );
        let res = registry
            .chat_completions(serde_json::json!({ "model": "p2/direct" }), &ctx())
            .await;
        assert_eq!(res.status(), 200);
        assert!(p1.calls.lock().unwrap().is_empty());
        assert_eq!(p2.calls.lock().unwrap().as_slice(), ["direct"]);
    }

    #[tokio::test]
    async fn list_models_hides_every_mapped_target() {
        let p1 = Arc::new(StubProvider::new("p1", &[200], Some("m1".into())));
        let p2 = Arc::new(StubProvider::new("p2", &[200], Some("m2".into())));
        let registry = registry(
            vec![mapping(
                "alias",
                vec![target("p1", "m1"), target("p2", "m2")],
            )],
            vec![p1, p2],
        );
        let ids: Vec<String> = registry
            .list_models()
            .await
            .into_iter()
            .map(|m| m.id)
            .collect();
        assert!(ids.contains(&"alias".to_string()));
        assert!(!ids.contains(&"p1/m1".to_string()));
        assert!(!ids.contains(&"p2/m2".to_string()));
    }
}
