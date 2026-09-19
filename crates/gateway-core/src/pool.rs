//! Account pool — port of `core/accountPool.ts` + `core/accountState.ts`.
//!
//! Differences from the TS shape, forced by Rust ownership:
//! - The pool is `&mut self` for all mutations; providers wrap it in a
//!   `tokio::sync::Mutex`. Lock windows stay tiny — HTTP work happens on
//!   cloned `AccountFile` data outside the lock.
//! - Two-pass selection is split into `ordered_candidates()` (sync, ordered
//!   round-robin ids) plus per-candidate `has_model`/`commit` calls so the
//!   provider can interleave async model refreshes without holding the lock.
//! - Account configs stay dynamic (`AccountFile.fields`) since each provider
//!   stores different credential fields in the same file format.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use crate::types::{
    AccountFile, AccountRuntimeState, AccountStatus, CheckinState, ClassifiedError, ResponseKind,
};

#[derive(Debug, Clone)]
pub struct AccountWithState {
    pub config: AccountFile,
    pub state: AccountRuntimeState,
}

/// Per-provider tweaks with defaults matching the shared TS base class.
/// nvidia/openrouter use `DefaultBehavior` untouched; pools like qoder
/// (quota is not hard-offline) plug their own.
pub trait PoolBehavior: Send + Sync {
    fn provider_name(&self) -> &'static str;
    fn normalize_model(&self, model: &str) -> String {
        model.trim().to_string()
    }
    fn account_has_model(&self, account: &AccountWithState, model: &str) -> bool {
        if account.state.model_ids.is_empty() {
            return false;
        }
        account
            .state
            .model_ids
            .iter()
            .any(|id| self.normalize_model(id) == model)
    }
    fn seed_models(&self) -> Vec<String> {
        Vec::new()
    }
    /// Statuses an account cannot recover from automatically.
    fn is_hard_offline(&self, status: AccountStatus) -> bool {
        matches!(
            status,
            AccountStatus::AuthFailed
                | AccountStatus::ManualDisabled
                | AccountStatus::QuotaExceeded
        )
    }

    /// Probabilistic early-retry chance while an account sits in cooldown
    /// (TS `probabilisticRetryChance`; 0.1 everywhere except kiro).
    fn retry_chance(&self) -> f64 {
        0.1
    }

    /// Status→cooldown mapping hook (TS `resolveCooldown` overrides).
    /// codex diverts: quota honors an upstream resetAtIso deadline and
    /// cooling uses `max(1000, cooldownMs || 30_000)` as the backoff base.
    fn resolve_cooldown(
        &self,
        account: &AccountWithState,
        classified: &ClassifiedError,
        now: i64,
    ) -> (AccountStatus, Option<i64>) {
        default_resolve_cooldown(account, classified, now)
    }
}

pub struct DefaultBehavior(pub &'static str);

impl PoolBehavior for DefaultBehavior {
    fn provider_name(&self) -> &'static str {
        self.0
    }
}

/// Field keys whose values get masked when configs surface to the UI.
const SECRET_KEYS: &[&str] = &[
    "apiKey",
    "api_key",
    "key",
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "refresh_token",
    "idToken",
    "id_token",
    "cookieHeader",
    "cookie",
    "cookies",
    "password",
    "secret",
    "credentials",
    "sessionKey",
    "signature",
];

fn redact_config(config: &AccountFile) -> AccountFile {
    let mut out = config.clone();
    for (key, value) in out.fields.iter_mut() {
        if SECRET_KEYS.contains(&key.as_str()) && !value.is_null() {
            *value = Value::String("***".into());
        }
    }
    out
}

pub struct AccountPool<B: PoolBehavior> {
    pub accounts: Vec<AccountWithState>,
    current_index: usize,
    behavior: B,
    on_changed: Option<Box<dyn Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync>>,
}

impl<B: PoolBehavior> AccountPool<B> {
    pub fn new(behavior: B) -> Self {
        Self {
            accounts: Vec::new(),
            current_index: 0,
            behavior,
            on_changed: None,
        }
    }

