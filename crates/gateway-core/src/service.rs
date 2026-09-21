//! `GatewayService`: owns the config/state stores, provider registry and
//! the HTTP server handle. Single-process equivalent of the Electron
//! `gatewayHubService` — the UI calls it directly instead of over IPC.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use anyhow::{Context, Result, bail};
use tracing::{info, warn};

use crate::provider;
use crate::provider::{PLACEHOLDER_PROVIDERS, PROVIDERS, PlaceholderAdapter};
use crate::providers::nvidia::NvidiaProvider;
use crate::providers::openrouter::OpenRouterProvider;
use crate::registry::Registry;
use crate::server::{GatewayServer, ServerState};
use crate::store::ConfigStore;
use crate::types::{
    AccountFile, GatewayHubConfig, GatewayHubState, GatewayLogEntry, GatewayStatusSnapshot,
    LogSink, ProviderState, ServerSnapshot,
};

/// Cap on per-provider in-memory log entries (the TS logger ring buffer).
const LOG_CAP: usize = 500;

pub struct GatewayService {
    store: ConfigStore,
    config: Arc<RwLock<GatewayHubConfig>>,
    state: Arc<RwLock<GatewayHubState>>,
    /// Hot-swappable so provider enable/disable from the UI can rebuild
    /// adapters without restarting the process. A *running* HTTP server
    /// keeps the Arc it captured at start — restart to apply changes.
    registry: RwLock<Arc<Registry>>,
    usage_store: Arc<crate::usage_store::UsageStore>,
    server: Mutex<Option<GatewayServer>>,
    /// UI-triggered async work (test_account, checkin, get_account_info) —
    /// the HTTP server gets its own thread+runtime; this one serves the
    /// GPUI frontend which runs on smol, not tokio.
    ui_rt: tokio::runtime::Handle,
    /// In-flight CLI login sessions keyed by provider — one at a time each
    /// (the TS `activeSession` singleton, per provider here).
    cli_sessions: Arc<Mutex<HashMap<String, crate::cli_login::CliLoginHandle>>>,
}

