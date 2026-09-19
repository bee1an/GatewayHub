//! WorkBuddy daily check-in — port of `checkin.ts`. billingPost tries hosts
//! in order (backend host, account domain, configured billingHosts, built-ins);
//! business errors stop the fallback.

use std::time::Duration;

use serde_json::Value;

use crate::providers::workbuddy_auth::{
    DEFAULT_WORKBUDDY_BACKEND, DEFAULT_WORKBUDDY_BILLING_HOSTS, WORKBUDDY_CHECKIN_CLAIM_PATH,
    WORKBUDDY_CHECKIN_STATUS_LEGACY_PATH, WORKBUDDY_CHECKIN_STATUS_PATH,
    WORKBUDDY_CREDITS_SUMMARY_PATH, build_workbuddy_headers,
};
use crate::types::AccountFile;

#[derive(Debug, Clone, Default)]
pub struct WorkBuddyCheckinStatus {
    pub checked_in: bool,
    pub total_credits: Option<u64>,
    pub streak_days: Option<u64>,
    pub active: bool,
}

/// `cnDayKey` — YYYY-MM-DD Asia/Shanghai.
pub fn cn_day_key(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|d| {
            d.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).expect("validated invariant"))
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

/// `getCheckinStatus` — checkin-activity-status, falling back to the legacy
/// checkin-status route only on 404.
pub async fn get_checkin_status(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    backend: &str,
    billing_hosts: &[String],
) -> anyhow::Result<WorkBuddyCheckinStatus> {
    let result = billing_post(
        client,
        account,
        token,
        backend,
        billing_hosts,
        WORKBUDDY_CHECKIN_STATUS_PATH,
        false,
    )
    .await;
    let payload = match result {
        Ok(p) => p,
        Err(e) => {
            if e.to_string().contains("HTTP 404") {
                billing_post(
                    client,
                    account,
                    token,
                    backend,
                    billing_hosts,
                    WORKBUDDY_CHECKIN_STATUS_LEGACY_PATH,
                    false,
                )
                .await?
            } else {
                return Err(e);
            }
        }
    };
    let data = payload
        .get("data")
        .or_else(|| payload.get("Data"))
        .unwrap_or(&payload);
    Ok(WorkBuddyCheckinStatus {
        checked_in: data
            .get("today_checked_in")
            .or_else(|| data.get("todayCheckedIn"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        total_credits: to_count(
            data.get("total_credits")
                .or_else(|| data.get("totalCredits"))
                .unwrap_or(&Value::Null),
        ),
        streak_days: to_count(
            data.get("streak_days")
                .or_else(|| data.get("streakDays"))
                .unwrap_or(&Value::Null),
        ),
        active: data.get("active").and_then(Value::as_bool) != Some(false),
    })
}

/// `getCreditsUsage` — sum CycleRemainCapacity across credits packages.
pub async fn get_credits_usage(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    backend: &str,
    billing_hosts: &[String],
) -> anyhow::Result<Option<u64>> {
    let payload = billing_post(
        client,
        account,
        token,
        backend,
        billing_hosts,
        WORKBUDDY_CREDITS_SUMMARY_PATH,
        false,
    )
    .await?;
    let packages = payload
        .get("data")
        .and_then(|d| d.get("Packages").or_else(|| d.get("packages")))
        .and_then(Value::as_array);
    let Some(packages) = packages else {
        return Ok(None);
    };
    // Capacities arrive as JSON strings ("2300") — `as_f64` alone reads
    // nothing, so accept both shapes.
    let to_f64 = |v: &Value| {
        v.as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
    };
    let mut total = 0.0f64;
    let mut found = false;
    for pkg in packages {
        let unit = pkg
            .get("CapacityUnit")
            .or_else(|| pkg.get("capacity_unit"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !unit.is_empty() && unit != "credits" {
            continue;
        }
        let remain = pkg
            .get("CycleRemainCapacity")
            .or_else(|| pkg.get("cycle_remain_capacity"))
            .and_then(to_f64);
        if let Some(remain) = remain {
            total += remain;
            found = true;
        }
    }
    Ok(found.then_some(total.round() as u64))
}

/// `claimCheckin` — tolerates code 10001 / 已签到.
pub async fn claim_checkin(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    backend: &str,
    billing_hosts: &[String],
) -> anyhow::Result<(bool, Option<u64>)> {
    let payload = billing_post(
        client,
        account,
        token,
        backend,
        billing_hosts,
        WORKBUDDY_CHECKIN_CLAIM_PATH,
        true,
    )
    .await?;
    let data = payload
        .get("data")
        .or_else(|| payload.get("Data"))
        .cloned()
        .unwrap_or(Value::Null);
    let code = payload.get("code").and_then(Value::as_i64).unwrap_or(0);
    let msg = payload.get("msg").and_then(Value::as_str).unwrap_or("");
    let already = code == 10001 || msg.contains("已签到");
    let credits = to_count(
        data.get("credit")
            .or_else(|| data.get("today_credit"))
            .or_else(|| data.get("daily_credit"))
            .or_else(|| data.get("total_credits"))
            .unwrap_or(&Value::Null),
    );
    Ok((already, credits))
}

/// `billingPost` — host fallback with business-error short-circuit.
/// 5xx from the APISIX front is intermittent — retry the same host once
/// before falling through to the next one.
async fn billing_post(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    backend: &str,
    billing_hosts: &[String],
    path: &str,
    tolerate_already_checked_in: bool,
) -> anyhow::Result<Value> {
    let hosts = billing_host_list(account, backend, billing_hosts);
    let mut last_error = anyhow::anyhow!("no billing hosts");
    for host in hosts {
        let url = format!("https://{host}{path}");
        let mut res = None;
        for attempt in 0..2 {
            let mut req = client
                .post(&url)
                .timeout(Duration::from_secs(20))
                .body("{}");
            for (k, v) in build_workbuddy_headers(account, token) {
                req = req.header(k, v);
            }
            match req.send().await {
                Ok(r) => {
                    res = Some(r);
                    break;
                }
                Err(e) => {
                    last_error = anyhow::anyhow!("{path} on {host}: {e}");
                    if attempt == 0 {
                        tokio::time::sleep(Duration::from_millis(800)).await;
                    }
                }
            }
        }
        let Some(res) = res else { continue };
        let status = res.status().as_u16();
        let text = res.text().await.unwrap_or_default();
        let payload: Value = serde_json::from_str(&text).unwrap_or_else(|_| {
            if text.is_empty() {
                Value::Null
            } else {
                Value::String(text.clone())
            }
        });
        let code = payload.get("code").or_else(|| payload.get("Code"));
        let msg = payload
            .get("msg")
            .or_else(|| payload.get("message"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let business_error = code
            .is_some_and(|c| !c.is_null() && !(c.as_i64() == Some(0) || c.as_str() == Some("0")));
        if business_error {
            if tolerate_already_checked_in
                && (code.and_then(Value::as_i64) == Some(10001) || msg.contains("已签到"))
            {
                return Ok(payload);
            }
            anyhow::bail!(
                "WorkBuddy check-in {path} failed: HTTP {status} {}",
                text.chars().take(500).collect::<String>()
            );
        }
        if status >= 400 {
            last_error = anyhow::anyhow!(
                "WorkBuddy check-in {path} HTTP {status} on {host}: {}",
                text.chars().take(500).collect::<String>()
            );
            // A 5xx response from the gateway is worth retrying on the
            // same host before moving on; 4xx is authoritative, move on.
            for _ in 0..2 {
                if status < 500 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1500)).await;
                let mut req = client
                    .post(&url)
                    .timeout(Duration::from_secs(20))
                    .body("{}");
                for (k, v) in build_workbuddy_headers(account, token) {
                    req = req.header(k, v);
                }
                if let Ok(r2) = req.send().await {
                    let status2 = r2.status().as_u16();
                    if status2 < 400 {
                        let text2 = r2.text().await.unwrap_or_default();
                        if let Ok(p2) = serde_json::from_str::<Value>(&text2) {
                            return Ok(p2);
                        }
                    }
                }
            }
            continue;
        }
        return Ok(payload);
    }
    Err(last_error)
}

/// `billingHosts` — backend host, account domain, configured, built-ins.
fn billing_host_list(
    account: &AccountFile,
    backend: &str,
    billing_hosts: &[String],
) -> Vec<String> {
    let backend_host = {
        let b = if backend.is_empty() {
            DEFAULT_WORKBUDDY_BACKEND
        } else {
            backend
        };
        b.trim_start_matches("http://")
            .trim_start_matches("https://")
            .split('/')
            .next()
            .unwrap_or("")
            .to_string()
    };
    let account_domain = account
        .fields
        .get("domain")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let mut out: Vec<String> = Vec::new();
    for h in [backend_host, account_domain]
        .into_iter()
        .chain(billing_hosts.iter().cloned())
        .chain(
            DEFAULT_WORKBUDDY_BILLING_HOSTS
                .iter()
                .map(|s| s.to_string()),
        )
    {
        let h = h.trim().to_string();
        if !h.is_empty() && !out.contains(&h) {
            out.push(h);
        }
    }
    out
}

fn to_count(value: &Value) -> Option<u64> {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
        .map(|n| n.round() as u64)
}
