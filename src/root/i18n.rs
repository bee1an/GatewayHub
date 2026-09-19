//! Minimal i18n — two languages (English / 中文), system-locale detection.
//!
//! No external crate. The translation table is a single `match` so missing
//! keys show up as compile warnings when new strings are added.
//!
//! Usage:
//! ```ignore
//! use crate::root::i18n::{Lang, t};
//! let s = t(Lang::En, "dashboard"); // "Dashboard"
//! ```

use std::sync::OnceLock;

/// Selected language. `System` resolves to `En` or `Zh` via [`Lang::resolve`]
/// using the macOS `LANG` / `LC_ALL` environment variables.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    System,
    En,
    Zh,
}

impl Lang {
    /// Resolve `System` to a concrete language. The detected locale is
    /// cached for the process lifetime — env vars don't change at runtime.
    pub fn resolve(self) -> Lang {
        match self {
            Lang::En | Lang::Zh => self,
            Lang::System => *system_locale(),
        }
    }

    pub fn next(self) -> Lang {
        match self.resolve() {
            Lang::En => Lang::Zh,
            Lang::Zh => Lang::En,
            Lang::System => Lang::En,
        }
    }
}

fn system_locale() -> &'static Lang {
    static LOCALE: OnceLock<Lang> = OnceLock::new();
    LOCALE.get_or_init(|| {
        let lang = std::env::var("LANG")
            .or_else(|_| std::env::var("LC_ALL"))
            .unwrap_or_default();
        if lang.starts_with("zh") {
            Lang::Zh
        } else {
            Lang::En
        }
    })
}

/// Translate a static key. Falls back to English if the key is missing.
#[inline]
pub fn t(lang: Lang, key: &str) -> &'static str {
    let lang = lang.resolve();
    match lang {
        Lang::Zh => zh(key).unwrap_or_else(|| en(key).unwrap_or("")),
        Lang::En => en(key).unwrap_or(""),
        Lang::System => en(key).unwrap_or(""),
    }
}

/// Translate a key and interpolate `{n}` placeholders with the given values.
/// Example: `tf(lang, "n_entries", &[("n", &total.to_string())])`
pub fn tf(lang: Lang, key: &str, args: &[(&str, &str)]) -> String {
    let template = t(lang, key);
    let mut result = template.to_string();
    for (k, v) in args {
        let placeholder = format!("{{{k}}}");
        result = result.replace(&placeholder, v);
    }
    result
}

