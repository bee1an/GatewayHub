//! Small persisted preferences stored in `config.extra` — sidebar
//! provider visibility, UI language, and the playground API flavour.

use std::collections::HashSet;

use super::{Lang, PgApiType};

pub(crate) const SIDEBAR_HIDDEN_KEY: &str = "gpuiSidebarHiddenProviders";
pub(crate) const LANG_KEY: &str = "gpuiLang";
pub(crate) const PG_API_TYPE_KEY: &str = "gpuiPgApiType";

pub(crate) fn read_hidden_providers(config: &gateway_core::GatewayHubConfig) -> HashSet<String> {
    config
        .extra
        .get(SIDEBAR_HIDDEN_KEY)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

pub(crate) fn write_hidden_providers(
    config: &mut gateway_core::GatewayHubConfig,
    hidden: &HashSet<String>,
) {
    let mut names = hidden.iter().cloned().collect::<Vec<_>>();
    names.sort();
    config
        .extra
        .insert(SIDEBAR_HIDDEN_KEY.into(), serde_json::json!(names));
}

pub(crate) fn read_lang(config: &gateway_core::GatewayHubConfig) -> Lang {
    match config
        .extra
        .get(LANG_KEY)
        .and_then(serde_json::Value::as_str)
    {
        Some("en") => Lang::En,
        Some("zh") => Lang::Zh,
        _ => Lang::System,
    }
}

pub(crate) fn write_lang(config: &mut gateway_core::GatewayHubConfig, lang: Lang) {
    let value = match lang {
        Lang::En => "en",
        Lang::Zh => "zh",
        Lang::System => "system",
    };
    config
        .extra
        .insert(LANG_KEY.into(), serde_json::json!(value));
}

pub(crate) fn read_pg_api_type(config: &gateway_core::GatewayHubConfig) -> PgApiType {
    match config
        .extra
        .get(PG_API_TYPE_KEY)
        .and_then(serde_json::Value::as_str)
    {
        Some("anthropic") => PgApiType::Anthropic,
        Some("responses") => PgApiType::Responses,
        _ => PgApiType::OpenAi,
    }
}

pub(crate) fn write_pg_api_type(config: &mut gateway_core::GatewayHubConfig, api: PgApiType) {
    let value = match api {
        PgApiType::OpenAi => "openai",
        PgApiType::Anthropic => "anthropic",
        PgApiType::Responses => "responses",
    };
    config
        .extra
        .insert(PG_API_TYPE_KEY.into(), serde_json::json!(value));
}
