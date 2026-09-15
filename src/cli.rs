//! CLI entry: `gatewayhub <subcommand>` runs headless; no args = GPUI app.
//! The gateway server itself is also exposed via `serve` for launchd /
//! terminal use without the window.

use std::sync::Arc;

use gateway_core::{ConfigStore, GatewayPaths, GatewayService};

const USAGE: &str = "GatewayHub — local multi-provider AI gateway

USAGE:
    gatewayhub                 launch the desktop app
    gatewayhub serve           run the HTTP gateway in the foreground
    gatewayhub status          print provider/account status
    gatewayhub models          list configured models
    gatewayhub test <provider> <account-id>   run provider test_account
    gatewayhub checkin <provider> [account-id]  run daily check-in

Config: ~/.config/gatewayhub/gatewayhub.config.json";

fn service() -> Arc<GatewayService> {
    let svc = GatewayService::detect().unwrap_or_else(|| {
        eprintln!("warning: no config dir found, using a temp dir");
        let tmp = std::env::temp_dir().join("gatewayhub-cli");
        GatewayService::new(ConfigStore::new(GatewayPaths::new(tmp)))
    });
    Arc::new(svc)
}

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("cli runtime")
}

fn cmd_status(svc: &GatewayService) -> i32 {
    let snap = svc.status();
    println!(
        "server: {} {}",
        if snap.server.running {
            "running"
        } else {
            "stopped"
        },
        snap.server.url
    );
    for p in &snap.providers {
        println!(
            "{:<12} {:<9} enabled={:<5} accounts={} models={} {}",
            p.name,
            p.status,
            p.enabled,
            p.accounts,
            p.models.len(),
            p.message.clone().unwrap_or_default()
        );
    }
    0
}

fn cmd_models(svc: &GatewayService, rt: &tokio::runtime::Runtime) -> i32 {
    let registry = svc.registry();
    let models = rt.block_on(registry.list_models());
    if models.is_empty() {
        println!("no models — enable a provider or add a mapping");
        return 0;
    }
    for m in models {
        println!("{}", m.id);
    }
    0
}

fn cmd_test(svc: &GatewayService, rt: &tokio::runtime::Runtime, args: &[String]) -> i32 {
    let (Some(provider), Some(account_id)) = (args.get(2), args.get(3)) else {
        eprintln!("usage: gatewayhub test <provider> <account-id>");
        return 2;
    };
    let Some(adapter) = svc.registry().provider(provider) else {
        eprintln!("unknown provider: {provider}");
        return 2;
    };
    let result = rt.block_on(adapter.test_account(account_id));
    println!(
        "{} {}: {}",
        if result.ok { "ok" } else { "fail" },
        result.account_id,
        result.message
    );
    if result.ok { 0 } else { 1 }
}

fn cmd_checkin(svc: &GatewayService, rt: &tokio::runtime::Runtime, args: &[String]) -> i32 {
    let Some(provider) = args.get(2) else {
        eprintln!("usage: gatewayhub checkin <provider> [account-id]");
        return 2;
    };
    let Some(adapter) = svc.registry().provider(provider) else {
        eprintln!("unknown provider: {provider}");
        return 2;
    };
    match rt.block_on(adapter.checkin_accounts(args.get(3).map(String::as_str), true)) {
        Ok(v) => {
            println!("{}", serde_json::to_string_pretty(&v).unwrap_or_default());
            0
        }
        Err(e) => {
            eprintln!("checkin failed: {e}");
            1
        }
    }
}

fn cmd_serve(svc: &GatewayService, rt: tokio::runtime::Runtime) -> i32 {
    if let Err(e) = svc.start_server() {
        eprintln!("failed to start gateway server: {e}");
        return 1;
    }
    let snap = svc.status();
    println!("gateway listening on {}", snap.server.url);
    rt.block_on(async {
        let _ = tokio::signal::ctrl_c().await;
    });
    svc.stop_server();
    println!("stopped");
    0
}

/// Returns `Some(exit_code)` when argv[1] is a CLI subcommand; `None` means
/// launch the GUI.
pub fn maybe_run() -> Option<i32> {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1)?.as_str();
    match cmd {
        "serve" => {
            let svc = service();
            svc.maybe_autostart();
            Some(cmd_serve(&svc, runtime()))
        }
        "status" => Some(cmd_status(&service())),
        "models" => {
            let rt = runtime();
            Some(cmd_models(&service(), &rt))
        }
        "test" => {
            let rt = runtime();
            Some(cmd_test(&service(), &rt, &args))
        }
        "checkin" => {
            let rt = runtime();
            Some(cmd_checkin(&service(), &rt, &args))
        }
        "--help" | "-h" | "help" => {
            println!("{USAGE}");
            Some(0)
        }
        "--version" | "-V" => {
            println!("gatewayhub {}", env!("CARGO_PKG_VERSION"));
            Some(0)
        }
        _ => None,
    }
}
