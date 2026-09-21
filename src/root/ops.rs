//! Shell-level actions — server toggle, API keys, model mappings, logs,
//! server config edits, sidebar visibility, language, provider flags.

use gpui_kit::prelude::*;
use gpui_kit::*;

use super::*;

impl AppRoot {
    pub(crate) fn toggle_server(&mut self, cx: &mut Context<Self>) {
        if self.server_pending {
            return;
        }
        self.server_pending = true;
        let service = self.service.clone();
        let running = service.server_running();
        let svc = service.clone();
        let handle = service.spawn_ui(async move {
            let result = if running {
                svc.stop_server();
                Ok(())
            } else {
                svc.start_server()
            };
            (result, svc.status())
        });
        cx.spawn(async move |this, cx| {
            let outcome = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.server_pending = false;
                match outcome {
                    Ok((Ok(()), snapshot)) => this.snapshot = Arc::new(snapshot),
                    Ok((Err(e), snapshot)) => {
                        tracing::error!(error = %e, "failed to start gateway server");
                        this.snapshot = Arc::new(snapshot);
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "server task join failed");
                        this.snapshot = Arc::new(this.service.status());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn add_api_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.key_name_input.read(cx).value().trim().to_string();
        if name.is_empty() {
            return;
        }
        // Non-"all" scope with nothing selected = unusable key; guard.
        if !self.key_scope_all && self.key_scopes.is_empty() {
            return;
        }
        let now = gateway_core::pool::now_ms();
        let key = generate_api_key();
        let mut cfg = self.service.config();
        cfg.server.api_keys.push(ApiKeyEntry {
            id: uuid::Uuid::new_v4().to_string(),
            key: key.clone(),
            name,
            created_at: now,
            last_used_at: None,
            expires_at: (self.key_expiry_days > 0).then(|| now + self.key_expiry_days * 86_400_000),
            scopes: (!self.key_scope_all).then(|| {
                let mut v: Vec<String> = self.key_scopes.iter().cloned().collect();
                v.sort();
                v
            }),
            extra: Default::default(),
        });
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.new_key = Some(key);
        self.key_scope_all = true;
        self.key_scopes.clear();
        self.key_expiry_days = 0;
        self.key_name_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        self.dismiss_overlay(cx);
        cx.notify();
    }

    pub(crate) fn delete_api_key(&mut self, key_id: &str, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        cfg.server.api_keys.retain(|k| k.id != key_id);
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    /// Mapping overlay: append one target row — provider select plus a
    /// model select fed by that provider's known models (snapshot). Stored
    /// values that aren't listed stay selectable so edits don't silently
    /// drop them; `window.subscribe` rebuilds the model options whenever
    /// the provider pick confirms.
    pub(crate) fn push_map_target_row(
        &mut self,
        provider: String,
        model: String,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let mut items: Vec<String> = gateway_core::provider::LIVE_PROVIDERS
            .iter()
            .map(|s| s.to_string())
            .collect();
        if !provider.is_empty() && !items.contains(&provider) {
            items.push(provider.clone());
        }
        let p = cx.new(|cx| SelectState::new(SearchableVec::new(items), None, window, cx));
        if !provider.is_empty() {
            p.update(cx, |s, cx| s.set_selected_value(&provider, window, cx));
        }

        let m = cx.new(|cx| {
            SelectState::new(
                SearchableVec::new(self.map_model_items(&provider, &model)),
                None,
                window,
                cx,
            )
        });
        if !model.is_empty() {
            m.update(cx, |s, cx| s.set_selected_value(&model, window, cx));
        }

        let root = cx.entity();
        let sub = window.subscribe(&p, cx, move |entity, event, window, cx| {
            let SelectEvent::Confirm(Some(provider)) = event else {
                return;
            };
            let provider = provider.clone();
            root.update(cx, |this, cx| {
                this.map_provider_changed(&entity, &provider, window, cx);
            });
        });
        self.map_target_rows.push(MapTargetRow {
            provider: p,
            model: m,
            _provider_sub: sub,
        });
    }

    /// Models a provider is known to serve (snapshot), with `keep` appended
    /// when absent — edits preserve a stored model that is no longer
    /// advertised. `provider_type` is the provider key mappings store
    /// (`ProviderStatus.name` is the route name).
    fn map_model_items(&self, provider: &str, keep: &str) -> Vec<String> {
        let mut models = self
            .snapshot
            .providers
            .iter()
            .find(|p| p.provider_type == provider)
            .map(|p| p.models.clone())
            .unwrap_or_default();
        if !keep.is_empty() && !models.iter().any(|m| m == keep) {
            models.push(keep.to_string());
        }
        models
    }

    /// Provider pick confirmed on one target row — rebuild that row's model
    /// options and drop the now-stale selection.
    fn map_provider_changed(
        &mut self,
        provider_entity: &Entity<SelectState<SearchableVec<String>>>,
        provider: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let models = self.map_model_items(provider, "");
        let Some(row) = self
            .map_target_rows
            .iter()
            .find(|r| &r.provider == provider_entity)
        else {
            return;
        };
        row.model.update(cx, |s, cx| {
            s.set_items(SearchableVec::new(models), window, cx);
            s.set_selected_index(None, window, cx);
        });
    }

    /// Save the mapping overlay — alias plus every non-empty provider/model
    /// row; replaces `map_editing` or appends a new mapping.
    pub(crate) fn save_mapping_overlay(&mut self, cx: &mut Context<Self>) {
        let lang = self.lang;
        let alias = self.map_alias_input.read(cx).value().trim().to_string();
        let targets: Vec<ModelTarget> = self
            .map_target_rows
            .iter()
            .filter_map(|row| {
                let provider = row
                    .provider
                    .read(cx)
                    .selected_value()
                    .cloned()
                    .unwrap_or_default();
                let model = row
                    .model
                    .read(cx)
                    .selected_value()
                    .cloned()
                    .unwrap_or_default();
                if provider.is_empty() || model.is_empty() {
                    return None;
                }
                Some(ModelTarget { provider, model })
            })
            .collect();
        if alias.is_empty() || targets.is_empty() {
            self.map_err = Some(t(lang, "map_err_required").into());
            cx.notify();
            return;
        }
        self.map_err = None;
        let mut cfg = self.service.config();
        match self.map_editing {
            // Edit keeps the row's enabled/note — the overlay only owns
            // alias + targets.
            Some(ix) if ix < cfg.model_mappings.len() => {
                let m = &mut cfg.model_mappings[ix];
                m.alias = alias;
                m.set_targets(targets);
            }
            _ => {
                let mut mapping = ModelMapping {
                    alias,
                    provider: String::new(),
                    model: String::new(),
                    targets: Vec::new(),
                    enabled: true,
                    note: None,
                    extra: Default::default(),
                };
                mapping.set_targets(targets);
                cfg.model_mappings.push(mapping);
            }
        }
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.map_editing = None;
        self.dismiss_overlay(cx);
        cx.notify();
    }

    pub(crate) fn toggle_mapping(&mut self, ix: usize, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        if let Some(m) = cfg.model_mappings.get_mut(ix) {
            m.enabled = !m.enabled;
        }
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    pub(crate) fn delete_mapping(&mut self, ix: usize, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        if ix < cfg.model_mappings.len() {
            cfg.model_mappings.remove(ix);
        }
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    pub(crate) fn clear_logs(&mut self, cx: &mut Context<Self>) {
        self.service.clear_logs();
        self.log_notice = None;
        // render_logs reads the cached snapshot, which the 5s poll only
        // replaces on its next tick — mirror the cleared state into it
        // now so the list empties on this repaint instead of up to 5s
        // later. Rebuild field-wise rather than Arc::make_mut so the old
        // (possibly large) logs vec is never cloned just to be dropped.
        self.snapshot = Arc::new(GatewayStatusSnapshot {
            server: self.snapshot.server.clone(),
            config_path: self.snapshot.config_path.clone(),
            state_path: self.snapshot.state_path.clone(),
            providers: self.snapshot.providers.clone(),
            logs: Vec::new(),
        });
        cx.notify();
    }

    pub(crate) fn export_logs(&mut self, cx: &mut Context<Self>) {
        if self.exporting_logs {
            return;
        }
        self.exporting_logs = true;
        let service = self.service.clone();
        let svc = service.clone();
        let handle = service.spawn_ui(async move {
            svc.export_logs()
                .map(|p| p.display().to_string())
                .map_err(|e| e.to_string())
        });
        cx.spawn(async move |this, cx| {
            let result = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.exporting_logs = false;
                let lang = this.lang;
                this.log_notice = Some(match result {
                    Ok(Ok(path)) => tf(lang, "exported", &[("path", &path)]),
                    Ok(Err(e)) => tf(lang, "export_failed", &[("e", &e)]),
                    Err(e) => tf(lang, "export_failed", &[("e", &e.to_string())]),
                });
                this.notice_nonce += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn save_server_config(
        &mut self,
        update: impl FnOnce(&mut gateway_core::GatewayServerConfig),
        cx: &mut Context<Self>,
    ) {
        let lang = self.lang;
        let mut cfg = self.service.config();
        update(&mut cfg.server);
        self.settings_notice = Some(match self.service.save_config(cfg) {
            Ok(()) if self.service.server_running() => t(lang, "saved_restart").into(),
            Ok(()) => t(lang, "saved").into(),
            Err(e) => tf(lang, "save_failed", &[("e", &e.to_string())]),
        });
        self.notice_nonce += 1;
        cx.notify();
    }

    pub(crate) fn apply_port(&mut self, cx: &mut Context<Self>) {
        let lang = self.lang;
        let port_raw = self.port_input.read(cx).value().trim().to_string();
        let Ok(port) = port_raw.parse::<u16>() else {
            self.settings_notice = Some(tf(lang, "invalid_port", &[("port", &port_raw)]));
            self.shake_nonce += 1;
            self.notice_nonce += 1;
            cx.notify();
            return;
        };
        self.save_server_config(|server| server.port = port, cx);
    }

    pub(crate) fn apply_proxy(&mut self, cx: &mut Context<Self>) {
        let proxy = self.proxy_input.read(cx).value().trim().to_string();
        self.save_server_config(|server| server.proxy_url = proxy, cx);
    }

    pub(crate) fn set_listen_on_lan(
        &mut self,
        listen_on_lan: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let host = if listen_on_lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        };
        self.host_input
            .update(cx, |input, cx| input.set_value(host, window, cx));
        self.save_server_config(|server| server.host = host.into(), cx);
    }

    pub(crate) fn toggle_autostart(&mut self, cx: &mut Context<Self>) {
        let lang = self.lang;
        let mut cfg = self.service.config();
        cfg.server.auto_start = !cfg.server.auto_start;
        self.settings_notice = match self.service.save_config(cfg) {
            Ok(()) => None,
            Err(e) => {
                tracing::error!(error = %e, "save config failed");
                Some(tf(lang, "save_failed_short", &[("e", &e.to_string())]))
            }
        };
        self.notice_nonce += 1;
        cx.notify();
    }

    pub(crate) fn set_sidebar_provider_visible(
        &mut self,
        provider: &str,
        visible: bool,
        cx: &mut Context<Self>,
    ) {
        if visible {
            self.hidden_providers.remove(provider);
        } else {
            self.hidden_providers.insert(provider.to_string());
        }
        self.persist_sidebar_visibility();
        cx.notify();
    }

    pub(crate) fn show_all_sidebar_providers(&mut self, cx: &mut Context<Self>) {
        self.hidden_providers.clear();
        self.persist_sidebar_visibility();
        cx.notify();
    }

    pub(crate) fn persist_sidebar_visibility(&self) {
        let mut cfg = self.service.config();
        write_hidden_providers(&mut cfg, &self.hidden_providers);
        if let Err(error) = self.service.save_config(cfg) {
            tracing::error!(%error, "failed to persist sidebar visibility");
        }
    }

    pub(crate) fn set_language(&mut self, lang: Lang, cx: &mut Context<Self>) {
        self.lang = lang;
        let mut cfg = self.service.config();
        write_lang(&mut cfg, lang);
        if let Err(error) = self.service.save_config(cfg) {
            tracing::error!(%error, "failed to persist language");
        }
        cx.notify();
    }

    /// Playground API format — persisted like the other UI prefs.
    pub(crate) fn set_pg_api_type(&mut self, api: PgApiType, cx: &mut Context<Self>) {
        self.pg_api_type = api;
        let mut cfg = self.service.config();
        write_pg_api_type(&mut cfg, api);
        if let Err(error) = self.service.save_config(cfg) {
            tracing::error!(%error, "failed to persist playground API type");
        }
        cx.notify();
    }

    /// Provider-level enable / proxy toggles — config write + registry
    /// rebuild so the change takes effect for new requests.
    pub(crate) fn toggle_provider_flag(
        &mut self,
        provider: &str,
        flag: &'static str,
        cx: &mut Context<Self>,
    ) {
        let mut cfg = self.service.config();
        let entry = cfg
            .providers
            .entry(provider.to_string())
            .or_insert_with(|| serde_json::json!({}));
        let mut pcfg = gateway_core::ProviderConfig::from_value(entry);
        match flag {
            "enabled" => pcfg.enabled = !pcfg.enabled,
            "useProxy" => pcfg.use_proxy = Some(!pcfg.use_proxy.unwrap_or(false)),
            _ => {}
        }
        *entry = serde_json::to_value(&pcfg).unwrap_or_default();
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.provider_pending.insert(provider.to_string());
        self.reload_serial += 1;
        self.queue_registry_reload(cx);
        cx.notify();
    }

    /// Registry rebuild scans every provider's account dir and constructs
    /// adapters — keep it off the UI thread. Rapid toggles coalesce: each
    /// rebuild reads the latest config, so a queued change triggers at most
    /// one follow-up run.
    pub(crate) fn queue_registry_reload(&mut self, cx: &mut Context<Self>) {
        if self.rebuild_running {
            return;
        }
        self.rebuild_running = true;
        self.spawn_registry_rebuild(cx);
    }

    pub(crate) fn spawn_registry_rebuild(&mut self, cx: &mut Context<Self>) {
        let service = self.service.clone();
        let svc = service.clone();
        let applied = self.reload_serial;
        let handle = service.spawn_ui(async move {
            svc.reload_registry();
            svc.status()
        });
        cx.spawn(async move |this, cx| {
            let snapshot = handle.await;
            let _ = this.update(cx, |this, cx| {
                if let Ok(snapshot) = snapshot {
                    this.snapshot = Arc::new(snapshot);
                }
                if this.reload_serial == applied {
                    // No new toggles arrived during the rebuild — converged.
                    this.provider_pending.clear();
                    this.rebuild_running = false;
                } else {
                    // Toggles landed mid-rebuild — run once more.
                    this.spawn_registry_rebuild(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }
}
