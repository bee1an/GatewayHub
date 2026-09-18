//! Shared, entitlement-grouped model-catalog cache.
//!
//! Most upstreams return the *same* model catalog for every account that
//! shares an entitlement level (plan type, tier, client id). Fetching the
//! catalog once per account wastes requests — a 100-key OpenRouter pool
//! would otherwise serialize hundreds of identical calls on `/v1/models`.
//!
//! `SharedCatalog` caches fetched catalogs per *group key* (the caller
//! picks the entitlement axis — `""` when the catalog is uniform) and
//! single-flights concurrent fetches per group.

use std::collections::HashMap;
use std::future::Future;

use tokio::sync::{Mutex, RwLock};

use crate::pool::now_ms;

pub struct SharedCatalog<T> {
    cache: RwLock<HashMap<String, (T, i64)>>,
    /// One fetch at a time across all groups — group counts are tiny
    /// (1–3), so a global lock beats per-key bookkeeping.
    inflight: Mutex<()>,
}

impl<T: Clone> SharedCatalog<T> {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            inflight: Mutex::new(()),
        }
    }

    /// Fresh `group` entry → clone; otherwise one `fetch` populates it.
    /// Concurrent callers wait on the same lock and reuse the result.
    /// Errors are never cached — the next caller retries the fetch.
    pub async fn get_or_fetch<F, Fut>(
        &self,
        group: &str,
        ttl_ms: i64,
        fetch: F,
    ) -> anyhow::Result<T>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = anyhow::Result<T>>,
    {
        {
            let guard = self.cache.read().await;
            if let Some((v, at)) = guard.get(group)
                && now_ms() - *at < ttl_ms
            {
                return Ok(v.clone());
            }
        }
        let _lock = self.inflight.lock().await;
        {
            let guard = self.cache.read().await;
            if let Some((v, at)) = guard.get(group)
                && now_ms() - *at < ttl_ms
            {
                return Ok(v.clone());
            }
        }
        let v = fetch().await?;
        self.cache
            .write()
            .await
            .insert(group.to_string(), (v.clone(), now_ms()));
        Ok(v)
    }
}