impl GatewayService {
    pub fn new(store: ConfigStore) -> Self {
        let config = store.load_config();
        let state = store.load_state();
        let config = Arc::new(RwLock::new(config));
        let state = Arc::new(RwLock::new(state));
        let ui_rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("gateway-ui")
            .build()
            .expect("ui runtime");
        // Leak the runtime — it must outlive the service; the process owns it.
        let ui_rt = Box::leak(Box::new(ui_rt)).handle().clone();
        // Providers spawn background tasks (e.g. TraeWork hourly check-in
        // sweep) during construction — they need a runtime context.
        let registry = {
            let _guard = ui_rt.enter();
            RwLock::new(Arc::new(Self::build_registry(&store, &config, &state)))
        };
        let usage_store = Arc::new(crate::usage_store::UsageStore::new(
            store.paths().usage_store_path(),
            crate::pricing::PricingTable::new(Some(&store.paths().pricing_path())),
        ));
        Self {
            store,
            config,
            state,
            registry,
            usage_store,
            server: Mutex::new(None),
            ui_rt,
            cli_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn a future on the UI runtime; adapters use tokio-bound clients.
    pub fn spawn_ui<F, T>(&self, fut: F) -> tokio::task::JoinHandle<T>
    where
        F: std::future::Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        self.ui_rt.spawn(fut)
    }

    pub fn detect() -> Option<Self> {
        ConfigStore::detect().map(Self::new)
    }

    fn build_registry(
        store: &ConfigStore,
        config: &Arc<RwLock<GatewayHubConfig>>,
        state: &Arc<RwLock<GatewayHubState>>,
    ) -> Registry {
        let cfg = config.read().map(|c| c.clone()).unwrap_or_default();
        let mut registry = Registry::new(&cfg);
        let global_proxy = cfg.server.proxy_url.clone();

        for name in PROVIDERS {
            let mut pcfg = provider::provider_config(&cfg, name);
            if !provider::provider_live(name) {
                // Coming-soon providers stay listed but must report disabled —
                // keeps every `enabled`-driven surface (sidebar dim, dashboard
                // counts) consistent without rewriting the user's config.
                pcfg.enabled = false;
            }
            let pstate = state
                .read()
                .ok()
                .and_then(|s| s.providers.get(*name).cloned())
                .map(|v| ProviderState::from_value(&v))
                .unwrap_or_default();
            let accounts = store.scan_accounts(name);
            let route = pcfg.route_name.clone().unwrap_or_else(|| name.to_string());
            let use_proxy =
                provider::PROXY_CAPABLE.contains(name) && pcfg.use_proxy.unwrap_or(false);
            let proxy_url = if use_proxy { global_proxy.as_str() } else { "" };

            // Shared sinks — the TS `onStateChanged` + `persistAccount` +
            // logger wiring, against this process's in-memory state mirror.
            let name_owned = (*name).to_string();
            let state_c = state.clone();
            let store_c = store.clone();
            let on_changed = move |(accounts, index): (
                std::collections::HashMap<String, crate::types::AccountRuntimeState>,
                i64,
            )| {
                if let Ok(mut s) = state_c.write() {
                    let entry = s
                        .providers
                        .entry(name_owned.clone())
                        .or_insert_with(|| serde_json::json!({}));
                    let mut ps = ProviderState::from_value(entry);
                    ps.accounts = accounts
                        .into_iter()
                        .map(|(k, v)| (k, serde_json::to_value(v).unwrap_or_default()))
                        .collect();
                    ps.current_account_index = index;
                    *entry = serde_json::to_value(&ps).unwrap_or_default();
                }
                let snapshot = state_c.read().map(|s| s.clone()).unwrap_or_default();
                if let Err(e) = store_c.save_state(&snapshot) {
                    warn!(error = %e, "state persist failed");
                }
            };

            let name_owned = (*name).to_string();
            let store_c = store.clone();
            let persist_account: Arc<dyn Fn(&AccountFile) + Send + Sync> =
                Arc::new(move |acc: &AccountFile| {
                    if let Err(e) = store_c.write_account(&name_owned, acc) {
                        warn!(error = %e, account = %acc.id, "account persist failed");
                    }
                });

            let log = Self::log_sink(name, state.clone(), store.clone());

            let adapter: Arc<dyn crate::provider::ProviderAdapter> = match *name {
                "nvidia" => match NvidiaProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "nvidia provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "nvidia",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                "kiro" => match crate::providers::kiro::KiroProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "kiro provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "kiro",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                "trae" => match crate::providers::trae::TraeProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "trae provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "trae",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                "traework" => match crate::providers::traework::TraeWorkProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "traework provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "traework",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                "workbuddy" => match crate::providers::workbuddy::WorkBuddyProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "workbuddy provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "workbuddy",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                "qoder" => match crate::providers::qoder::QoderProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "qoder provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "qoder",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                "geminiweb" | "geminiWeb" => {
                    match crate::providers::geminiweb::GeminiWebProvider::new(
                        &pcfg,
                        accounts,
                        &pstate,
                        log,
                        on_changed,
                        Some(persist_account),
                        proxy_url,
                    ) {
                        Ok(p) => Arc::new(p),
                        Err(e) => {
                            warn!(error = %e, "geminiweb provider init failed");
                            Arc::new(PlaceholderAdapter::new(
                                "geminiWeb",
                                format!("init failed: {e}"),
                                pcfg.enabled,
                            ))
                        }
                    }
                }
                "gptweb" | "gptWeb" => match crate::providers::gptweb::GptWebProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "gptweb provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "gptWeb",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                "openrouter" => match OpenRouterProvider::new(
                    &pcfg,
                    accounts,
                    &pstate,
                    log,
                    on_changed,
                    Some(persist_account),
                    proxy_url,
                ) {
                    Ok(p) => Arc::new(p),
                    Err(e) => {
                        warn!(error = %e, "openrouter provider init failed");
                        Arc::new(PlaceholderAdapter::new(
                            "openrouter",
                            format!("init failed: {e}"),
                            pcfg.enabled,
                        ))
                    }
                },
                _ => Arc::new(PlaceholderAdapter::new(
                    name,
                    if PLACEHOLDER_PROVIDERS.contains(name) {
                        pcfg.note
                            .clone()
                            .unwrap_or_else(|| "Provider not yet implemented".into())
                    } else {
                        "Provider not yet ported to the Rust core".to_string()
                    },
                    pcfg.enabled,
                )),
            };
            registry.register(
                *name,
                adapter,
                route,
                provider::PROXY_CAPABLE
                    .contains(name)
                    .then(|| pcfg.use_proxy.unwrap_or(false)),
            );
        }
        registry
    }