    /// Register the persistence sink — receives `(account_states, index)`
    /// after every mutation (the TS `onStateChanged` contract).
    pub fn set_on_changed(
        &mut self,
        cb: impl Fn((HashMap<String, AccountRuntimeState>, i64)) + Send + Sync + 'static,
    ) {
        self.on_changed = Some(Box::new(cb));
    }

    fn changed(&self) {
        if let Some(cb) = &self.on_changed {
            cb(self.export_state());
        }
    }

    pub fn behavior(&self) -> &B {
        &self.behavior
    }

    /// Rebuild the pool from account files, restoring persisted runtime
    /// state where present (the TS `reload()`).
    pub fn reload(
        &mut self,
        files: Vec<AccountFile>,
        states: &mut HashMap<String, AccountRuntimeState>,
        current_index: i64,
    ) {
        self.accounts = files
            .into_iter()
            .map(|config| {
                let mut state = states
                    .remove(&config.id)
                    .unwrap_or_else(|| AccountRuntimeState {
                        model_ids: self.behavior.seed_models(),
                        ..Default::default()
                    });
                if state.model_ids.is_empty() {
                    state.model_ids = self.behavior.seed_models();
                }
                AccountWithState { config, state }
            })
            .collect();
        self.current_index = current_index.max(0) as usize;
        self.changed();
    }

    /// Snapshot for `state.providers[name]` persistence.
    pub fn export_state(&self) -> (HashMap<String, AccountRuntimeState>, i64) {
        (
            self.accounts
                .iter()
                .map(|a| (a.config.id.clone(), a.state.clone()))
                .collect(),
            self.current_index as i64,
        )
    }

    /// Config copies with secrets masked — the TS `listAccounts()`.
    pub fn list_accounts(&self) -> Vec<AccountWithState> {
        self.accounts
            .iter()
            .map(|a| AccountWithState {
                config: redact_config(&a.config),
                state: a.state.clone(),
            })
            .collect()
    }

    /// Union of enabled accounts' cached model ids (the TS `listModels()`).
    pub fn list_models(&self) -> Vec<String> {
        let mut set: Vec<String> = self
            .accounts
            .iter()
            .filter(|a| a.config.enabled)
            .flat_map(|a| a.state.model_ids.iter().cloned())
            .collect();
        set.sort();
        set.dedup();
        set
    }

    pub fn find(&self, account_id: &str) -> Option<&AccountWithState> {
        self.accounts.iter().find(|a| a.config.id == account_id)
    }

    pub fn find_mut(&mut self, account_id: &str) -> Option<&mut AccountWithState> {
        self.accounts.iter_mut().find(|a| a.config.id == account_id)
    }

    /// Merge a check-in update into the account state and persist — bare
    /// `find_mut` writes never reach the state file because they skip
    /// `changed()`.
    pub fn set_checkin(
        &mut self,
        account_id: &str,
        update: impl FnOnce(&mut CheckinState),
    ) {
        if let Some(acc) = self.find_mut(account_id) {
            let mut state = acc.state.checkin.clone().unwrap_or_default();
            update(&mut state);
            acc.state.checkin = Some(state);
            self.changed();
        }
    }

    /// Store the account's model list and persist — same `changed()`
    /// requirement as `set_checkin`; bare `find_mut` writes stay invisible
    /// to the state file and the UI snapshot.
    pub fn set_models(&mut self, account_id: &str, model_ids: Vec<String>) {
        if let Some(acc) = self.find_mut(account_id) {
            acc.state.model_ids = model_ids;
            acc.state.models_cached_at = now_ms();
            self.changed();
        }
    }

    pub fn reset_account(&mut self, account_id: &str) {
        if let Some(acc) = self.find_mut(account_id) {
            acc.state.failures = 0;
            acc.state.last_error = None;
            acc.state.last_failure_at = 0;
            acc.state.last_response_kind = None;
            transition(acc, AccountStatus::Available, None, None);
            self.changed();
        }
    }

