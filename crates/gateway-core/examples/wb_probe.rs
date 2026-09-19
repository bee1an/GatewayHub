//! Probe the real WorkBuddy credits path — same code as the sweep uses.
use gateway_core::providers::workbuddy_checkin;
use gateway_core::types::AccountFile;

#[tokio::main]
async fn main() {
    let dir = std::path::PathBuf::from(
        "/Users/bee/.config/gatewayhub/workbuddy/accounts",
    );
    let path = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok().map(|e| e.path()))
        .find(|p| p.extension().is_some_and(|e| e == "json"))
        .unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    let account: AccountFile = serde_json::from_str(&text).unwrap();
    let token = account
        .fields
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap()
        .to_string();
    let client = reqwest::Client::new();
    let hosts = vec![
        "www.workbuddy.cn".to_string(),
        "www.codebuddy.cn".to_string(),
    ];
    match workbuddy_checkin::get_credits_usage(
        &client,
        &account,
        &token,
        "https://copilot.tencent.com",
        &hosts,
    )
    .await
    {
        Ok(v) => println!("credits: {v:?}"),
        Err(e) => println!("ERR: {e}"),
    }
}