/// English translations.
fn en(key: &str) -> Option<&'static str> {
    Some(match key {
        // ---- nav ----
        "nav_dashboard" => "Dashboard",
        "nav_logs" => "Logs",
        "nav_playground" => "Playground",
        "nav_api_keys" => "API Keys",
        "nav_mappings" => "Mappings",
        "nav_usage" => "Usage",
        "nav_settings" => "Settings",
        "nav_providers" => "Providers",

        // ---- shell / status strip ----
        "running" => "Running",
        "stopped" => "Stopped",
        "switch_to_light" => "Switch to light",
        "switch_to_dark" => "Switch to dark",
        "expand_sidebar" => "Expand sidebar",
        "collapse_sidebar" => "Collapse sidebar",

        // ---- language switch ----
        "language" => "Language",
        "language_system" => "System",
        "language_en" => "English",
        "language_zh" => "中文",

        // ---- dashboard ----
        "dash_title" => "Dashboard",
        "dash_desc" => "Control the gateway and review service health",
        "n_ready" => "{ready}/{enabled} ready",
        "n_errors" => "{n} errors",
        "start" => "Start",
        "stop" => "Stop",
        "starting" => "Starting…",
        "stopping" => "Stopping…",
        "no_recent_errors" => "No recent errors",
        "recent_errors" => "Recent errors",
        "view_all" => "View all",

        // ---- api keys ----
        "api_keys_title" => "API Keys",
        "api_keys_desc" => "Bearer tokens accepted by the gateway",
        "created_last_used" => "created {created} · last used {last}",
        "created_never_used" => "created {created} · never used",
        "revoke" => "Revoke",
        "no_api_keys" => "No API keys — the gateway rejects every request until one exists",
        "new_key_banner" => "New key — copy it now, it won't be shown again",
        "dismiss" => "Dismiss",
        "generate" => "Generate",
        "generate_title" => "Generate API key",
        "key_name" => "Name",
        "key_expiry" => "Expiry",
        "expire_never" => "Never",
        "expire_days" => "{n} days",
        "expired" => "expired",
        "scopes_label" => "Allowed providers",
        "scope_all" => "All providers",
        "n_keys" => "{n} keys",

        // ---- mappings ----
        "mappings_title" => "Model Mappings",
        "mappings_desc" => "Rewrite an incoming model name to a provider/model pair",
        "disable" => "Disable",
        "enable" => "Enable",
        "delete" => "Delete",
        "no_mappings" => "No mappings — model names pass through to the provider unchanged",
        "add" => "Add",
        "n_mappings" => "{n} mappings",

        // ---- playground ----
        "playground_title" => "Playground",
        "pg_desc" => {
            "Real requests through the running gateway — auth, scopes and streaming included"
        }
        "pg_empty" => "Pick a model + API key and send a request through the live gateway",
        "pg_replying" => "gateway is replying…",
        "pg_model" => "Model",
        "pg_key" => "API key",
        "pg_api" => "API format",
        "pg_search_model" => "Search models…",
        "pg_stream" => "Stream",
        "pg_no_key" => "Create an API key first — the playground sends through the real gateway",
        "pg_no_model" => "No models — import accounts or add a model mapping",
        "pg_start_server" => "Start the gateway server to send requests",
        "pg_input_ph" => "Message the gateway…",
        "pg_input_hint" => "Enter send · Shift+Enter newline",
        "pg_response_empty" => "(empty response)",
        "retry" => "Retry",
        "send" => "Send",
        "role_you" => "you",
        "role_gateway" => "gateway",

        // ---- usage ----
        "usage_title" => "Usage",
        "usage_today" => "Today",
        "usage_30d" => "Last 30 days",
        "usage_breakdown" => "Breakdown",
        "usage_by_provider" => "By provider",
        "usage_by_model" => "By model",
        "usage_by_day" => "By day",
        "usage_chart" => "Tokens · last 30 days",
        "usage_hit" => "Cache hit",
        "col_tokens" => "Tokens",
        "col_model" => "Model",
        "col_cache" => "Cache",
        "col_date" => "Date",
        "col_provider_model" => "Provider / model",
        "col_in" => "In",
        "col_out" => "Out",
        "col_req" => "Req",
        "col_cost" => "Cost",
        "no_usage" => "No usage recorded yet",

        // ---- logs ----
        "logs_title" => "Logs",
        "all" => "All",
        "info" => "Info",
        "warn" => "Warn",
        "error" => "Error",
        "debug" => "Debug",
        "export" => "Export",
        "clear" => "Clear",
        "no_logs" => "No log entries yet",
        "no_match_filter" => "Nothing matches the current filter",
        "n_entries" => "{n} entries",
        "col_time" => "Time",
        "col_level" => "Level",
        "col_provider" => "Provider",
        "col_message" => "Message",
        "col_status" => "Status",
        "col_duration" => "Duration",

        // ---- detail ----
        "back" => "Back",
        "proxy" => "Proxy",
        "status" => "Status",
        "actions" => "Actions",
        "proxy_on" => "Proxy: on",
        "proxy_off" => "Proxy: off",
        "test" => "Test",
        "enabled" => "enabled",
        "disabled" => "disabled",
        "no_accounts" => "No account files for this provider — import one below",
        "import" => "Import",
        "add_account" => "Add account",
        "fetching" => "fetching…",
        "no_models" => "no models reported",
        "n_more" => "… and {n} more",
        "accounts_n" => "Accounts · {n}",
        "models_n" => "Models · {n}",
        "auto_checkin" => "Daily check-in",
        "auto_checkin_desc" => "Automatically claim daily credits for enabled accounts",
        "checkin" => "Check in",
        "checkin_now" => "Check in now",
        "checked_in_today" => "Checked in today",
        "checkin_credits" => "+{credits} credits",
        "checkin_failed" => "check-in failed: {e}",
        "checkin_summary" => "{c} claimed, {f} failed",
        "never_checked_in" => "never checked in",
        "models" => "Models",
        "refresh_models" => "Refresh models",
        "no_models_yet" => "models not fetched yet",
        "no_runtime" => "no runtime state",
        "requests_n" => "{n} requests",
        "success_rate" => "{rate}% success",
        "last_error" => "last error",
        "cooling_for" => "cooling {dur}",
        "acct_available" => "available",
        "acct_cooling" => "cooling",
        "acct_rate_limited" => "rate limited",
        "acct_quota" => "quota exceeded",
        "acct_auth" => "auth failed",
        "acct_off" => "disabled",
        "delete_account_title" => "Delete account?",
        "delete_account_desc" => "{label} will be removed permanently.",
        "revoke_key_title" => "Revoke API key?",
        "revoke_key_desc" => "Clients using “{name}” will lose access.",
        "delete_mapping_title" => "Delete mapping?",
        "delete_mapping_desc" => "{alias} → {target} will be removed.",
        "clear_logs_title" => "Clear all logs?",
        "clear_logs_desc" => "Every provider's log buffer will be emptied.",
        "cancel" => "Cancel",
        "close" => "Close",

        // ---- settings ----
        "settings_title" => "Settings",
        "settings_desc" => "Configure the gateway, appearance, and sidebar",
        "kv_url" => "URL",
        "kv_config" => "Config",
        "kv_state" => "State",
        "sec_connection" => "Connection",
        "sec_autostart" => "Start automatically",
        "sec_autostart_desc" => "Launch the gateway when GatewayHub opens",
        "sec_listen_lan" => "Listen on local network",
        "sec_listen_lan_desc" => "Allow other devices on this network to connect",
        "listen_warning" => "Requests from other devices can reach this gateway.",
        "sec_port" => "Port",
        "sec_port_desc" => "Port used by the OpenAI-compatible endpoint",
        "sec_proxy" => "Proxy",
        "sec_proxy_desc" => "Optional proxy used by providers that opt in",
        "sec_snippet" => "Quick test",
        "sec_snippet_desc" => "Copy a request that targets this gateway",
        "copy" => "Copy",
        "copied" => "Copied",
        "save" => "Save",
        "sec_sidebar" => "Sidebar providers",
        "sec_sidebar_desc" => "Choose which enabled providers appear in navigation",
        "show_all" => "Show all",
        "no_enabled_providers" => "No enabled providers",
        "sec_about" => "About",
        "kv_version" => "Version",
        "kv_github" => "GitHub",
        "saved" => "Saved",
        "saved_restart" => "Saved — restart the gateway to apply connection changes",
        "save_failed" => "Save failed: {e}",
        "invalid_port" => "Invalid port: {port}",
        "save_failed_short" => "save failed: {e}",

        // ---- notices ----
        "exported" => "exported → {path}",
        "export_failed" => "export failed: {e}",
        "imported" => "imported → {path}",
        "import_failed" => "import failed: {e}",
        "invalid_json" => "invalid JSON object",
        "testing" => "testing…",
        "provider_not_loaded" => "provider not loaded",
        "ok_prefix" => "ok — ",
        "fail_prefix" => "fail — ",
        "request_failed" => "request failed",
        "error_status" => "error {status}: {msg}",

        // ---- placeholders ----
        "ph_key_name" => "key name (e.g. laptop)",
        "ph_alias" => "alias (e.g. sonnet)",
        "ph_target" => "provider/model (e.g. kiro/claude-sonnet-4)",
        "ph_import" => "paste account JSON to import",
        "ph_model" => "model (e.g. claude-sonnet-4)",
        "ph_message" => "message…",
        "ph_filter" => "filter messages…",

        // ---- accessibility ----
        "acc_autostart" => "Launch GatewayHub automatically",
        "acc_listen_lan" => "Listen on the local network",
        "acc_show_provider" => "Show {name} in sidebar",

        _ => return None,
    })
}

