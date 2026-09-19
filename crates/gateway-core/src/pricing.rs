//! Token/credit pricing — port of `core/pricing.ts`. Builtin table +
//! `pricing.json` overrides + segment-fallback model resolution.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::types::UsageStats;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelPrice {
    pub input_per_m_tokens: f64,
    pub output_per_m_tokens: f64,
    #[serde(default)]
    pub cache_read_per_m_tokens: Option<f64>,
    #[serde(default)]
    pub cache_write5m_per_m_tokens: Option<f64>,
    #[serde(default)]
    pub cache_write1h_per_m_tokens: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CostStats {
    pub input_usd: f64,
    pub output_usd: f64,
    pub cache_read_usd: f64,
    pub cache_write_usd: f64,
    pub credits_usd: f64,
    pub total_usd: f64,
    pub currency: &'static str,
    pub known: bool,
    /// 'credit' | 'token' | 'free' | 'none'
    pub basis: &'static str,
}

fn zero_cost() -> CostStats {
    CostStats {
        input_usd: 0.0,
        output_usd: 0.0,
        cache_read_usd: 0.0,
        cache_write_usd: 0.0,
        credits_usd: 0.0,
        total_usd: 0.0,
        currency: "USD",
        known: false,
        basis: "none",
    }
}

fn price(input: f64, output: f64) -> ModelPrice {
    ModelPrice {
        input_per_m_tokens: input,
        output_per_m_tokens: output,
        cache_read_per_m_tokens: None,
        cache_write5m_per_m_tokens: None,
        cache_write1h_per_m_tokens: None,
    }
}

fn price_cache(input: f64, output: f64, read: f64, w5m: f64, w1h: f64) -> ModelPrice {
    ModelPrice {
        input_per_m_tokens: input,
        output_per_m_tokens: output,
        cache_read_per_m_tokens: Some(read),
        cache_write5m_per_m_tokens: Some(w5m),
        cache_write1h_per_m_tokens: Some(w1h),
    }
}

