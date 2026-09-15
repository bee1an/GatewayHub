//! Shared upstream HTTP client — one `reqwest::Client` per provider,
//! optional global proxy (the `vpnProxyUrl` resolved by the registry).

use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

pub struct UpstreamHttp {
    client: reqwest::Client,
    pub base_url: String,
}

impl UpstreamHttp {
    pub fn new(base_url: impl Into<String>, proxy_url: Option<&str>) -> anyhow::Result<Self> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .tcp_nodelay(true);
        if let Some(url) = proxy_url.filter(|u| !u.is_empty()) {
            builder = builder.proxy(reqwest::Proxy::all(url)?);
        }
        Ok(Self {
            client: builder.build()?,
            base_url: base_url.into(),
        })
    }

    pub fn url(&self, path: &str) -> String {
        join_url(&self.base_url, path)
    }

    /// POST a JSON body. `timeout` wraps the whole request including body
    /// read — callers layer their own read timeouts on streamed responses.
    pub async fn post_json(
        &self,
        path: &str,
        body: &serde_json::Value,
        extra_headers: &[(&str, &str)],
        timeout: Duration,
    ) -> anyhow::Result<reqwest::Response> {
        let req = self
            .client
            .post(self.url(path))
            .headers(headers(extra_headers))
            .json(body)
            .timeout(timeout);
        Ok(req.send().await?)
    }

    /// POST a JSON body without a total-request timeout (streaming callers
    /// apply their own read timeouts instead).
    pub async fn post_json_stream(
        &self,
        path: &str,
        body: &serde_json::Value,
        extra_headers: &[(&str, &str)],
        connect_timeout: Duration,
    ) -> anyhow::Result<reqwest::Response> {
        let req = self
            .client
            .post(self.url(path))
            .headers(headers(extra_headers))
            .json(body)
            .timeout(connect_timeout);
        Ok(req.send().await?)
    }

    pub async fn get(
        &self,
        path: &str,
        extra_headers: &[(&str, &str)],
        timeout: Duration,
    ) -> anyhow::Result<reqwest::Response> {
        let req = self
            .client
            .get(self.url(path))
            .headers(headers(extra_headers))
            .timeout(timeout);
        Ok(req.send().await?)
    }
}

fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        if let (Ok(n), Ok(v)) = (
            name.parse::<HeaderName>(),
            value.parse::<HeaderValue>(),
        ) {
            map.insert(n, v);
        }
    }
    map
}

pub fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Body text with upstream secrets masked before logging (the TS
/// `redactNvidiaKey` family — token shapes share the same masking).
pub fn redact_secrets_in_text(text: &str) -> String {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r"(?i)(nvapi-[A-Za-z0-9._-]+|sk-[A-Za-z0-9._-]{8,}|Bearer\s+[A-Za-z0-9._-]+)",
        )
        .expect("redaction regex")
    });
    re.replace_all(text, |caps: &regex::Captures| {
        let m = &caps[0];
        if let Some(prefix) = m.strip_prefix("nvapi-") {
            let _ = prefix;
            "nvapi-***".to_string()
        } else if m.to_ascii_lowercase().starts_with("bearer") {
            "Bearer ***".to_string()
        } else {
            "sk-***".to_string()
        }
    })
    .into_owned()
}

pub fn now_ms() -> i64 {
    crate::pool::now_ms()
}
