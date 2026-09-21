//! Provider account operations — cache refresh, toggle/delete/import,
//! CLI login and Discover flows, account test/check-in, model refresh.

use gpui_kit::prelude::*;
use gpui_kit::*;

use super::*;

impl AppRoot {
    /// Rescan one provider's account dir into the cache after a mutation.
    pub(crate) fn refresh_accounts_cache(&mut self, provider: &str) {
        let accounts = self.service.accounts(provider);
        self.accounts_cache.insert(provider.to_string(), accounts);
    }

    pub(crate) fn toggle_account(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        let mut account = self
            .accounts_cache
            .get(provider)
            .and_then(|list| list.iter().find(|a| a.id == account_id))
            .cloned()
            .or_else(|| {
                self.service
                    .accounts(provider)
                    .into_iter()
                    .find(|a| a.id == account_id)
            });
        if let Some(acc) = account.as_mut() {
            acc.enabled = !acc.enabled;
            if let Err(e) = self.service.store().write_account(provider, acc) {
                tracing::error!(error = %e, "write account failed");
            } else {
                self.refresh_accounts_cache(provider);
            }
        }
        cx.notify();
    }

    pub(crate) fn delete_account(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        match self.service.store().delete_account(provider, account_id) {
            Ok(_) => self.refresh_accounts_cache(provider),
            Err(e) => tracing::error!(error = %e, "delete account failed"),
        }
        cx.notify();
    }