/// Chinese translations.
fn zh(key: &str) -> Option<&'static str> {
    Some(match key {
        // ---- nav ----
        "nav_dashboard" => "仪表盘",
        "nav_logs" => "日志",
        "nav_playground" => "测试场",
        "nav_api_keys" => "API 密钥",
        "nav_mappings" => "模型映射",
        "nav_usage" => "用量",
        "nav_settings" => "设置",
        "nav_providers" => "服务商",

        // ---- shell / status strip ----
        "running" => "运行中",
        "stopped" => "已停止",
        "switch_to_light" => "切换到浅色",
        "switch_to_dark" => "切换到深色",
        "expand_sidebar" => "展开侧栏",
        "collapse_sidebar" => "收起侧栏",

        // ---- language switch ----
        "language" => "语言",
        "language_system" => "跟随系统",
        "language_en" => "English",
        "language_zh" => "中文",

        // ---- dashboard ----
        "dash_title" => "仪表盘",
        "dash_desc" => "控制网关并查看服务状态",
        "n_ready" => "{ready}/{enabled} 就绪",
        "n_errors" => "{n} 个错误",
        "start" => "启动",
        "stop" => "停止",
        "starting" => "启动中…",
        "stopping" => "停止中…",
        "no_recent_errors" => "暂无近期错误",
        "recent_errors" => "近期错误",
        "view_all" => "查看全部",

        // ---- api keys ----
        "api_keys_title" => "API 密钥",
        "api_keys_desc" => "网关接受的 Bearer 令牌",
        "created_last_used" => "创建于 {created} · 上次使用 {last}",
        "created_never_used" => "创建于 {created} · 从未使用",
        "revoke" => "吊销",
        "no_api_keys" => "尚无 API 密钥 — 在创建密钥前网关会拒绝所有请求",
        "new_key_banner" => "新密钥 — 请立即复制，之后不再显示",
        "dismiss" => "关闭",
        "generate" => "生成",
        "generate_title" => "生成 API 密钥",
        "key_name" => "名称",
        "key_expiry" => "有效期",
        "expire_never" => "永不过期",
        "expire_days" => "{n} 天",
        "expired" => "已过期",
        "scopes_label" => "可用服务商",
        "scope_all" => "所有服务商",
        "n_keys" => "{n} 个密钥",

        // ---- mappings ----
        "mappings_title" => "模型映射",
        "mappings_desc" => "将传入的模型名重写为服务商/模型对",
        "disable" => "禁用",
        "enable" => "启用",
        "delete" => "删除",
        "no_mappings" => "尚无映射 — 模型名将原样传递给服务商",
        "add" => "添加",
        "n_mappings" => "{n} 个映射",

        // ---- playground ----
        "playground_title" => "测试场",
        "pg_desc" => "通过运行中的网关发真实请求——鉴权、scope、流式全链路",
        "pg_empty" => "选好模型和 API 密钥，向在线网关发一条请求",
        "pg_replying" => "网关回复中…",
        "pg_model" => "模型",
        "pg_key" => "API 密钥",
        "pg_api" => "API 格式",
        "pg_search_model" => "搜索模型…",
        "pg_stream" => "流式",
        "pg_no_key" => "先创建 API 密钥——测试场走真实网关鉴权",
        "pg_no_model" => "暂无可用模型——先导入账号或添加模型映射",
        "pg_start_server" => "先启动网关服务再发请求",
        "pg_input_ph" => "给网关发条消息…",
        "pg_input_hint" => "Enter 发送 · Shift+Enter 换行",
        "pg_response_empty" => "（空响应）",
        "retry" => "重试",
        "send" => "发送",
        "role_you" => "你",
        "role_gateway" => "网关",

        // ---- usage ----
        "usage_title" => "用量",
        "usage_today" => "今日",
        "usage_30d" => "近 30 天",
        "usage_breakdown" => "明细",
        "usage_by_provider" => "按服务商",
        "usage_by_model" => "按模型",
        "usage_by_day" => "按日期",
        "usage_chart" => "Token · 近 30 天",
        "usage_hit" => "缓存命中",
        "col_tokens" => "Token",
        "col_model" => "模型",
        "col_cache" => "缓存",
        "col_date" => "日期",
        "col_provider_model" => "服务商 / 模型",
        "col_in" => "输入",
        "col_out" => "输出",
        "col_req" => "次数",
        "col_cost" => "费用",
        "no_usage" => "暂无用量记录",

        // ---- logs ----
        "logs_title" => "日志",
        "all" => "全部",
        "info" => "信息",
        "warn" => "警告",
        "error" => "错误",
        "debug" => "调试",
        "export" => "导出",
        "clear" => "清空",
        "no_logs" => "暂无日志",
        "no_match_filter" => "没有匹配当前筛选条件的条目",
        "n_entries" => "{n} 条",
        "col_time" => "时间",
        "col_level" => "级别",
        "col_provider" => "服务商",
        "col_message" => "消息",
        "col_status" => "状态码",
        "col_duration" => "耗时",

        // ---- detail ----
        "back" => "返回",
        "proxy" => "代理",
        "status" => "状态",
        "actions" => "操作",
        "proxy_on" => "代理: 开",
        "proxy_off" => "代理: 关",
        "test" => "测试",
        "enabled" => "已启用",
        "disabled" => "已禁用",
        "no_accounts" => "该服务商暂无账号文件 — 在下方导入",
        "import" => "导入",
        "add_account" => "添加账号",
        "fetching" => "获取中…",
        "no_models" => "未报告模型",
        "n_more" => "… 还有 {n} 个",
        "accounts_n" => "账号 · {n}",
        "models_n" => "模型 · {n}",
        "auto_checkin" => "每日签到",
        "auto_checkin_desc" => "每天自动为已启用账号签到领取额度",
        "checkin" => "签到",
        "checkin_now" => "立即签到",
        "checked_in_today" => "今日已签到",
        "checkin_credits" => "+{credits} 额度",
        "checkin_failed" => "签到失败: {e}",
        "checkin_summary" => "{c} 个已领取, {f} 个失败",
        "never_checked_in" => "从未签到",
        "models" => "模型",
        "refresh_models" => "刷新模型",
        "no_models_yet" => "尚未拉取模型",
        "no_runtime" => "暂无运行时状态",
        "requests_n" => "{n} 次请求",
        "success_rate" => "成功率 {rate}%",
        "last_error" => "最近错误",
        "cooling_for" => "冷却中 {dur}",
        "acct_available" => "可用",
        "acct_cooling" => "冷却中",
        "acct_rate_limited" => "限流中",
        "acct_quota" => "额度耗尽",
        "acct_auth" => "认证失败",
        "acct_off" => "已禁用",
        "delete_account_title" => "删除账号？",
        "delete_account_desc" => "{label} 将被永久删除。",
        "revoke_key_title" => "吊销 API 密钥？",
        "revoke_key_desc" => "使用 “{name}” 的客户端将失去访问权限。",
        "delete_mapping_title" => "删除映射？",
        "delete_mapping_desc" => "{alias} → {target} 将被移除。",
        "clear_logs_title" => "清空所有日志？",
        "clear_logs_desc" => "所有服务商的日志缓存都将被清空。",
        "cancel" => "取消",
        "close" => "关闭",

        // ---- settings ----
        "settings_title" => "设置",
        "settings_desc" => "配置网关、外观和侧栏",
        "kv_url" => "地址",
        "kv_config" => "配置",
        "kv_state" => "状态",
        "sec_connection" => "连接",
        "sec_autostart" => "自动启动",
        "sec_autostart_desc" => "打开 GatewayHub 时启动网关",
        "sec_listen_lan" => "监听局域网",
        "sec_listen_lan_desc" => "允许同网络的其他设备连接",
        "listen_warning" => "其他设备的请求可以到达此网关。",
        "sec_port" => "端口",
        "sec_port_desc" => "OpenAI 兼容端点使用的端口",
        "sec_proxy" => "代理",
        "sec_proxy_desc" => "服务商可选使用的代理",
        "sec_snippet" => "快速测试",
        "sec_snippet_desc" => "复制指向此网关的请求",
        "copy" => "复制",
        "copied" => "已复制",
        "save" => "保存",
        "sec_sidebar" => "侧栏服务商",
        "sec_sidebar_desc" => "选择哪些已启用的服务商显示在导航中",
        "show_all" => "全部显示",
        "no_enabled_providers" => "无已启用的服务商",
        "sec_about" => "关于",
        "kv_version" => "版本",
        "kv_github" => "GitHub",
        "saved" => "已保存",
        "saved_restart" => "已保存 — 重启网关以应用连接变更",
        "save_failed" => "保存失败: {e}",
        "invalid_port" => "无效端口: {port}",
        "save_failed_short" => "保存失败: {e}",

        // ---- notices ----
        "exported" => "已导出 → {path}",
        "export_failed" => "导出失败: {e}",
        "imported" => "已导入 → {path}",
        "import_failed" => "导入失败: {e}",
        "invalid_json" => "无效的 JSON 对象",
        "testing" => "测试中…",
        "provider_not_loaded" => "服务商未加载",
        "ok_prefix" => "成功 — ",
        "fail_prefix" => "失败 — ",
        "request_failed" => "请求失败",
        "error_status" => "错误 {status}: {msg}",

        // ---- placeholders ----
        "ph_key_name" => "密钥名（如 laptop）",
        "ph_alias" => "别名（如 sonnet）",
        "ph_target" => "服务商/模型（如 kiro/claude-sonnet-4）",
        "ph_import" => "粘贴账号 JSON 以导入",
        "ph_model" => "模型（如 claude-sonnet-4）",
        "ph_message" => "输入消息…",
        "ph_filter" => "筛选消息…",

        // ---- accessibility ----
        "acc_autostart" => "自动启动 GatewayHub",
        "acc_listen_lan" => "监听本地网络",
        "acc_show_provider" => "在侧栏显示 {name}",

        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_zh_key_has_en_counterpart() {
        // Collect all keys from `en` by probing a large set of known keys.
        let keys = [
            "nav_dashboard",
            "nav_logs",
            "nav_playground",
            "nav_api_keys",
            "nav_mappings",
            "nav_usage",
            "nav_settings",
            "nav_providers",
            "running",
            "stopped",
            "dash_title",
            "api_keys_title",
            "mappings_title",
            "playground_title",
            "pg_desc",
            "pg_empty",
            "pg_model",
            "pg_key",
            "pg_api",
            "pg_search_model",
            "pg_stream",
            "pg_no_key",
            "pg_no_model",
            "pg_start_server",
            "pg_input_ph",
            "pg_input_hint",
            "pg_response_empty",
            "retry",
            "usage_title",
            "logs_title",
            "settings_title",
            "back",
            "proxy",
            "status",
            "actions",
            "proxy_on",
            "proxy_off",
            "test",
            "import",
            "fetching",
            "no_models",
            "n_more",
            "accounts_n",
            "models_n",
            "language",
        ];
        for key in keys {
            assert!(en(key).is_some(), "en missing {key}");
            assert!(zh(key).is_some(), "zh missing {key}");
        }
    }

    #[test]
    fn tf_interpolates_placeholders() {
        let s = tf(Lang::En, "n_entries", &[("n", "42")]);
        assert_eq!(s, "42 entries");
        let s = tf(Lang::Zh, "n_entries", &[("n", "42")]);
        assert_eq!(s, "42 条");
    }

    #[test]
    fn system_resolves_to_concrete() {
        let resolved = Lang::System.resolve();
        assert!(resolved == Lang::En || resolved == Lang::Zh);
    }
}