    pub fn set_account_status(
        &mut self,
        account_id: &str,
        status: AccountStatus,
        reason: Option<String>,
    ) -> anyhow::Result<()> {
        let Some(acc) = self.find_mut(account_id) else {
            anyhow::bail!("Account not found: {account_id}");
        };
        if status == AccountStatus::Available {
            acc.state.failures = 0;
            acc.state.last_error = None;
            acc.state.cooldown_until = None;
        }
        transition(acc, status, reason, None);
        self.changed();
        Ok(())
    }

    // --- two-pass round-robin selection ---

    /// Rotation-ordered candidate ids for one pass. `relax` drops the
    /// availability probe down to "skip only hard-offline" (TS pass 2).
    pub fn ordered_candidates(&self, exclude: &HashSet<String>, relax: bool) -> Vec<String> {
        if self.accounts.is_empty() {
            return Vec::new();
        }
        let now = now_ms();
        let start = self.current_index % self.accounts.len();
        let mut ids = Vec::with_capacity(self.accounts.len());
        for i in 0..self.accounts.len() {
            let idx = (start + i) % self.accounts.len();
            let acc = &self.accounts[idx];
            if !acc.config.enabled || exclude.contains(&acc.config.id) {
                continue;
            }
            let usable = if relax {
                !self.behavior.is_hard_offline(acc.state.status)
            } else {
                self.is_available(acc, now)
            };
            if usable {
                ids.push(acc.config.id.clone());
            }
        }
        ids
    }

    /// Availability probe: available always; hard-offline never; past
    /// cooldown yes; otherwise 10% early-retry chance.
    fn is_available(&self, account: &AccountWithState, now: i64) -> bool {
        let status = account.state.status;
        if status == AccountStatus::Available {
            return true;
        }
        if self.behavior.is_hard_offline(status) {
            return false;
        }
        if account
            .state
            .cooldown_until
            .is_some_and(|until| now > until)
        {
            return true;
        }
        fastrand::f64() < self.behavior.retry_chance()
    }

    pub fn has_model(&self, account_id: &str, model: &str) -> bool {
        let normalized = self.behavior.normalize_model(model);
        self.find(account_id)
            .is_some_and(|acc| self.behavior.account_has_model(acc, &normalized))
    }

    /// Commit the round-robin index to the selected account's position —
    /// next rotation resumes there (TS `commitIndex` default).
    pub fn commit(&mut self, account_id: &str) {
        if let Some(idx) = self.accounts.iter().position(|a| a.config.id == account_id) {
            self.current_index = idx;
            self.changed();
        }
    }

    /// Shared success-reporting body (TS `reportSuccess`).
    pub fn report_success(&mut self, account_id: &str) {
        if let Some(acc) = self.find_mut(account_id) {
            acc.state.failures = 0;
            acc.state.last_error = None;
            acc.state.last_success_at = now_ms();
            acc.state.stats.total_requests += 1;
            acc.state.stats.successful_requests += 1;
            acc.state.last_response_kind = Some("success".into());
            transition(acc, AccountStatus::Available, None, None);
            self.changed();
        }
    }

    /// Shared failure-reporting body with the standard status-mapping branch
    /// table (TS `reportFailure` + `resolveCooldown` defaults).
    pub fn report_failure(&mut self, account_id: &str, error: &str, classified: &ClassifiedError) {
        if let Some(acc) = self.accounts.iter_mut().find(|a| a.config.id == account_id) {
            acc.state.failures += 1;
            acc.state.last_failure_at = now_ms();
            acc.state.last_error = Some(error.to_string());
            acc.state.stats.total_requests += 1;
            acc.state.stats.failed_requests += 1;
            acc.state.last_response_kind = Some(kind_str(classified.kind).to_string());
            let now = now_ms();
            let reason: String = error.chars().take(200).collect();
            let (status, cooldown) = self.behavior.resolve_cooldown(acc, classified, now);
            transition(acc, status, Some(reason), cooldown);
            self.changed();
        }
    }
}