    /// Logger that appends structured entries into `state.providers[name].logs`
    /// (capped) and mirrors to `tracing`.
    fn log_sink(
        provider: &str,
        state: Arc<RwLock<GatewayHubState>>,
        store: ConfigStore,
    ) -> LogSink {
        let provider = provider.to_string();
        Arc::new(move |entry: GatewayLogEntry| {
            match entry.level {
                crate::types::LogLevel::Warn => {
                    warn!(provider = %provider, "{}", entry.message)
                }
                crate::types::LogLevel::Error => {
                    tracing::error!(provider = %provider, "{}", entry.message)
                }
                _ => info!(provider = %provider, "{}", entry.message),
            }
            if let Ok(mut s) = state.write() {
                let slot = s
                    .providers
                    .entry(provider.clone())
                    .or_insert_with(|| serde_json::json!({}));
                let mut ps = ProviderState::from_value(slot);
                ps.logs.push(entry);
                if ps.logs.len() > LOG_CAP {
                    let excess = ps.logs.len() - LOG_CAP;
                    ps.logs.drain(..excess);
                }
                *slot = serde_json::to_value(&ps).unwrap_or_default();
                drop(s);
            }
            let snapshot = state.read().map(|s| s.clone()).unwrap_or_default();
            let _ = store.save_state(&snapshot);
        })
    }

    pub fn store(&self) -> &ConfigStore {
        &self.store
    }

    pub fn registry(&self) -> Arc<Registry> {
        self.registry
            .read()
            .map(|r| r.clone())
            .unwrap_or_else(|_| Arc::new(Registry::new(&GatewayHubConfig::default())))
    }

    /// Rebuild all provider adapters after a config change (enable/disable,
    /// proxy toggles, settings edits). Provider construction spawns
    /// background tasks, so run inside the ui runtime.
    pub fn reload_registry(&self) {
        let new_registry = {
            let _guard = self.ui_rt.enter();
            Arc::new(Self::build_registry(&self.store, &self.config, &self.state))
        };
        if let Ok(mut guard) = self.registry.write() {
            *guard = new_registry;
        }
    }

    pub fn usage_store(&self) -> &Arc<crate::usage_store::UsageStore> {
        &self.usage_store
    }

    pub fn config(&self) -> GatewayHubConfig {
        self.config.read().map(|c| c.clone()).unwrap_or_default()
    }

    pub fn save_config(&self, config: GatewayHubConfig) -> Result<()> {
        self.store.save_config(&config)?;
        if let Ok(mut guard) = self.config.write() {
            *guard = config;
        }
        Ok(())
    }

    pub fn accounts(&self, provider: &str) -> Vec<AccountFile> {
        self.store.scan_accounts(provider)
    }

    /// Per-account runtime state (status, model_ids, checkin, stats) for a
    /// provider — the pool mirrors it into `state.providers[name].accounts`
    /// via `on_changed`, so the UI can read it without touching the pools.
    pub fn account_states(
        &self,
        provider: &str,
    ) -> std::collections::HashMap<String, crate::types::AccountRuntimeState> {
        self.state
            .read()
            .ok()
            .and_then(|s| s.providers.get(provider).cloned())
            .map(|v| ProviderState::from_value(&v))
            .unwrap_or_default()
            .accounts
            .into_iter()
            .map(|(k, v)| (k, crate::types::AccountRuntimeState::from_value(&v)))
            .collect()
    }

    // ==================== CLI login (kiro/qoder) ====================

    /// `detectKiroCli`/`detectQoderCli` — binary lookup for the add-account
    /// dialog; call through `spawn_ui`.
    pub async fn detect_provider_cli(
        &self,
        provider: &str,
        custom_path: Option<String>,
    ) -> Result<crate::cli_login::CliDetectResult> {
        crate::cli_login::detect_cli(provider, custom_path.as_deref()).await
    }

