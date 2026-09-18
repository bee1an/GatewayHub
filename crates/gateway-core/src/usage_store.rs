//! Usage store — port of `core/usageStore.ts`. Same on-disk layout as the
//! Electron store (`usage-store/v1.json`, packed 7-tuples) so both apps can
//! read each other's data. Single-process writes use a mutex + atomic
//! tmp+rename instead of the TS lockfile.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::pricing::{PricingTable, normalize_model_key};
use crate::types::UsageStats;

const STORE_VERSION: u32 = 1;
const RETENTION_DAYS: i64 = 30;
const UNKNOWN_ACCOUNT_ID: &str = "_unknown_";

/// `[input, output, cacheRead, cw5m, cw1h, requests, credits×1e6]`
type PackedUsage = [i64; 7];

#[derive(Debug, Clone, Default)]
struct ModelEntry {
    packed: PackedUsage,
    api_format: Option<String>,
    provider: Option<String>,
    updated_at: String,
}

type StoreDays = BTreeMap<String, BTreeMap<String, BTreeMap<String, ModelEntry>>>;

#[derive(Debug)]
struct StoreFile {
    days: StoreDays,
}

pub struct UsageRecordInput {
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub api_format: Option<String>,
    pub provider: Option<String>,
    pub usage: UsageStats,
    pub timestamp: Option<chrono::DateTime<chrono::Local>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDailyEntry {
    pub date: String,
    pub account_id: String,
    pub model: String,
    pub provider: Option<String>,
    pub api_format: Option<String>,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write5m_tokens: i64,
    pub cache_write1h_tokens: i64,
    pub credits: f64,
    pub requests: i64,
    pub cost_usd: Option<f64>,
    pub cost_basis: &'static str,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub today_tokens: i64,
    pub today_credits: f64,
    pub today_cost_usd: Option<f64>,
    pub last30days_tokens: i64,
    pub last30days_credits: f64,
    pub last30days_cost_usd: Option<f64>,
    pub today_input_tokens: i64,
    pub today_output_tokens: i64,
    pub today_cache_read_tokens: i64,
    pub today_cache_write_tokens: i64,
    pub today_requests: i64,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageDetail {
    pub summary: UsageSummary,
    pub daily: Vec<UsageDailyEntry>,
}

#[derive(Debug, Clone, Default)]
pub struct UsageReadOptions {
    pub since_key: Option<String>,
    pub until_key: Option<String>,
    pub account_id: Option<String>,
    pub model: Option<String>,
    pub provider: Option<String>,
}

pub struct UsageStore {
    file_path: PathBuf,
    pricing: PricingTable,
    write_lock: Mutex<()>,
}

fn empty_packed() -> PackedUsage {
    [0; 7]
}

fn packed_from_usage(usage: &UsageStats) -> PackedUsage {
    let credits = usage.credits.unwrap_or(0.0).max(0.0);
    [
        usage.input_tokens as i64,
        usage.output_tokens as i64,
        usage.cache_read_tokens.unwrap_or(0) as i64,
        usage.cache_write5m_tokens.unwrap_or(0) as i64,
        usage.cache_write1h_tokens.unwrap_or(0) as i64,
        1,
        (credits * 1e6).round() as i64,
    ]
}

fn total_tokens(p: &PackedUsage) -> i64 {
    p[0] + p[1] + p[2] + p[3] + p[4]
}

fn packed_credits(p: &PackedUsage) -> f64 {
    p[6] as f64 / 1e6
}

fn local_day_key(dt: &chrono::DateTime<chrono::Local>) -> String {
    dt.format("%Y-%m-%d").to_string()
}

fn now_iso() -> String {
    chrono::Local::now().to_rfc3339()
}

/// Parse the Electron file format — tolerant like `normalizeStore`
/// (accepts 6- and 7-element packed arrays, drops malformed entries).
fn normalize_store(value: &Value) -> StoreFile {
    let mut days = StoreDays::new();
    let Some(days_map) = value.get("days").and_then(Value::as_object) else {
        return StoreFile { days };
    };
    for (day_key, accounts_raw) in days_map {
        let Some(accounts_map) = accounts_raw.as_object() else {
            continue;
        };
        let mut accounts = BTreeMap::new();
        for (account_id, models_raw) in accounts_map {
            let Some(models_map) = models_raw.as_object() else {
                continue;
            };
            let mut models = BTreeMap::new();
            for (model_key, entry_raw) in models_map {
                let Some(entry) = entry_raw.as_object() else {
                    continue;
                };
                let Some(packed_arr) = entry.get("packed").and_then(Value::as_array) else {
                    continue;
                };
                if packed_arr.len() != 6 && packed_arr.len() != 7 {
                    continue;
                }
                let mut packed = empty_packed();
                for (i, slot) in packed.iter_mut().enumerate() {
                    *slot = packed_arr
                        .get(i)
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                        .max(0.0)
                        .trunc() as i64;
                }
                models.insert(
                    model_key.clone(),
                    ModelEntry {
                        packed,
                        api_format: entry
                            .get("apiFormat")
                            .and_then(Value::as_str)
                            .filter(|f| matches!(*f, "openai" | "anthropic" | "responses"))
                            .map(str::to_string),
                        provider: entry
                            .get("provider")
                            .and_then(Value::as_str)
                            .filter(|p| !p.is_empty())
                            .map(str::to_string),
                        updated_at: entry
                            .get("updatedAt")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string(),
                    },
                );
            }
            if !models.is_empty() {
                accounts.insert(account_id.clone(), models);
            }
        }
        if !accounts.is_empty() {
            days.insert(day_key.clone(), accounts);
        }
    }
    StoreFile { days }
}

fn serialize_store(store: &StoreFile) -> Value {
    let mut days = Map::new();
    for (day_key, accounts) in &store.days {
        let mut accounts_map = Map::new();
        for (account_id, models) in accounts {
            let mut models_map = Map::new();
            for (model_key, entry) in models {
                let mut e = Map::new();
                e.insert(
                    "packed".into(),
                    Value::Array(entry.packed.iter().map(|v| Value::from(*v)).collect()),
                );
                if let Some(f) = &entry.api_format {
                    e.insert("apiFormat".into(), Value::String(f.clone()));
                }
                if let Some(p) = &entry.provider {
                    e.insert("provider".into(), Value::String(p.clone()));
                }
                e.insert("updatedAt".into(), Value::String(entry.updated_at.clone()));
                models_map.insert(model_key.clone(), Value::Object(e));
            }
            accounts_map.insert(account_id.clone(), Value::Object(models_map));
        }
        days.insert(day_key.clone(), Value::Object(accounts_map));
    }
    serde_json::json!({ "version": STORE_VERSION, "days": Value::Object(days) })
}

impl UsageStore {
    pub fn new(file_path: PathBuf, pricing: PricingTable) -> Self {
        Self {
            file_path,
            pricing,
            write_lock: Mutex::new(()),
        }
    }

    pub fn file_path(&self) -> &PathBuf {
        &self.file_path
    }

    fn load_store(&self) -> StoreFile {
        let Ok(raw) = std::fs::read_to_string(&self.file_path) else {
            return StoreFile {
                days: StoreDays::new(),
            };
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            self.backup_corrupt("invalid-json");
            return StoreFile {
                days: StoreDays::new(),
            };
        };
        if parsed.get("version").and_then(Value::as_u64) != Some(STORE_VERSION as u64) {
            let tag = parsed
                .get("version")
                .map(|v| v.to_string())
                .unwrap_or_else(|| "unknown".into());
            self.backup_corrupt(&tag);
            return StoreFile {
                days: StoreDays::new(),
            };
        }
        normalize_store(&parsed)
    }

    fn backup_corrupt(&self, tag: &str) {
        let backup = format!(
            "{}.bak.{}.{}",
            self.file_path.display(),
            tag,
            crate::pool::now_ms()
        );
        let _ = std::fs::rename(&self.file_path, &backup);
    }

    fn persist(&self, store: &StoreFile) -> anyhow::Result<()> {
        if let Some(dir) = self.file_path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = self
            .file_path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
        let body = format!("{}\n", serde_json::to_string(&serialize_store(store))?);
        std::fs::write(&tmp, body)?;
        std::fs::rename(&tmp, &self.file_path)?;
        Ok(())
    }

    /// `record` — serialized read-modify-write; skip all-zero records.
    pub fn record(&self, input: UsageRecordInput) -> anyhow::Result<()> {
        let packed = packed_from_usage(&input.usage);
        if total_tokens(&packed) == 0 && packed_credits(&packed) == 0.0 && packed[5] == 0 {
            return Ok(());
        }
        let account_id = input
            .account_id
            .map(|a| a.trim().to_string())
            .filter(|a| !a.is_empty())
            .unwrap_or_else(|| UNKNOWN_ACCOUNT_ID.into());
        let model = normalize_model_key(input.model.as_deref().unwrap_or("unknown"));
        let ts = input.timestamp.unwrap_or_else(chrono::Local::now);
        let day_key = local_day_key(&ts);
        let updated_at = now_iso();

        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("usage lock"))?;
        let mut store = self.load_store();
        let entry = store
            .days
            .entry(day_key.clone())
            .or_default()
            .entry(account_id)
            .or_default()
            .entry(model)
            .or_insert_with(|| ModelEntry {
                updated_at: updated_at.clone(),
                ..Default::default()
            });
        for (total, value) in entry.packed.iter_mut().zip(packed) {
            *total += value;
        }
        if let Some(f) = &input.api_format {
            entry.api_format = Some(f.clone());
        }
        if let Some(p) = &input.provider {
            entry.provider = Some(p.clone());
        }
        entry.updated_at = updated_at;

        let cutoff =
            local_day_key(&(chrono::Local::now() - chrono::Duration::days(RETENTION_DAYS - 1)));
        store.days.retain(|k, _| k.as_str() >= cutoff.as_str());
        self.persist(&store)
    }

    /// `read` — filtered daily entries + summary.
    pub fn read(&self, options: &UsageReadOptions) -> UsageDetail {
        let store = self.load_store();
        let now = chrono::Local::now();
        let today_key = local_day_key(&now);
        let since = options
            .since_key
            .clone()
            .unwrap_or_else(|| local_day_key(&(now - chrono::Duration::days(RETENTION_DAYS - 1))));
        let until = options
            .until_key
            .clone()
            .unwrap_or_else(|| today_key.clone());
        if since > until {
            return UsageDetail {
                summary: UsageSummary {
                    updated_at: now_iso(),
                    ..Default::default()
                },
                daily: Vec::new(),
            };
        }
        let account_filter = options
            .account_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let model_filter = options.model.as_deref().map(normalize_model_key);
        let provider_filter = options
            .provider
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty());

        let mut daily = Vec::new();
        for (day_key, accounts) in &store.days {
            if day_key.as_str() < since.as_str() || day_key.as_str() > until.as_str() {
                continue;
            }
            for (account_id, models) in accounts {
                if account_filter.is_some_and(|f| f != account_id) {
                    continue;
                }
                for (model, entry) in models {
                    if model_filter.as_ref().is_some_and(|f| f != model) {
                        continue;
                    }
                    if provider_filter.is_some_and(|f| Some(f) != entry.provider.as_deref()) {
                        continue;
                    }
                    let usage = UsageStats {
                        input_tokens: entry.packed[0] as u64,
                        output_tokens: entry.packed[1] as u64,
                        cache_read_tokens: Some(entry.packed[2] as u64),
                        cache_write5m_tokens: Some(entry.packed[3] as u64),
                        cache_write1h_tokens: Some(entry.packed[4] as u64),
                        credits: (entry.packed[6] > 0).then(|| packed_credits(&entry.packed)),
                        ..Default::default()
                    };
                    let cost = self
                        .pricing
                        .compute(model, &usage, entry.provider.as_deref());
                    daily.push(UsageDailyEntry {
                        date: day_key.clone(),
                        account_id: account_id.clone(),
                        model: model.clone(),
                        provider: entry.provider.clone(),
                        api_format: entry.api_format.clone(),
                        input_tokens: entry.packed[0],
                        output_tokens: entry.packed[1],
                        cache_read_tokens: entry.packed[2],
                        cache_write5m_tokens: entry.packed[3],
                        cache_write1h_tokens: entry.packed[4],
                        credits: packed_credits(&entry.packed),
                        requests: entry.packed[5],
                        cost_usd: cost.known.then_some(cost.total_usd),
                        cost_basis: cost.basis,
                        updated_at: entry.updated_at.clone(),
                    });
                }
            }
        }
        UsageDetail {
            summary: build_summary(&daily, &today_key),
            daily,
        }
    }

