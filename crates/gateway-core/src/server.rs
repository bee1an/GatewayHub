//! The OpenAI/Anthropic-compatible HTTP surface, on axum + a dedicated
//! tokio runtime thread. Ported semantics from the Electron `server.ts`:
//! API-key auth (constant-time, deny-all when no keys), loopback Host
//! header check, loopback-only CORS, 8 MiB body limit, per-key provider
//! scopes, and SSE passthrough.

use std::net::SocketAddr;
use std::sync::{Arc, RwLock};

use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing::info;

use crate::apikey::safe_equal;
use crate::registry::Registry;
use crate::responses_api;
use crate::session::derive_gateway_session;
use crate::types::{
    ApiFormat, ApiKeyEntry, GatewayRequestContext, GatewayResponse, GatewayServerConfig,
    ModelMapping,
};

pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
pub struct ServerState {
    pub config: Arc<RwLock<GatewayServerConfig>>,
    /// Live view of enabled model mappings for `/v1/models`.
    pub models: Arc<RwLock<Vec<ModelMapping>>>,
    pub registry: Arc<Registry>,
    pub usage: Arc<crate::usage_store::UsageStore>,
}

pub struct GatewayServer {
    shutdown: Option<oneshot::Sender<()>>,
    addr: SocketAddr,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl GatewayServer {
    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    /// Bind on the calling thread's behalf, then serve on a dedicated
    /// `tokio` runtime thread. Returns once the socket is listening so
    /// callers learn about EADDRINUSE immediately.
    pub fn start(state: ServerState) -> anyhow::Result<Self> {
        let (host, port) = {
            let cfg = state
                .config
                .read()
                .map_err(|_| anyhow::anyhow!("config lock"))?;
            (cfg.host.clone(), cfg.port)
        };
        let std_listener = std::net::TcpListener::bind((host.as_str(), port))?;
        std_listener.set_nonblocking(true)?;
        let addr = std_listener.local_addr()?;

        let (tx, rx) = oneshot::channel::<()>();
        let thread_state = state.clone();
        let thread = std::thread::Builder::new()
            .name("gateway-server".into())
            .spawn(move || {
                let rt = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build();
                let Ok(rt) = rt else {
                    tracing::error!("failed to build gateway runtime");
                    return;
                };
                rt.block_on(async move {
                    let listener = tokio::net::TcpListener::from_std(std_listener)
                        .expect("listener already set nonblocking");
                    serve(listener, thread_state, rx).await;
                });
            })?;
        info!(%addr, "gateway server listening");
        Ok(Self {
            shutdown: Some(tx),
            addr,
            thread: Some(thread),
        })
    }

    pub fn stop(&mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for GatewayServer {
    fn drop(&mut self) {
        self.stop();
    }
}

async fn serve(
    listener: tokio::net::TcpListener,
    state: ServerState,
    shutdown: oneshot::Receiver<()>,
) {
    let app = axum::Router::new()
        .route("/health", get(health))
        .route("/", get(root_info))
        .route("/v1/models", get(list_models))
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/messages", post(messages))
        .route("/v1/messages/count_tokens", post(count_tokens))
        .route("/v1/responses", post(responses_compat))
        .route("/responses", post(responses_compat))
        .fallback(not_found)
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            guard_middleware,
        ))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state);

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = shutdown.await;
        })
        .await
    {
        tracing::error!(error = %e, "gateway server error");
    }
    info!("gateway server stopped");
}

/// Host-header + auth guard applied to every route. `/health` and `/`
/// stay unauthenticated like the Electron server; everything else needs a
/// valid key. The matched key is stashed in request extensions for scope
/// checks downstream.
async fn guard_middleware(
    State(state): State<ServerState>,
    mut req: axum::http::Request<Body>,
    next: axum::middleware::Next,
) -> Response {
    let path = req.uri().path().to_string();
    let method = req.method().clone();

    if method == Method::OPTIONS {
        return cors_preflight(&state, req.headers());
    }

    if !check_host_header(&state, req.headers()) {
        return json_error(
            StatusCode::MISDIRECTED_REQUEST,
            "Misdirected request: invalid Host header",
            "host_mismatch",
        );
    }

    let public = matches!(path.as_str(), "/health" | "/");
    if !public {
        match verify_api_key(&state, req.headers()) {
            Some(entry) => {
                req.extensions_mut().insert(entry);
            }
            None => {
                return json_error(
                    StatusCode::UNAUTHORIZED,
                    "Invalid or missing API key",
                    "authentication_error",
                );
            }
        }
    }

    // `next.run` consumes the request — keep headers for CORS echo.
    let req_headers = req.headers().clone();
    let mut resp = next.run(req).await;
    apply_cors(&state, &req_headers, resp.headers_mut());
    resp
}