    /// `loginWith{Kiro,Qoder}Cli` — runs the whole login flow on the UI
    /// runtime; stdout/stderr/exit stream back over the returned receiver.
    /// The harvested account arrives inside the `Exit` event — writing it is
    /// the caller's job (`upsert_account` + registry reload).
    pub fn start_cli_login(
        &self,
        provider: &str,
        cli_path: Option<String>,
        label: Option<String>,
    ) -> Result<tokio::sync::mpsc::UnboundedReceiver<crate::cli_login::CliLoginEvent>> {
        crate::cli_login::cli_bin(provider).context("provider has no CLI login")?;
        if self
            .cli_sessions
            .lock()
            .ok()
            .is_some_and(|s| s.contains_key(provider))
        {
            bail!("A CLI login is already in progress");
        }
        let (event_tx, event_rx) = tokio::sync::mpsc::unbounded_channel();
        let (cancel_tx, cancel_rx) = tokio::sync::mpsc::unbounded_channel();
        let cancelled = Arc::new(AtomicBool::new(false));
        if let Ok(mut sessions) = self.cli_sessions.lock() {
            sessions.insert(
                provider.to_string(),
                crate::cli_login::CliLoginHandle {
                    cancelled: cancelled.clone(),
                    cancel_tx,
                },
            );
        }
        let sessions = self.cli_sessions.clone();
        let auth_dir = self.store.paths().auth_dir(provider);
        let http = reqwest::Client::new();
        let name = provider.to_string();
        let bin = crate::cli_login::cli_bin(provider).unwrap_or_default();
        self.spawn_ui(async move {
            let cli_path = cli_path.unwrap_or_else(|| bin.to_string());
            match name.as_str() {
                "kiro" => {
                    crate::cli_login::kiro_login(&cli_path, http, cancelled, cancel_rx, event_tx)
                        .await
                }
                "qoder" => {
                    crate::cli_login::qoder_login(
                        &cli_path, auth_dir, label, cancelled, cancel_rx, event_tx,
                    )
                    .await
                }
                _ => {}
            }
            if let Ok(mut sessions) = sessions.lock() {
                sessions.remove(&name);
            }
        });
        Ok(event_rx)
    }

    /// `cancel*CliLogin` — SIGKILL the child; the pump's cleanup still runs.
    pub fn cancel_cli_login(&self, provider: &str) -> bool {
        let Some(handle) = self
            .cli_sessions
            .lock()
            .ok()
            .and_then(|mut s| s.remove(provider))
        else {
            return false;
        };
        handle.cancelled.store(true, Ordering::Relaxed);
        let _ = handle.cancel_tx.send(());
        true
    }

    /// `importCurrentQoderCliAuth` — harvest an already-logged-in local CLI
    /// into the managed auth dir, without running `login`.
    pub async fn import_current_cli_auth(
        &self,
        provider: &str,
        cli_path: Option<String>,
    ) -> Result<AccountFile> {
        match provider {
            "qoder" => {
                crate::cli_login::qoder_import_current(
                    self.store.paths().auth_dir("qoder"),
                    cli_path,
                )
                .await
            }
            _ => bail!("provider has no CLI import"),
        }
    }

    // ==================== discover (local credential scan) ====================

    /// `scan*Accounts` — local credential scan + existing/updatable markers.
    /// Synchronous fs/sqlite; call through `spawn_ui`.
    pub fn scan_provider_accounts(
        &self,
        provider: &str,
    ) -> Vec<crate::discover::ScanCandidate> {
        crate::discover::scan_provider_accounts(&self.store, provider)
    }

    /// `importScanned*Accounts` — re-scan (credentials may have rotated since
    /// the dialog's scan), write the selected ids, update-in-place for kiro
    /// `updatable` candidates.
    pub fn import_scanned_accounts(
        &self,
        provider: &str,
        ids: &[String],
    ) -> (usize, usize) {
        let candidates = crate::discover::scan_provider_accounts(&self.store, provider);
        let mut added = 0usize;
        let mut updated = 0usize;
        for c in candidates
            .into_iter()
            .filter(|c| ids.iter().any(|id| id == &c.account.id))
        {
            if let Some(existing_id) = &c.existing_id {
                if c.updatable {
                    // `kiroAccountImportUpdates` — merge the fresh fields into
                    // the existing file (keeps its own id/path/enabled).
                    if let Some(mut existing) = self
                        .store
                        .scan_accounts(provider)
                        .into_iter()
                        .find(|a| &a.id == existing_id)
                    {
                        for key in [
                            "refreshToken",
                            "accessToken",
                            "expiresAt",
                            "profileArn",
                            "clientId",
                            "clientSecret",
                            "region",
                            "apiRegion",
                        ] {
                            if let Some(v) = c.account.fields.get(key) {
                                existing.fields.insert(key.to_string(), v.clone());
                            }
                        }
                        if c.account.email.is_some() {
                            existing.email.clone_from(&c.account.email);
                        }
                        if c.account.label.is_some() {
                            existing.label.clone_from(&c.account.label);
                        }
                        if self.store.write_account(provider, &existing).is_ok() {
                            updated += 1;
                        }
                    }
                }
                continue;
            }
            if self.store.write_account(provider, &c.account).is_ok() {
                added += 1;
            }
        }
        (added, updated)
    }

