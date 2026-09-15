//! JSON file persistence matching the Electron store: atomic tmp+rename
//! writes, per-provider `accounts/*.json` scan, tolerant defaults on
//! missing/corrupt files (corrupt files are kept for manual recovery).

use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result};
use tracing::warn;

use crate::paths::GatewayPaths;
use crate::types::{AccountFile, GatewayHubConfig, GatewayHubState};

#[derive(Debug, Clone)]
pub struct ConfigStore {
    paths: GatewayPaths,
}

impl ConfigStore {
    pub fn new(paths: GatewayPaths) -> Self {
        Self { paths }
    }

    pub fn detect() -> Option<Self> {
        GatewayPaths::detect().map(Self::new)
    }

    pub fn paths(&self) -> &GatewayPaths {
        &self.paths
    }

    pub fn load_config(&self) -> GatewayHubConfig {
        let path = self.paths.config_path();
        match read_json::<GatewayHubConfig>(&path) {
            Ok(c) => c,
            Err(e) => {
                if path.exists() {
                    warn!(error = %e, path = %path.display(), "config unreadable; using defaults");
                }
                GatewayHubConfig::default()
            }
        }
    }

    pub fn save_config(&self, config: &GatewayHubConfig) -> Result<()> {
        write_json_atomic(&self.paths.config_path(), config)
    }

    pub fn load_state(&self) -> GatewayHubState {
        let path = self.paths.state_path();
        match read_json::<GatewayHubState>(&path) {
            Ok(s) => s,
            Err(e) => {
                if path.exists() {
                    warn!(error = %e, path = %path.display(), "state unreadable; using defaults");
                }
                GatewayHubState::default()
            }
            }
    }

    pub fn save_state(&self, state: &GatewayHubState) -> Result<()> {
        write_json_atomic(&self.paths.state_path(), state)
    }

    /// Scan `<provider>/accounts/*.json`, skipping unreadable entries.
    pub fn scan_accounts(&self, provider: &str) -> Vec<AccountFile> {
        let dir = self.paths.accounts_dir(provider);
        let mut out = Vec::new();
        let Ok(rd) = fs::read_dir(&dir) else {
            return out;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match read_json::<AccountFile>(&path) {
                Ok(acc) if !acc.id.is_empty() => out.push(acc),
                Ok(_) => warn!(path = %path.display(), "account file missing id; skipped"),
                Err(e) => warn!(error = %e, path = %path.display(), "account file unreadable; skipped"),
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    pub fn write_account(&self, provider: &str, account: &AccountFile) -> Result<PathBuf> {
        let dir = self.paths.accounts_dir(provider);
        fs::create_dir_all(&dir).with_context(|| format!("mkdir {}", dir.display()))?;
        let path = dir.join(format!("{}.json", sanitize_filename(&account.id)));
        write_json_atomic(&path, account)?;
        Ok(path)
    }

    pub fn delete_account(&self, provider: &str, account_id: &str) -> Result<bool> {
        let path = self
            .paths
            .accounts_dir(provider)
            .join(format!("{}.json", sanitize_filename(account_id)));
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e).context("delete account file"),
        }
    }
}

fn sanitize_filename(id: &str) -> String {
    id.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' | '@' => c,
            _ => '_',
        })
        .collect()
}

fn read_json<T: serde::de::DeserializeOwned>(path: &PathBuf) -> Result<T> {
    let raw = fs::read(path).with_context(|| format!("read {}", path.display()))?;
    serde_json::from_slice(&raw).with_context(|| format!("parse {}", path.display()))
}

fn write_json_atomic<T: serde::Serialize>(path: &PathBuf, value: &T) -> Result<()> {
    let dir = path.parent().context("path has no parent")?;
    fs::create_dir_all(dir).with_context(|| format!("mkdir {}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.{}.tmp",
        path.file_name().and_then(|n| n.to_str()).unwrap_or("data"),
        uuid::Uuid::now_v7().simple()
    ));
    let body = serde_json::to_vec_pretty(value)?;
    fs::write(&tmp, body).with_context(|| format!("write {}", tmp.display()))?;
    fs::rename(&tmp, path).with_context(|| format!("rename to {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn roundtrip_config() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(GatewayPaths::new(tmp.path().to_path_buf()));
        let mut cfg = GatewayHubConfig::default();
        cfg.server.port = 9741;
        cfg.providers.insert(
            "kiro".into(),
            json!({ "enabled": true, "routeName": "kiro", "settings": {"maxRetries": 2} }),
        );
        store.save_config(&cfg).unwrap();
        let loaded = store.load_config();
        assert_eq!(loaded.server.port, 9741);
        assert_eq!(
            loaded.providers["kiro"]["settings"]["maxRetries"],
            json!(2)
        );
    }

    #[test]
    fn account_scan_and_write() {
        let tmp = tempfile::tempdir().unwrap();
        let store = ConfigStore::new(GatewayPaths::new(tmp.path().to_path_buf()));
        let acc = AccountFile {
            id: "acc-1".into(),
            enabled: true,
            ..Default::default()
        };
        store.write_account("nvidia", &acc).unwrap();
        let found = store.scan_accounts("nvidia");
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "acc-1");
    }
}