fn builtin() -> HashMap<String, ModelPrice> {
    let mut m = HashMap::new();
    for key in [
        "claude-opus-4",
        "claude-opus-4-1",
        "claude-opus-4-5",
        "claude-opus-4-7",
    ] {
        m.insert(key.to_string(), price_cache(15.0, 75.0, 1.5, 18.75, 30.0));
    }
    for key in ["claude-sonnet-4", "claude-sonnet-4-5", "claude-sonnet-4-6"] {
        m.insert(key.to_string(), price_cache(3.0, 15.0, 0.3, 3.75, 6.0));
    }
    m.insert(
        "claude-haiku-4-5".into(),
        price_cache(1.0, 5.0, 0.1, 1.25, 2.0),
    );
    m.insert(
        "claude-3-5-sonnet".into(),
        ModelPrice {
            cache_write1h_per_m_tokens: None,
            ..price_cache(3.0, 15.0, 0.3, 3.75, 0.0)
        },
    );
    m.insert(
        "claude-3-5-haiku".into(),
        ModelPrice {
            cache_write1h_per_m_tokens: None,
            ..price_cache(0.8, 4.0, 0.08, 1.0, 0.0)
        },
    );
    m.insert(
        "claude-3-opus".into(),
        ModelPrice {
            cache_write1h_per_m_tokens: None,
            ..price_cache(15.0, 75.0, 1.5, 18.75, 0.0)
        },
    );
    for key in [
        "gpt-5",
        "gpt-5-codex",
        "gpt-5.1",
        "gpt-5.1-codex",
        "gpt-5.1-codex-max",
    ] {
        m.insert(
            key.to_string(),
            ModelPrice {
                cache_write5m_per_m_tokens: None,
                cache_write1h_per_m_tokens: None,
                ..price_cache(1.25, 10.0, 0.125, 0.0, 0.0)
            },
        );
    }
    m.insert("gpt-5-pro".into(), price(15.0, 120.0));
    m.insert(
        "gpt-5-mini".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(0.25, 2.0, 0.025, 0.0, 0.0)
        },
    );
    m.insert(
        "gpt-5.1-codex-mini".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(0.25, 2.0, 0.025, 0.0, 0.0)
        },
    );
    m.insert(
        "gpt-5-nano".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(0.05, 0.4, 0.005, 0.0, 0.0)
        },
    );
    m.insert(
        "gpt-4.1".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(2.0, 8.0, 0.5, 0.0, 0.0)
        },
    );
    m.insert(
        "gpt-4.1-mini".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(0.4, 1.6, 0.1, 0.0, 0.0)
        },
    );
    m.insert(
        "gpt-4o".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(2.5, 10.0, 1.25, 0.0, 0.0)
        },
    );
    m.insert(
        "gpt-4o-mini".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(0.15, 0.6, 0.075, 0.0, 0.0)
        },
    );
    m.insert(
        "o4-mini".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(1.1, 4.4, 0.275, 0.0, 0.0)
        },
    );
    m.insert(
        "o3".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(2.0, 8.0, 0.5, 0.0, 0.0)
        },
    );
    // ---- z.ai GLM (glm-5.x share one rate card; flash line is cheaper) ----
    for key in ["glm-5.1", "glm-5.2", "glm-5.3"] {
        m.insert(
            key.to_string(),
            ModelPrice {
                cache_write5m_per_m_tokens: None,
                cache_write1h_per_m_tokens: None,
                ..price_cache(1.4, 4.4, 0.26, 0.0, 0.0)
            },
        );
    }
    m.insert(
        "glm-5".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(1.0, 3.2, 0.2, 0.0, 0.0)
        },
    );
    for key in ["glm-5.3-flash", "glm-4.7-flashx", "glm-4.5-flash"] {
        m.insert(
            key.to_string(),
            ModelPrice {
                cache_write5m_per_m_tokens: None,
                cache_write1h_per_m_tokens: None,
                ..price_cache(0.1, 0.5, 0.01, 0.0, 0.0)
            },
        );
    }
    // ---- DeepSeek direct API ----
    // cache_read = the discounted cache-hit input rate; DeepSeek doesn't
    // meter cache writes separately so write lanes stay unpriced.
    for key in [
        "deepseek-v4-flash",
        "deepseek-v4-flash-official",
        "deepseek-chat",
    ] {
        m.insert(
            key.to_string(),
            ModelPrice {
                cache_write5m_per_m_tokens: None,
                cache_write1h_per_m_tokens: None,
                ..price_cache(0.14, 0.28, 0.0028, 0.0, 0.0)
            },
        );
    }
    for key in ["deepseek-v4-pro", "deepseek-reasoner"] {
        m.insert(
            key.to_string(),
            ModelPrice {
                cache_write5m_per_m_tokens: None,
                cache_write1h_per_m_tokens: None,
                ..price_cache(0.435, 0.87, 0.0036, 0.0, 0.0)
            },
        );
    }
    // ---- Moonshot Kimi ----
    for key in ["kimi-k2", "kimi-k2.6", "kimi-k2.7-code"] {
        m.insert(
            key.to_string(),
            ModelPrice {
                cache_write5m_per_m_tokens: None,
                cache_write1h_per_m_tokens: None,
                ..price_cache(0.95, 4.0, 0.16, 0.0, 0.0)
            },
        );
    }
    m.insert(
        "kimi-k3".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(3.0, 15.0, 0.3, 0.0, 0.0)
        },
    );
    // ---- Google Gemini ----
    m.insert(
        "gemini-3-pro".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(2.0, 12.0, 0.2, 0.0, 0.0)
        },
    );
    for key in ["gemini-3-flash", "gemini-2.5-flash"] {
        m.insert(
            key.to_string(),
            ModelPrice {
                cache_write5m_per_m_tokens: None,
                cache_write1h_per_m_tokens: None,
                ..price_cache(0.3, 2.5, 0.03, 0.0, 0.0)
            },
        );
    }
    m.insert(
        "gemini-2.5-pro".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(1.25, 10.0, 0.125, 0.0, 0.0)
        },
    );
    // ---- Alibaba Qwen / xAI Grok / MiniMax ----
    m.insert("qwen3-max".into(), price(1.2, 6.0));
    m.insert("qwen3-coder".into(), price(0.5, 2.0));
    m.insert(
        "grok-4-fast".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(0.2, 0.5, 0.02, 0.0, 0.0)
        },
    );
    m.insert(
        "grok-4".into(),
        ModelPrice {
            cache_write5m_per_m_tokens: None,
            cache_write1h_per_m_tokens: None,
            ..price_cache(3.0, 15.0, 0.3, 0.0, 0.0)
        },
    );
    for key in ["minimax-m2", "minimax-m2.5"] {
        m.insert(key.to_string(), price(0.3, 1.2));
    }
    m
}