/// Default status→cooldown mapping: auth → auth_failed (no cooldown);
/// quota/rate_limit → classified cooldown; else `cooling` with exponential
/// backoff (cap 64×).
fn default_resolve_cooldown(
    account: &AccountWithState,
    classified: &ClassifiedError,
    now: i64,
) -> (AccountStatus, Option<i64>) {
    match classified.kind {
        ResponseKind::Auth => (AccountStatus::AuthFailed, None),
        ResponseKind::Quota => (
            AccountStatus::QuotaExceeded,
            Some(now + classified.cooldown_ms),
        ),
        ResponseKind::RateLimit => (
            AccountStatus::RateLimited,
            Some(now + classified.cooldown_ms),
        ),
        _ => {
            let multiplier = (account.state.failures.saturating_sub(1)).min(6);
            (
                AccountStatus::Cooling,
                Some(now + classified.cooldown_ms * 2_i64.pow(multiplier as u32)),
            )
        }
    }
}

fn transition(
    account: &mut AccountWithState,
    status: AccountStatus,
    reason: Option<String>,
    cooldown_until: Option<i64>,
) {
    account.state.status = status;
    account.state.status_reason = reason;
    account.state.status_updated_at = now_ms();
    account.state.cooldown_until = cooldown_until;
}

fn kind_str(kind: ResponseKind) -> &'static str {
    match kind {
        ResponseKind::Success => "success",
        ResponseKind::RateLimit => "rate_limit",
        ResponseKind::Quota => "quota",
        ResponseKind::Auth => "auth",
        ResponseKind::ModelError => "model_error",
        ResponseKind::ServerError => "server_error",
        ResponseKind::Network => "network",
        ResponseKind::Timeout => "timeout",
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn acc(id: &str) -> AccountFile {
        AccountFile {
            id: id.into(),
            enabled: true,
            ..Default::default()
        }
    }

    #[test]
    fn rotation_prefers_available_and_commits() {
        let mut pool = AccountPool::new(DefaultBehavior("nvidia"));
        pool.reload(vec![acc("a"), acc("b"), acc("c")], &mut HashMap::new(), 0);
        // force a cooling state on 'a' past its cooldown → still picked in
        // relaxed pass
        let candidates = pool.ordered_candidates(&HashSet::new(), false);
        assert_eq!(candidates, vec!["a", "b", "c"]);
        pool.commit("b");
        let (states, index) = pool.export_state();
        assert_eq!(index, 1);
        assert!(states.contains_key("a"));
    }

    #[test]
    fn failure_backoff_and_hard_offline() {
        let mut pool = AccountPool::new(DefaultBehavior("nvidia"));
        pool.reload(vec![acc("a"), acc("b")], &mut HashMap::new(), 0);
        pool.report_failure(
            "a",
            "HTTP 401 bad key",
            &ClassifiedError {
                kind: ResponseKind::Auth,
                cooldown_ms: 0,
                reset_at_iso: None,
            },
        );
        // auth_failed is hard-offline — excluded in both passes
        assert_eq!(pool.ordered_candidates(&HashSet::new(), false), vec!["b"]);
        assert_eq!(pool.ordered_candidates(&HashSet::new(), true), vec!["b"]);
        pool.reset_account("a");
        assert_eq!(pool.ordered_candidates(&HashSet::new(), false).len(), 2);
    }

    #[test]
    fn secrets_redacted_on_list() {
        let mut file = acc("a");
        file.fields.insert("apiKey".into(), json!("nvapi-xyz"));
        let mut pool = AccountPool::new(DefaultBehavior("nvidia"));
        pool.reload(vec![file], &mut HashMap::new(), 0);
        let listed = pool.list_accounts();
        assert_eq!(listed[0].config.field_str("apiKey"), Some("***"));
        // pool's own copy is untouched
        assert_eq!(
            pool.find("a")
                .expect("validated invariant")
                .config
                .field_str("apiKey"),
            Some("nvapi-xyz")
        );
    }
}