    /// Re-importing a CLI account must overwrite the same file — adopt the
    /// existing account's path when the id is already on disk.
    pub fn upsert_account(&self, provider: &str, account: &AccountFile) -> Result<PathBuf> {
        let mut acc = account.clone();
        if let Some(existing) = self
            .store
            .scan_accounts(provider)
            .into_iter()
            .find(|a| a.id == acc.id)
        {
            acc.path = existing.path;
        }
        self.store.write_account(provider, &acc)
    }

    /// `clearLogs` — drop every provider's log ring and persist the state.
    pub fn clear_logs(&self) {
        if let Ok(mut state) = self.state.write() {
            for slot in state.providers.values_mut() {
                let mut ps = ProviderState::from_value(slot);
                ps.logs.clear();
                *slot = serde_json::to_value(&ps).unwrap_or_default();
            }
        }
        let snapshot = self.state.read().map(|s| s.clone()).unwrap_or_default();
        let _ = self.store.save_state(&snapshot);
    }

    /// `exportLogs` — newline-delimited JSON next to the state file.
    pub fn export_logs(&self) -> Result<std::path::PathBuf> {
        let mut logs = self.status().logs;
        logs.sort_by_key(|l| l.ts);
        let body = logs
            .iter()
            .map(|l| serde_json::to_string(l).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n");
        let path = self
            .store
            .paths()
            .logs_dir()
            .join(format!("gatewayhub-logs-{}.ndjson", crate::pool::now_ms()));
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(&path, body)?;
        Ok(path)
    }

    pub fn server_running(&self) -> bool {
        self.server.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    pub fn start_server(&self) -> Result<()> {
        let mut guard = self
            .server
            .lock()
            .map_err(|_| anyhow::anyhow!("server lock"))?;
        if guard.is_some() {
            return Ok(());
        }
        let cfg = self.config();
        let models: Vec<_> = cfg
            .model_mappings
            .iter()
            .filter(|m| m.enabled)
            .cloned()
            .collect();
        let state = ServerState {
            config: Arc::new(RwLock::new(cfg.server.clone())),
            models: Arc::new(RwLock::new(models)),
            registry: self.registry(),
            usage: self.usage_store.clone(),
        };
        let server = GatewayServer::start(state)?;
        *guard = Some(server);
        info!("gateway server started");
        Ok(())
    }

    pub fn stop_server(&self) {
        if let Ok(mut guard) = self.server.lock()
            && let Some(mut server) = guard.take()
        {
            server.stop();
        }
    }

    pub fn maybe_autostart(&self) {
        let cfg = self.config();
        if cfg.server.auto_start
            && let Err(e) = self.start_server()
        {
            warn!(error = %e, "autostart failed");
        }
    }

    pub fn status(&self) -> GatewayStatusSnapshot {
        let config = self.config();
        let providers = self.registry().statuses();
        let logs: Vec<_> = self
            .state
            .read()
            .map(|s| {
                s.providers
                    .values()
                    .flat_map(|v| ProviderState::from_value(v).logs)
                    .collect()
            })
            .unwrap_or_default();
        GatewayStatusSnapshot {
            server: ServerSnapshot {
                running: self.server_running(),
                url: format!("http://{}:{}", config.server.host, config.server.port),
                host: config.server.host.clone(),
                port: config.server.port,
                api_keys: config.server.api_keys.len(),
            },
            config_path: self.store.paths().config_path().display().to_string(),
            state_path: self.store.paths().state_path().display().to_string(),
            providers,
            logs,
        }
    }
}

impl Drop for GatewayService {
    fn drop(&mut self) {
        self.stop_server();
    }
}
