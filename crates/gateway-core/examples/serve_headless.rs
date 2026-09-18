// Headless gateway server for manual verification: `cargo run -p gateway-core --example serve_headless`
use gateway_core::{ConfigStore, GatewayService};

fn main() {
    let store = ConfigStore::detect().expect("no config store");
    let svc = GatewayService::new(store);
    svc.start_server().expect("start server");
    println!("listening; ctrl-c to stop");
    loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
    }
}