fn builtin_credit_prices() -> HashMap<String, f64> {
    // Kiro subscription: Pro/Pro+/Power 0.02/credit (overage 0.04)
    HashMap::from([("kiro".to_string(), 0.02)])
}

pub struct PricingTable {
    prices: HashMap<String, ModelPrice>,
    credits: HashMap<String, f64>,
}

impl Default for PricingTable {
    fn default() -> Self {
        Self::new(None)
    }
}

impl PricingTable {
    pub fn new(overrides_path: Option<&std::path::Path>) -> Self {
        let mut prices = builtin();
        let mut credits = builtin_credit_prices();
        if let Some(path) = overrides_path {
            apply_overrides(path, &mut prices, &mut credits);
        }
        Self { prices, credits }
    }

    pub fn list(&self) -> &HashMap<String, ModelPrice> {
        &self.prices
    }

    pub fn credit_price(&self, provider: &str) -> Option<f64> {
        self.credits.get(provider).copied()
    }

    /// Segment-fallback resolution — `claude-sonnet-4-5-20250920` →
    /// `claude-sonnet-4-5` → `claude-sonnet-4`, plus decimal-tail strip.
    pub fn resolve(&self, model: &str) -> Option<ModelPrice> {
        let key = normalize_model_key(model);
        if key.is_empty() {
            return None;
        }
        if let Some(p) = self.prices.get(&key) {
            return Some(*p);
        }
        let parts: Vec<&str> = key.split('-').collect();
        for i in (1..=parts.len()).rev() {
            let head = parts[..i].join("-");
            for candidate in [head.clone(), strip_trailing_decimal(&head)] {
                if candidate.is_empty() || candidate == key {
                    continue;
                }
                if let Some(p) = self.prices.get(&candidate) {
                    return Some(*p);
                }
            }
        }
        None
    }

    /// `compute` port — `:free` ids are known-zero (aggregator free tier),
    /// then credit-basis (kiro), else token pricing.
    pub fn compute(&self, model: &str, usage: &UsageStats, provider: Option<&str>) -> CostStats {
        // Must run before `resolve`: `deepseek-v4-flash-0731:free` would
        // otherwise fall back to the paid `deepseek-v4-flash` row.
        if normalize_model_key(model).ends_with(":free") {
            return CostStats {
                known: true,
                basis: "free",
                ..zero_cost()
            };
        }
        if let Some(credit_price) = provider.and_then(|p| self.credit_price(p))
            && let Some(credits) = usage.credits.filter(|c| *c > 0.0)
        {
            let credits_usd = credits * credit_price;
            return CostStats {
                credits_usd,
                total_usd: credits_usd,
                known: true,
                basis: "credit",
                ..zero_cost()
            };
        }
        let Some(price) = self.resolve(model) else {
            return zero_cost();
        };
        let input_usd = (usage.input_tokens as f64 * price.input_per_m_tokens) / 1e6;
        let output_usd = (usage.output_tokens as f64 * price.output_per_m_tokens) / 1e6;
        let cache_read_usd = (usage.cache_read_tokens.unwrap_or(0) as f64
            * price.cache_read_per_m_tokens.unwrap_or(0.0))
            / 1e6;
        let cache_write_usd = (usage.cache_write5m_tokens.unwrap_or(0) as f64
            * price.cache_write5m_per_m_tokens.unwrap_or(0.0)
            + usage.cache_write1h_tokens.unwrap_or(0) as f64
                * price.cache_write1h_per_m_tokens.unwrap_or(0.0))
            / 1e6;
        CostStats {
            input_usd,
            output_usd,
            cache_read_usd,
            cache_write_usd,
            credits_usd: 0.0,
            total_usd: input_usd + output_usd + cache_read_usd + cache_write_usd,
            currency: "USD",
            known: true,
            basis: "token",
        }
    }
}