fn check_host_header(state: &ServerState, headers: &HeaderMap) -> bool {
    let Ok(cfg) = state.config.read() else {
        return true;
    };
    if !is_loopback_host(&cfg.host) {
        return true;
    }
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if host.is_empty() {
        return true;
    }
    let host_only = host.split(':').next().unwrap_or("");
    matches!(host_only, "localhost" | "127.0.0.1" | "::1" | "[::1]")
        || host_only == cfg.host
        || host_only.ends_with(".localhost")
}

fn verify_api_key(state: &ServerState, headers: &HeaderMap) -> Option<ApiKeyEntry> {
    let cfg = state.config.read().ok()?;
    if cfg.api_keys.is_empty() {
        return None;
    }
    let bearer = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "));
    let xkey = headers.get("x-api-key").and_then(|v| v.to_str().ok());
    let provided = bearer.or(xkey).unwrap_or("");
    if provided.is_empty() {
        return None;
    }
    let now = now_ms();
    let mut matched: Option<ApiKeyEntry> = None;
    for entry in &cfg.api_keys {
        // Run every entry to avoid order-dependent timing.
        if safe_equal(&entry.key, provided) {
            if entry.expires_at.is_some_and(|exp| now > exp) {
                continue;
            }
            matched = Some(entry.clone());
        }
    }
    matched
}

/// `checkScope` port — per-key provider allowlist on the raw model string's
/// `provider/` prefix (alias names with no prefix pass through).
fn scope_denied(entry: &ApiKeyEntry, model: Option<&str>) -> Option<Response> {
    let scopes = entry.scopes.as_deref().unwrap_or(&[]);
    if scopes.is_empty() {
        return None;
    }
    let raw = model.unwrap_or("");
    let provider = match raw.find('/') {
        Some(i) if i > 0 => &raw[..i],
        _ => "",
    };
    if provider.is_empty() || scopes.iter().any(|s| s == provider) {
        return None;
    }
    Some(json_error(
        StatusCode::FORBIDDEN,
        format!(
            "API key \"{}\" does not have access to provider \"{provider}\"",
            entry.name
        ),
        "permission_error",
    ))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

fn is_allowed_origin(origin: &str) -> bool {
    origin.starts_with("http://localhost")
        || origin.starts_with("http://127.0.0.1")
        || origin.starts_with("http://[::1]")
        || origin.starts_with("file://")
        || origin.starts_with("app://")
        || origin.starts_with("vscode-webview://")
}

fn cors_preflight(state: &ServerState, headers: &HeaderMap) -> Response {
    let mut resp = StatusCode::NO_CONTENT.into_response();
    apply_cors(state, headers, resp.headers_mut());
    resp
}

fn apply_cors(state: &ServerState, req_headers: &HeaderMap, out: &mut HeaderMap) {
    let Ok(cfg) = state.config.read() else {
        return;
    };
    if !is_loopback_host(&cfg.host) {
        return;
    }
    let Some(origin) = req_headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .filter(|o| is_allowed_origin(o))
    else {
        return;
    };
    if let Ok(v) = HeaderValue::from_str(origin) {
        out.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, v);
        out.insert(header::VARY, HeaderValue::from_static("Origin"));
        out.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static(
                "authorization,x-api-key,anthropic-version,content-type,x-claude-session-id,x-session-id,x-conversation-id,x-thread-id,x-codex-session-id",
            ),
        );
        out.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,POST,OPTIONS"),
        );
    }
}

fn request_id() -> String {
    format!("req_{}", uuid::Uuid::new_v4().simple())
}

fn build_context(
    state: &ServerState,
    headers: &HeaderMap,
    body: &Value,
    key: &ApiKeyEntry,
    format: ApiFormat,
) -> GatewayRequestContext {
    let rid = request_id();
    let session = derive_gateway_session(headers, body, key, &rid, format);
    // `makeUsageSink` port — fire-and-forget record into the usage store.
    let usage_store = state.usage.clone();
    let api_format = format;
    let on_usage: crate::types::UsageSink = Arc::new(move |usage, meta| {
        let store = usage_store.clone();
        let input = crate::usage_store::UsageRecordInput {
            account_id: meta.account_id.clone(),
            model: meta.model.clone(),
            api_format: Some(
                match api_format {
                    ApiFormat::OpenAi => "openai",
                    ApiFormat::Anthropic => "anthropic",
                    ApiFormat::Responses => "responses",
                }
                .into(),
            ),
            provider: meta.provider.clone(),
            usage: usage.clone(),
            timestamp: None,
        };
        tokio::spawn(async move {
            if let Err(e) = store.record(input) {
                tracing::warn!(error = %e, "usage store record failed");
            }
        });
    });
    GatewayRequestContext {
        request_id: rid,
        session_id: Some(session.id),
        session_source: Some(session.source),
        api_format: format,
        on_usage: Some(on_usage),
        cancel: CancellationToken::new(),
    }
}

