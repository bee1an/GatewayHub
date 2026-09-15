//! `GatewayService`: owns the config/state stores, scanned accounts and the
//! HTTP server handle. Single-process equivalent of the Electron
//! `gatewayHubService` — the UI calls it directly instead of over IPC.

use std::sync::{Arc, Mutex, RwLock};

use anyhow::Result;
use tracing::{info, warn};

use crate::provider;
use crate::server::{GatewayServer, ServerState};
use crate::store::ConfigStore;
use crate::types::{
    AccountFile, GatewayHubConfig, GatewayHubState, GatewayStatusSnapshot, JsonMap, ProviderState,
    ServerSnapshot,
};

pub struct GatewayService {
    store: ConfigStore,
    config: Arc<RwLock<GatewayHubConfig>>,
    state: Arc<RwLock<GatewayHubState>>,
    server: Mutex<Option<GatewayServer>>,
}

impl GatewayService {
    pub fn new(store: ConfigStore) -> Self {
        let config = store.load_config();
        let state = store.load_state();
        Self {
            store,
            config: Arc::new(RwLock::new(config)),
            state: Arc::new(RwLock::new(state)),
            server: Mutex::new(None),
        }
    }

    pub fn detect() -> Option<Self> {
        ConfigStore::detect().map(Self::new)
    }

    pub fn store(&self) -> &ConfigStore {
        &self.store
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

    fn state_providers(&self) -> JsonMap {
        self.state
            .read()
            .map(|s| s.providers.clone())
            .unwrap_or_default()
    }

    pub fn accounts(&self, provider: &str) -> Vec<AccountFile> {
        self.store.scan_accounts(provider)
    }

    pub fn server_running(&self) -> bool {
        self.server.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    pub fn start_server(&self) -> Result<()> {
        let mut guard = self.server.lock().map_err(|_| anyhow::anyhow!("server lock"))?;
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
        let providers_state = self.state_providers();
        let accounts = |name: &str| self.accounts(name);
        let providers = provider::describe_all(&config, &providers_state, &accounts);
        let logs: Vec<_> = providers_state
            .values()
            .flat_map(|v| ProviderState::from_value(v).logs)
            .collect();
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
