//! GatewayHub Rust core — the domain layer ported from the Electron main
//! process: config/state stores (byte-compatible with `~/.config/gatewayhub`),
//! provider registry, API-key handling and the OpenAI/Anthropic-compatible
//! HTTP server.

pub mod apikey;
pub mod http;
pub mod paths;
pub mod pool;
pub mod protocol;
pub mod provider;
pub mod providers;
pub mod registry;
pub mod server;
pub mod service;
pub mod session;
pub mod store;
pub mod types;

pub use apikey::{generate_api_key, sha256_short};
pub use paths::GatewayPaths;
pub use registry::Registry;
pub use server::{GatewayServer, ServerState};
pub use service::GatewayService;
pub use store::ConfigStore;
pub use types::*;