/// `normalizeModelKey` — strip `provider/` prefix, lowercase.
pub fn normalize_model_key(model: &str) -> String {
    let trimmed = match model.find('/') {
        Some(i) => &model[i + 1..],
        None => model,
    };
    trimmed.trim().to_lowercase()
}

/// `claude-opus-4.7` → `claude-opus-4`; no decimal tail → "".
fn strip_trailing_decimal(key: &str) -> String {
    let Some(idx) = key.rfind('-') else {
        return String::new();
    };
    let last = &key[idx + 1..];
    let Some(dot) = last.find('.') else {
        return String::new();
    };
    format!("{}{}", &key[..idx + 1], &last[..dot])
}

/// `loadPricingOverrides` — `pricing.json` with `__credits__` section.
fn apply_overrides(
    path: &std::path::Path,
    prices: &mut HashMap<String, ModelPrice>,
    credits: &mut HashMap<String, f64>,
) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(map) = parsed.as_object() else {
        return;
    };
    for (key, value) in map {
        if key == "__credits__" {
            if let Some(obj) = value.as_object() {
                for (provider, price) in obj {
                    if let Some(p) = price.as_f64().filter(|p| p.is_finite() && *p >= 0.0) {
                        credits.insert(provider.clone(), p);
                    }
                }
            }
            continue;
        }
        let Some(v) = value.as_object() else {
            continue;
        };
        let (Some(input), Some(output)) = (
            v.get("inputPerMTokens").and_then(Value::as_f64),
            v.get("outputPerMTokens").and_then(Value::as_f64),
        ) else {
            continue;
        };
        prices.insert(
            normalize_model_key(key),
            ModelPrice {
                input_per_m_tokens: input,
                output_per_m_tokens: output,
                cache_read_per_m_tokens: v.get("cacheReadPerMTokens").and_then(Value::as_f64),
                cache_write5m_per_m_tokens: v.get("cacheWrite5mPerMTokens").and_then(Value::as_f64),
                cache_write1h_per_m_tokens: v.get("cacheWrite1hPerMTokens").and_then(Value::as_f64),
            },
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_falls_back_segments() {
        let table = PricingTable::default();
        assert!(table.resolve("claude-sonnet-4-5-20250920").is_some());
        assert!(table.resolve("claude-opus-4.7").is_some());
        assert!(table.resolve("openrouter/gpt-5").is_some());
        assert!(table.resolve("totally-unknown-model").is_none());
    }

    #[test]
    fn gateway_models_resolve() {
        let table = PricingTable::default();
        for model in [
            "glm-5.3",
            "glm-5.3-flash",
            "deepseek-v4-flash-official",
            "deepseek-v4-pro",
            "kimi-k2.6",
            "gemini-3-pro",
            "minimax-m2.5",
        ] {
            assert!(table.resolve(model).is_some(), "{model}");
        }
        // A `:free` id must price at zero, never fall back to the paid row.
        let cost = table.compute(
            "deepseek-v4-flash-0731:free",
            &UsageStats {
                input_tokens: 1_000_000,
                output_tokens: 1_000_000,
                ..Default::default()
            },
            Some("openrouter"),
        );
        assert!(cost.known && cost.basis == "free" && cost.total_usd == 0.0);
        // GLM cache reads price at the cached-input rate.
        let cost = table.compute(
            "glm-5.3",
            &UsageStats {
                input_tokens: 1_000_000,
                cache_read_tokens: Some(1_000_000),
                ..Default::default()
            },
            Some("traework"),
        );
        assert!((cost.total_usd - (1.4 + 0.26)).abs() < 1e-9);
    }

    #[test]
    fn compute_credit_beats_tokens() {
        let table = PricingTable::default();
        let usage = UsageStats {
            input_tokens: 1000,
            output_tokens: 500,
            credits: Some(2.5),
            ..Default::default()
        };
        let cost = table.compute("claude-sonnet-4-5", &usage, Some("kiro"));
        assert!(cost.known && cost.basis == "credit");
        assert!((cost.total_usd - 0.05).abs() < 1e-9);
        let cost2 = table.compute("claude-sonnet-4-5", &usage, Some("nvidia"));
        assert_eq!(cost2.basis, "token");
    }
}
