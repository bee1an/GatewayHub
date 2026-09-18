//! TraeWork daily check-in — port of `checkin.ts`. api.trae.cn "ug" surface:
//! checkin_credits/status + claim + ide_user_ent_usage.

use std::time::Duration;

use serde_json::Value;

use crate::types::AccountFile;

pub const TRAEWORK_CHECKIN_STATUS_PATH: &str = "/trae/api/v2/ug/checkin_credits/status";
pub const TRAEWORK_CHECKIN_CLAIM_PATH: &str = "/trae/api/v2/ug/checkin_credits/claim";
pub const TRAEWORK_ENT_USAGE_PATH: &str = "/trae/api/v2/pay/ide_user_ent_usage";

#[derive(Debug, Clone, Default)]
pub struct CheckinStatus {
    pub checked_in: bool,
    pub credits: u64,
    pub extra_credits: u64,
    pub enable: bool,
}

/// `cnDayKey` — YYYY-MM-DD in Asia/Shanghai (+08:00).
pub fn cn_day_key(now_ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(now_ms)
        .map(|d| {
            d.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).expect("validated invariant"))
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

/// `buildUgHeaders`.
fn build_ug_headers(account: &AccountFile, token: &str) -> Vec<(String, String)> {
    let f = |k: &str| {
        account
            .fields
            .get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let mut headers = vec![
        ("content-type".into(), "application/json".into()),
        ("accept".into(), "application/json".into()),
        ("authorization".into(), format!("Cloud-IDE-JWT {token}")),
        ("x-cloudide-token".into(), token.to_string()),
        ("x-user-region".into(), {
            let c = f("countryCode");
            if c.is_empty() { "CN".into() } else { c }
        }),
        ("user-agent".into(), "TraeClient/TTNet".into()),
    ];
    let device_id = {
        let d = f("deviceId");
        if d.is_empty() { f("devDeviceId") } else { d }
    };
    if !device_id.is_empty() {
        headers.push(("x-device-id".into(), device_id));
    }
    let machine_id = f("machineId");
    if !machine_id.is_empty() {
        headers.push(("x-machine-id".into(), machine_id));
    }
    let uid = f("userId");
    if !uid.is_empty() {
        headers.push(("x-uid".into(), uid));
    }
    headers
}

async fn ug_post(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    auth_base_url: &str,
    path: &str,
) -> anyhow::Result<Value> {
    let base = account
        .fields
        .get("authBaseUrl")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(auth_base_url);
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let mut req = client
        .post(&url)
        .timeout(Duration::from_secs(20))
        .body("{}")
        .header("content-type", "application/json");
    for (k, v) in build_ug_headers(account, token) {
        req = req.header(k, v);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&text).unwrap_or_else(|_| json_value(&text));
    let code = payload
        .get("code")
        .or_else(|| payload.get("Code"))
        .or_else(|| payload.pointer("/error/code"));
    let failed = status >= 400
        || code.is_some_and(|c| {
            !c.is_null()
                && !(c.as_i64() == Some(0)
                    || c.as_str().is_some_and(|s| matches!(s, "0" | "OK" | "ok")))
        });
    if failed {
        anyhow::bail!(
            "TraeWork check-in request failed: HTTP {status} {}",
            text.chars().take(500).collect::<String>()
        );
    }
    Ok(payload
        .get("Result")
        .or_else(|| payload.get("result"))
        .cloned()
        .unwrap_or(payload))
}

fn json_value(text: &str) -> Value {
    if text.is_empty() {
        Value::Null
    } else {
        Value::String(text.to_string())
    }
}

fn to_count(value: &Value) -> u64 {
    value
        .as_f64()
        .or_else(|| value.as_str().and_then(|s| s.parse::<f64>().ok()))
        .filter(|n| *n > 0.0)
        .map(|n| n.round() as u64)
        .unwrap_or(0)
}

/// `getCheckinStatus`.
pub async fn get_checkin_status(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    auth_base_url: &str,
) -> anyhow::Result<CheckinStatus> {
    let payload = ug_post(
        client,
        account,
        token,
        auth_base_url,
        TRAEWORK_CHECKIN_STATUS_PATH,
    )
    .await?;
    Ok(CheckinStatus {
        checked_in: payload
            .get("checked_in")
            .or_else(|| payload.get("checkedIn"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        credits: to_count(
            payload
                .get("credits")
                .or_else(|| payload.get("Credits"))
                .unwrap_or(&Value::Null),
        ),
        extra_credits: to_count(
            payload
                .get("extra_credits")
                .or_else(|| payload.get("extraCredits"))
                .unwrap_or(&Value::Null),
        ),
        enable: payload
            .get("enable")
            .or_else(|| payload.get("Enable"))
            .and_then(Value::as_bool)
            != Some(false),
    })
}

/// `claimCheckin`.
pub async fn claim_checkin(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    auth_base_url: &str,
) -> anyhow::Result<Option<u64>> {
    let payload = ug_post(
        client,
        account,
        token,
        auth_base_url,
        TRAEWORK_CHECKIN_CLAIM_PATH,
    )
    .await?;
    Ok(payload
        .get("credits")
        .or_else(|| payload.get("Credits"))
        .map(to_count))
}

/// `getCreditsUsage` — usage_summary or entitlement pack sum.
pub async fn get_credits_usage(
    client: &reqwest::Client,
    account: &AccountFile,
    token: &str,
    auth_base_url: &str,
) -> anyhow::Result<Option<u64>> {
    let payload = ug_post(
        client,
        account,
        token,
        auth_base_url,
        TRAEWORK_ENT_USAGE_PATH,
    )
    .await?;
    let summary = payload
        .get("usage_summary")
        .or_else(|| payload.get("usageSummary"))
        .cloned()
        .unwrap_or(Value::Null);
    let total = summary
        .get("total_amount")
        .or_else(|| summary.get("totalAmount"))
        .and_then(Value::as_f64);
    let consumed = summary
        .get("consumed_amount")
        .or_else(|| summary.get("consumedAmount"))
        .and_then(Value::as_f64);
    if let Some(total) = total
        && total > 0.0
    {
        return Ok(Some(
            (total - consumed.unwrap_or(0.0)).max(0.0).round() as u64
        ));
    }
    let packs = payload
        .get("user_entitlement_pack_list")
        .or_else(|| payload.get("userEntitlementPackList"))
        .and_then(Value::as_array);
    let Some(packs) = packs else { return Ok(None) };
    let sum: u64 = packs
        .iter()
        .map(|pack| {
            let quota = pack
                .get("entitlement_base_info")
                .or_else(|| pack.get("entitlementBaseInfo"))
                .and_then(|e| e.get("quota"))
                .cloned()
                .unwrap_or(Value::Null);
            to_count(
                quota
                    .get("credits_limit")
                    .or_else(|| quota.get("creditsLimit"))
                    .unwrap_or(&Value::Null),
            )
        })
        .sum();
    Ok(Some(sum))
}