    pub fn clear(&self) -> anyhow::Result<()> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| anyhow::anyhow!("usage lock"))?;
        self.persist(&StoreFile {
            days: StoreDays::new(),
        })
    }
}

fn build_summary(daily: &[UsageDailyEntry], today_key: &str) -> UsageSummary {
    let mut s = UsageSummary {
        updated_at: now_iso(),
        ..Default::default()
    };
    let mut today_cost = 0.0;
    let mut today_cost_known = false;
    let mut total30_cost = 0.0;
    let mut total30_cost_known = false;
    for e in daily {
        let tokens = e.input_tokens
            + e.output_tokens
            + e.cache_read_tokens
            + e.cache_write5m_tokens
            + e.cache_write1h_tokens;
        s.last30days_tokens += tokens;
        s.last30days_credits += e.credits;
        if let Some(c) = e.cost_usd {
            total30_cost += c;
            total30_cost_known = true;
        }
        if e.date == today_key {
            s.today_tokens += tokens;
            s.today_credits += e.credits;
            s.today_input_tokens += e.input_tokens;
            s.today_output_tokens += e.output_tokens;
            s.today_cache_read_tokens += e.cache_read_tokens;
            s.today_cache_write_tokens += e.cache_write5m_tokens + e.cache_write1h_tokens;
            s.today_requests += e.requests;
            if let Some(c) = e.cost_usd {
                today_cost += c;
                today_cost_known = true;
            }
        }
    }
    s.today_cost_usd = today_cost_known.then_some(today_cost);
    s.last30days_cost_usd = total30_cost_known.then_some(total30_cost);
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_at(dir: &std::path::Path) -> UsageStore {
        UsageStore::new(dir.join("usage-store/v1.json"), PricingTable::default())
    }

    #[test]
    fn record_read_roundtrip() {
        let tmp = tempfile::tempdir().expect("validated invariant");
        let store = store_at(tmp.path());
        store
            .record(UsageRecordInput {
                account_id: Some("a1".into()),
                model: Some("nvidia/meta/llama-3.1-8b-instruct".into()),
                api_format: Some("openai".into()),
                provider: Some("nvidia".into()),
                usage: UsageStats {
                    input_tokens: 10,
                    output_tokens: 5,
                    ..Default::default()
                },
                timestamp: None,
            })
            .expect("validated invariant");
        let detail = store.read(&UsageReadOptions::default());
        assert_eq!(detail.daily.len(), 1);
        let e = &detail.daily[0];
        assert_eq!(e.account_id, "a1");
        assert_eq!(e.model, "meta/llama-3.1-8b-instruct"); // prefix stripped
        assert_eq!(e.provider.as_deref(), Some("nvidia"));
        assert_eq!(e.requests, 1);
        assert_eq!(detail.summary.today_requests, 1);
        assert_eq!(detail.summary.today_tokens, 15);

        // Electron-format file is loadable (packed 6-tuple too)
        let raw = std::fs::read_to_string(store.file_path()).expect("validated invariant");
        assert!(raw.contains("\"packed\""));

        // filter by provider
        let detail = store.read(&UsageReadOptions {
            provider: Some("openrouter".into()),
            ..Default::default()
        });
        assert!(detail.daily.is_empty());
    }

    #[test]
    fn zero_usage_still_counts_request() {
        // TS quirk: packed[5] (requests) is always 1, so the all-zero skip
        // branch never fires — a zero-token record still bumps requests.
        let tmp = tempfile::tempdir().expect("validated invariant");
        let store = store_at(tmp.path());
        store
            .record(UsageRecordInput {
                account_id: None,
                model: None,
                api_format: None,
                provider: None,
                usage: UsageStats::default(),
                timestamp: None,
            })
            .expect("validated invariant");
        let detail = store.read(&UsageReadOptions::default());
        assert_eq!(detail.daily.len(), 1);
        assert_eq!(detail.daily[0].requests, 1);
        assert_eq!(detail.summary.today_tokens, 0);
        assert_eq!(detail.daily[0].account_id, UNKNOWN_ACCOUNT_ID);
    }
}
