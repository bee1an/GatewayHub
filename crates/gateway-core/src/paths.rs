//! Data-directory layout, byte-compatible with the Electron app:
//! `~/.config/gatewayhub/gatewayhub.config.json`, `gatewayhub.state.json`,
//! `<provider>/accounts/*.json`, `logs/`, `usage-store/`.
//! `$GATEWAYHUB_HOME` overrides the whole directory (tests, portable runs).

use std::path::PathBuf;

pub const ENV_HOME: &str = "GATEWAYHUB_HOME";
const CONFIG_FILE: &str = "gatewayhub.config.json";
const STATE_FILE: &str = "gatewayhub.state.json";

#[derive(Debug, Clone)]
pub struct GatewayPaths {
    root: PathBuf,
}

impl GatewayPaths {
    pub fn detect() -> Option<Self> {
        if let Ok(dir) = std::env::var(ENV_HOME)
            && !dir.is_empty()
        {
            return Some(Self::new(PathBuf::from(dir)));
        }
        Some(Self::new(home::home_dir()?.join(".config").join("gatewayhub")))
    }

    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn root(&self) -> &PathBuf {
        &self.root
    }

    pub fn config_path(&self) -> PathBuf {
        self.root.join(CONFIG_FILE)
    }

    pub fn state_path(&self) -> PathBuf {
        self.root.join(STATE_FILE)
    }

    pub fn accounts_dir(&self, provider: &str) -> PathBuf {
        self.root.join(provider).join("accounts")
    }

    pub fn provider_dir(&self, provider: &str) -> PathBuf {
        self.root.join(provider)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.root.join("logs")
    }

    pub fn usage_dir(&self) -> PathBuf {
        self.root.join("usage-store")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_matches_electron() {
        let p = GatewayPaths::new(PathBuf::from("/tmp/gh"));
        assert_eq!(
            p.config_path().to_str().unwrap_or_default(),
            "/tmp/gh/gatewayhub.config.json"
        );
        assert_eq!(
            p.accounts_dir("kiro").to_str().unwrap_or_default(),
            "/tmp/gh/kiro/accounts"
        );
    }
}