    pub(crate) fn import_account(
        &mut self,
        provider: &str,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let lang = self.lang;
        let raw = self.import_input.read(cx).value().trim().to_string();
        if raw.is_empty() {
            return;
        }
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) if v.is_object() => {
                let mut account: gateway_core::AccountFile =
                    serde_json::from_value(v).unwrap_or_default();
                if account.id.is_empty() {
                    account.id = uuid::Uuid::new_v4().to_string();
                }
                if !raw.contains("\"enabled\"") {
                    account.enabled = true;
                }
                match self.service.store().write_account(provider, &account) {
                    Ok(path) => {
                        self.import_result = Some(tf(
                            lang,
                            "imported",
                            &[("path", &path.display().to_string())],
                        ));
                        self.refresh_accounts_cache(provider);
                        self.import_input.update(cx, |input, cx| {
                            input.set_value("", window, cx);
                        });
                        self.dismiss_overlay(cx);
                    }
                    Err(e) => {
                        self.import_result =
                            Some(tf(lang, "import_failed", &[("e", &e.to_string())]));
                    }
                }
            }
            _ => {
                self.import_result = Some(t(lang, "invalid_json").into());
            }
        }
        self.notice_nonce += 1;
        cx.notify();
    }

    // ==================== CLI add-account flow (kiro/qoder) ====================

    /// Whether the provider offers the detect + CLI-login pane.
    pub(crate) fn cli_capable(provider: &str) -> bool {
        gateway_core::cli_login::cli_bin(provider).is_some()
    }

    /// Detect the provider's CLI binary once per overlay open — stat +
    /// `--version` stay off the UI thread.
    pub(crate) fn start_cli_detect(&mut self, provider: &str, cx: &mut Context<Self>) {
        self.cli_detecting = true;
        self.cli_detect = None;
        let service = self.service.clone();
        let svc = service.clone();
        let name = provider.to_string();
        let handle = service.spawn_ui(async move { svc.detect_provider_cli(&name, None).await });
        cx.spawn(async move |this, cx| {
            let result = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.cli_detecting = false;
                this.cli_detect = result.ok().and_then(|r| r.ok());
                cx.notify();
            });
        })
        .detach();
    }

    /// "Log in via CLI" — the subprocess output streams into
    /// `cli_login_output`; a harvested account goes through the same
    /// write + reload path as the JSON import.
    pub(crate) fn begin_cli_login(&mut self, cx: &mut Context<Self>) {
        let Some(provider) = self.cli_provider.clone() else {
            return;
        };
        let cli_path = self
            .cli_detect
            .as_ref()
            .map(|d| d.path.clone())
            .filter(|p| !p.is_empty());
        let mut rx = match self.service.start_cli_login(&provider, cli_path, None) {
            Ok(rx) => rx,
            Err(e) => {
                self.cli_login_err = Some(e.to_string());
                cx.notify();
                return;
            }
        };
        self.cli_login_active = true;
        self.cli_login_output.clear();
        self.cli_login_err = None;
        self.cli_copy_ok = false;
        cx.spawn(async move |this, cx| {
            while let Some(ev) = rx.recv().await {
                let terminal = matches!(
                    ev,
                    gateway_core::cli_login::CliLoginEvent::Exit { .. }
                        | gateway_core::cli_login::CliLoginEvent::Error(_)
                );
                let updated = this.update(cx, |this, cx| {
                    use gateway_core::cli_login::CliLoginEvent as Ev;
                    match ev {
                        Ev::Stdout(t) | Ev::Stderr(t) => {
                            this.cli_login_output.push_str(&t);
                            this.cli_scroll.scroll_to_bottom();
                        }
                        Ev::Error(e) => {
                            this.cli_login_active = false;
                            this.cli_login_err = Some(e);
                        }
                        Ev::Exit {
                            code,
                            account,
                            error,
                        } => {
                            this.cli_login_active = false;
                            match (account, error) {
                                (Some(acc), _) => this.finish_cli_import(&acc, cx),
                                (None, Some(e)) => this.cli_login_err = Some(e),
                                (None, None) => {
                                    this.cli_login_err = Some(tf(
                                        this.lang,
                                        "cli_failed",
                                        &[("code", &code.to_string())],
                                    ));
                                }
                            }
                        }
                    }
                    cx.notify();
                });
                if updated.is_err() || terminal {
                    break;
                }
            }
        })
        .detach();
    }

    /// Write the harvested account, refresh the page, rebuild the registry —
    /// mirrors the TS `withDaemonReload` after a CLI import.
    pub(crate) fn finish_cli_import(
        &mut self,
        account: &gateway_core::AccountFile,
        cx: &mut Context<Self>,
    ) {
        let Some(provider) = self.cli_provider.clone() else {
            return;
        };
        match self.service.upsert_account(&provider, account) {
            Ok(_) => {
                self.import_result = Some(t(self.lang, "cli_success").into());
                self.notice_nonce += 1;
                self.refresh_accounts_cache(&provider);
                self.provider_pending.insert(provider);
                self.reload_serial += 1;
                self.queue_registry_reload(cx);
                self.cli_login_err = None;
                self.cli_login_output.clear();
                self.dismiss_overlay(cx);
            }
            Err(e) => {
                self.cli_login_err = Some(e.to_string());
            }
        }
    }

    pub(crate) fn cancel_cli_login(&mut self, cx: &mut Context<Self>) {
        if let Some(provider) = &self.cli_provider {
            self.service.cancel_cli_login(provider);
        }
        self.cli_login_active = false;
        self.cli_login_output.clear();
        cx.notify();
    }

    /// Qoder only — harvest the already-logged-in local CLI without running
    /// `login` (TS `addQoderCliLogin`).
    pub(crate) fn import_current_cli_auth(&mut self, cx: &mut Context<Self>) {
        let Some(provider) = self.cli_provider.clone() else {
            return;
        };
        if self.cli_import_busy {
            return;
        }
        self.cli_import_busy = true;
        self.cli_import_msg = None;
        let cli_path = self
            .cli_detect
            .as_ref()
            .map(|d| d.path.clone())
            .filter(|p| !p.is_empty());
        let service = self.service.clone();
        let svc = service.clone();
        let name = provider;
        let handle =
            service.spawn_ui(async move { svc.import_current_cli_auth(&name, cli_path).await });
        cx.spawn(async move |this, cx| {
            let result = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.cli_import_busy = false;
                match result {
                    Ok(Ok(acc)) => this.finish_cli_import(&acc, cx),
                    Ok(Err(e)) => this.cli_import_msg = Some(e.to_string()),
                    Err(_) => {}
                }
                cx.notify();
            });
        })
        .detach();
    }

    // ==================== Discover add-account flow ====================

    /// Whether the provider offers the local-credential scan tab.
    pub(crate) fn discover_capable(provider: &str) -> bool {
        gateway_core::discover::discover_capable(provider)
    }

    /// Whether the scan is live for the provider (vs. coming-soon placeholder).
    pub(crate) fn discover_live(provider: &str) -> bool {
        gateway_core::discover::discover_live(provider)
    }

    /// Whether the provider itself is open for use — non-live providers are
    /// listed everywhere as coming-soon placeholders.
    pub(crate) fn provider_live(provider: &str) -> bool {
        gateway_core::provider::provider_live(provider)
    }

    /// Scan once per overlay open — fs/sqlite reads stay off the UI thread.
    /// Default-selects everything importable (`!existing || updatable`), same
    /// as the Electron dialog.
    pub(crate) fn start_discover_scan(&mut self, provider: &str, cx: &mut Context<Self>) {
        if !Self::discover_live(provider) {
            return;
        }
        self.discover_loading = true;
        self.discover_candidates.clear();
        self.discover_selected.clear();
        let service = self.service.clone();
        let svc = service.clone();
        let name = provider.to_string();
        let handle = service.spawn_ui(async move { svc.scan_provider_accounts(&name) });
        cx.spawn(async move |this, cx| {
            let candidates = handle.await.unwrap_or_default();
            let _ = this.update(cx, |this, cx| {
                this.discover_loading = false;
                this.discover_selected = candidates
                    .iter()
                    .filter(|c| !c.existing || c.updatable)
                    .map(|c| c.account.id.clone())
                    .collect();
                this.discover_candidates = candidates;
                cx.notify();
            });
        })
        .detach();
    }

    pub(crate) fn toggle_discover_candidate(
        &mut self,
        id: &str,
        checked: bool,
        cx: &mut Context<Self>,
    ) {
        if checked {
            self.discover_selected.insert(id.to_string());
        } else {
            self.discover_selected.remove(id);
        }
        cx.notify();
    }

    /// "Add (n)" — rescan + write on the UI runtime (credentials may have
    /// rotated since the dialog's scan, matching `importScanned*Accounts`),
    /// then refresh the page and rebuild the registry like a JSON import.
    pub(crate) fn import_discover_selected(&mut self, cx: &mut Context<Self>) {
        let Some(provider) = self.cli_provider.clone() else {
            return;
        };
        if self.discover_import_busy || self.discover_selected.is_empty() {
            return;
        }
        self.discover_import_busy = true;
        let ids: Vec<String> = self.discover_selected.iter().cloned().collect();
        let service = self.service.clone();
        let svc = service.clone();
        let name = provider.clone();
        let handle = service.spawn_ui(async move { svc.import_scanned_accounts(&name, &ids) });
        cx.spawn(async move |this, cx| {
            let (added, updated) = handle.await.unwrap_or((0, 0));
            let _ = this.update(cx, |this, cx| {
                this.discover_import_busy = false;
                if added + updated > 0 {
                    this.import_result = Some(tf(
                        this.lang,
                        "discover_imported",
                        &[
                            ("added", &added.to_string()),
                            ("updated", &updated.to_string()),
                        ],
                    ));
                    this.notice_nonce += 1;
                    this.refresh_accounts_cache(&provider);
                    this.provider_pending.insert(provider.clone());
                    this.reload_serial += 1;
                    this.queue_registry_reload(cx);
                    this.dismiss_overlay(cx);
                } else {
                    this.cli_login_err = Some(t(this.lang, "discover_none").into());
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Load a provider's account files on the UI runtime so opening a
    /// detail page never blocks on disk.
    pub(crate) fn load_accounts(&mut self, provider: &str, cx: &mut Context<Self>) {
        if !self.accounts_pending.insert(provider.to_string()) {
            return;
        }
        let service = self.service.clone();
        let name = provider.to_string();
        let (svc, task_name) = (service.clone(), name.clone());
        let handle = service.spawn_ui(async move { svc.accounts(&task_name) });
        cx.spawn(async move |this, cx| {
            let accounts = handle.await.unwrap_or_default();
            let _ = this.update(cx, |this, cx| {
                this.accounts_pending.remove(&name);
                this.accounts_cache.insert(name, accounts);
                cx.notify();
            });
        })
        .detach();
    }

    /// Open a provider's detail page — accounts scan on the UI runtime,
    /// runtime states read from the in-memory state mirror.
    pub(crate) fn open_detail(&mut self, provider: &str, cx: &mut Context<Self>) {
        self.detail = Some(provider.to_string());
        let states = self.service.account_states(provider);
        self.account_states.insert(provider.to_string(), states);
        if !self.accounts_cache.contains_key(provider) {
            self.load_accounts(provider, cx);
        }
    }

    pub(crate) fn test_account(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        let lang = self.lang;
        let key = format!("{provider}/{account_id}");
        if self.test_pending.contains(&key) {
            return;
        }
        let Some(adapter) = self.service.registry().provider(provider) else {
            self.test_results
                .insert(key, t(lang, "provider_not_loaded").into());
            return;
        };
        let account_id = account_id.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.service.spawn_ui(async move {
            let result = adapter.test_account(&account_id).await;
            let _ = tx.send(result);
        });
        self.test_results
            .insert(key.clone(), t(lang, "testing").into());
        self.test_pending.insert(key.clone());
        let started = Instant::now();
        cx.spawn(async move |this, cx| {
            let result = rx.await;
            hold_spinner(started, cx).await;
            let _ = this.update(cx, |this, cx| {
                this.test_pending.remove(&key);
                let lang = this.lang;
                match result {
                    Ok(result) => {
                        // Multi-line activity log — what the probe actually
                        // did (auth probe, metadata refresh, model count).
                        let stamp = clock_time(gateway_core::pool::now_ms() / 1000);
                        let prefix = t(
                            lang,
                            if result.ok {
                                "ok_prefix"
                            } else {
                                "fail_prefix"
                            },
                        );
                        let mut lines = vec![format!("[{stamp}] {prefix}{}", result.message)];
                        if let Some(auth_type) = &result.auth_type {
                            lines.push(format!("auth_type: {auth_type}"));
                        }
                        if let Some(expires) = &result.expires_at {
                            lines.push(format!("expires_at: {expires}"));
                        }
                        if !result.models.is_empty() {
                            lines.push(
                                tf(lang, "models_n", &[("n", &result.models.len().to_string())])
                                    .to_string(),
                            );
                        }
                        this.test_results.insert(key, lines.join("\n"));
                    }
                    Err(_) => {
                        this.test_results
                            .insert(key, t(lang, "request_failed").into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Daily check-in for one account — TraeWork/WorkBuddy adapters expose
    /// `checkin_accounts`; the result and the refreshed runtime state are
    /// stored for the account dialog + row badge.
    pub(crate) fn checkin_account(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        let key = format!("{provider}/{account_id}");
        let lang = self.lang;
        // Already claimed today — the daily check-in is idempotent, so skip
        // the upstream round-trip entirely (manual clicks used force=true,
        // which re-verified upstream on every tap and looked like a bug).
        let checked_today = self
            .account_states
            .get(provider)
            .and_then(|m| m.get(account_id))
            .and_then(|s| s.checkin.as_ref())
            .and_then(|c| c.last_day.as_deref())
            .map(|day| day == crate::root::pages::detail::cn_today())
            .unwrap_or(false);
        if checked_today {
            self.checkin_results
                .insert(key, t(lang, "checked_in_today").into());
            cx.notify();
            return;
        }
        if !self.checkin_pending.insert(key.clone()) {
            return;
        }
        let Some(adapter) = self.service.registry().provider(provider) else {
            self.checkin_pending.remove(&key);
            self.checkin_results
                .insert(key, t(lang, "provider_not_loaded").into());
            cx.notify();
            return;
        };
        let service = self.service.clone();
        let (name, aid) = (provider.to_string(), account_id.to_string());
        let svc = service.clone();
        let name2 = name.clone();
        let started = Instant::now();
        let handle = service.spawn_ui(async move {
            let result = adapter.checkin_accounts(Some(&aid), false).await;
            (result, svc.account_states(&name2))
        });
        cx.spawn(async move |this, cx| {
            let outcome = handle.await;
            hold_spinner(started, cx).await;
            let _ = this.update(cx, |this, cx| {
                this.checkin_pending.remove(&key);
                let lang = this.lang;
                match outcome {
                    Ok((result, states)) => {
                        this.account_states.insert(name, states);
                        let msg = match result {
                            Ok(value) => summarize_checkin(lang, &value),
                            Err(e) => e.to_string(),
                        };
                        this.checkin_results.insert(key, msg);
                    }
                    Err(e) => {
                        this.checkin_results.insert(key, e.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Refresh only when the cached list is missing or stale — used when
    /// the account overlay opens so models appear without a manual click.
    pub(crate) fn ensure_account_models(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        const TTL_MS: i64 = 10 * 60_000;
        let fresh = self
            .account_states
            .get(provider)
            .and_then(|m| m.get(account_id))
            .map(|s| {
                !s.model_ids.is_empty()
                    && s.models_cached_at > 0
                    && gateway_core::pool::now_ms() - s.models_cached_at < TTL_MS
            })
            .unwrap_or(false);
        if !fresh {
            self.refresh_account_models(provider, account_id, cx);
        }
    }

    /// Pull the account's own model list (`refreshAccountModels`) — models
    /// differ per account, so they live on the account, not the provider.
    pub(crate) fn refresh_account_models(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        let key = format!("{provider}/{account_id}");
        if !self.models_refresh_pending.insert(key.clone()) {
            return;
        }
        let lang = self.lang;
        let Some(adapter) = self.service.registry().provider(provider) else {
            self.models_refresh_pending.remove(&key);
            return;
        };
        let service = self.service.clone();
        let svc = service.clone();
        let (name, aid) = (provider.to_string(), account_id.to_string());
        let (name2, aid2) = (name.clone(), aid.clone());
        let started = Instant::now();
        let handle = service.spawn_ui(async move {
            let result = adapter.refresh_account_models(&aid).await;
            (result, svc.account_states(&name2))
        });
        cx.spawn(async move |this, cx| {
            let outcome = handle.await;
            hold_spinner(started, cx).await;
            let _ = this.update(cx, |this, cx| {
                this.models_refresh_pending.remove(&key);
                let msg = match outcome {
                    Ok((Ok(_), states)) => {
                        let n = states
                            .get(&aid2)
                            .map(|s| s.model_ids.len())
                            .unwrap_or_default();
                        this.account_states.insert(name, states);
                        tf(lang, "models_refreshed", &[("n", &n.to_string())])
                    }
                    Ok((Err(e), _)) => format!("{} {e}", t(lang, "fail_prefix")),
                    Err(e) => format!("{} {e}", t(lang, "fail_prefix")),
                };
                this.models_refresh_results.insert(key, msg);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Flip a boolean entry in `provider.settings` (e.g. `autoCheckin`) and
    /// rebuild the registry so provider background tasks observe it.
    pub(crate) fn toggle_provider_setting(
        &mut self,
        provider: &str,
        key: &'static str,
        default: bool,
        cx: &mut Context<Self>,
    ) {
        let mut cfg = self.service.config();
        let Some(entry) = cfg.providers.get_mut(provider) else {
            return;
        };
        let mut pcfg = gateway_core::ProviderConfig::from_value(entry);
        let cur = pcfg
            .settings
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default);
        pcfg.settings
            .insert(key.to_string(), serde_json::json!(!cur));
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
}

/// Compact one-line summary for a `checkin_accounts` result — prefers the
/// first per-account entry, falls back to the aggregate counts.
fn summarize_checkin(lang: Lang, value: &serde_json::Value) -> String {
    if let Some(first) = value
        .get("results")
        .and_then(|v| v.as_array())
        .and_then(|r| r.first())
    {
        if first.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return match first.get("credits").and_then(|v| v.as_f64()) {
                Some(c) => tf(lang, "checkin_credits", &[("credits", &format!("{c:.0}"))]),
                None => t(lang, "checked_in_today").into(),
            };
        }
        let err = first.get("error").and_then(|v| v.as_str()).unwrap_or("?");
        return tf(lang, "checkin_failed", &[("e", err)]);
    }
    let claimed = value.get("claimed").and_then(|v| v.as_u64()).unwrap_or(0);
    let failed = value.get("failed").and_then(|v| v.as_u64()).unwrap_or(0);
    tf(
        lang,
        "checkin_summary",
        &[("c", &claimed.to_string()), ("f", &failed.to_string())],
    )
}

/// Hold a pending flag visible for a minimum duration — instant completes
/// flash the spinner for a single frame, which reads as "click did nothing".
async fn hold_spinner(started: Instant, cx: &mut gpui::AsyncApp) {
    const MIN: Duration = Duration::from_millis(600);
    if let Some(rem) = MIN.checked_sub(started.elapsed()) {
        cx.background_executor().timer(rem).await;
    }
}