fn gateway_response(resp: GatewayResponse) -> Response {
    match resp {
        GatewayResponse::Json { status, body } => (status_code(status), Json(body)).into_response(),
        GatewayResponse::Sse { status, stream } => {
            let byte_stream = stream.map(|s| Ok::<Bytes, std::convert::Infallible>(Bytes::from(s)));
            Response::builder()
                .status(status_code(status))
                .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
                .header(header::CACHE_CONTROL, "no-cache, no-transform")
                .header(header::CONNECTION, "keep-alive")
                .body(Body::from_stream(byte_stream))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
    }
}

fn status_code(status: u16) -> StatusCode {
    StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

async fn health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn root_info(State(state): State<ServerState>) -> Json<Value> {
    let (host, port) = {
        let cfg = state
            .config
            .read()
            .map(|c| (c.host.clone(), c.port))
            .unwrap_or_default();
        (cfg.0, cfg.1)
    };
    Json(json!({
        "name": "GatewayHub",
        "version": env!("CARGO_PKG_VERSION"),
        "url": format!("http://{host}:{port}"),
        "endpoints": ["/v1/models", "/v1/chat/completions", "/v1/messages", "/v1/responses"],
    }))
}

async fn list_models(State(state): State<ServerState>) -> Json<Value> {
    let models = state.registry.list_models().await;
    let data: Vec<Value> = models
        .into_iter()
        .map(|m| {
            json!({
                "id": m.id,
                "object": "model",
                "created": 0,
                "owned_by": m.owned_by.unwrap_or_else(|| m.provider.clone()),
                "description": m.description,
            })
        })
        .collect();
    Json(json!({ "object": "list", "data": data }))
}

async fn chat_completions(
    State(state): State<ServerState>,
    axum::Extension(key): axum::Extension<ApiKeyEntry>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(deny) = scope_denied(&key, body.get("model").and_then(Value::as_str)) {
        return deny;
    }
    let ctx = build_context(&state, &headers, &body, &key, ApiFormat::OpenAi);
    gateway_response(state.registry.chat_completions(body, &ctx).await)
}

async fn messages(
    State(state): State<ServerState>,
    axum::Extension(key): axum::Extension<ApiKeyEntry>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(deny) = scope_denied(&key, body.get("model").and_then(Value::as_str)) {
        return deny;
    }
    let ctx = build_context(&state, &headers, &body, &key, ApiFormat::Anthropic);
    gateway_response(state.registry.messages(body, &ctx).await)
}

async fn count_tokens(
    State(state): State<ServerState>,
    axum::Extension(key): axum::Extension<ApiKeyEntry>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(deny) = scope_denied(&key, body.get("model").and_then(Value::as_str)) {
        return deny;
    }
    let ctx = build_context(&state, &headers, &body, &key, ApiFormat::Anthropic);
    gateway_response(state.registry.count_tokens(body, &ctx).await)
}

/// `/v1/responses` + `/responses` — the TS `toResponsesGatewayResponse`
/// flow: convert the request down to chat-completions, dispatch, wrap the
/// response (JSON or SSE) back up into Responses-API shape.
async fn responses_compat(
    State(state): State<ServerState>,
    axum::Extension(key): axum::Extension<ApiKeyEntry>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Some(deny) = scope_denied(&key, body.get("model").and_then(Value::as_str)) {
        return deny;
    }
    let chat_body = responses_api::responses_request_to_chat(&body);
    let ctx = build_context(&state, &headers, &chat_body, &key, ApiFormat::Responses);
    match state.registry.chat_completions(chat_body, &ctx).await {
        GatewayResponse::Sse { status, stream } => {
            if status >= 400 {
                return gateway_response(GatewayResponse::Sse { status, stream });
            }
            gateway_response(GatewayResponse::Sse {
                status,
                stream: Box::pin(responses_api::chat_sse_to_responses(stream, body)),
            })
        }
        GatewayResponse::Json {
            status,
            body: parsed,
        } => {
            if status >= 400 {
                return gateway_response(GatewayResponse::Json {
                    status,
                    body: parsed,
                });
            }
            gateway_response(GatewayResponse::Json {
                status,
                body: responses_api::chat_completion_to_responses(&parsed, &body),
            })
        }
    }
}

async fn not_found() -> Response {
    json_error(StatusCode::NOT_FOUND, "Not found", "not_found")
}

fn json_error(status: StatusCode, message: impl Into<String>, kind: &str) -> Response {
    (
        status,
        Json(json!({ "error": { "message": message.into(), "type": kind } })),
    )
        .into_response()
}

fn now_ms() -> i64 {
    crate::pool::now_ms()
}
