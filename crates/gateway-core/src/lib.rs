//! GatewayHub Rust core — the domain layer ported from the Electron main
//! process: config/state stores (byte-compatible with `~/.config/gatewayhub`),
//! provider registry, API-key handling and the OpenAI/Anthropic-compatible
//! HTTP server.

pub mod apikey;
pub mod paths;
pub mod provider;
pub mod server;
pub mod service;
pub mod store;
pub mod types;

pub use apikey::{generate_api_key, sha256_short};
pub use paths::GatewayPaths;
pub use server::{GatewayServer, ServerState};
pub use service::GatewayService;
pub use store::ConfigStore;
pub use types::*;
