//! Root view: translucent sidebar rail + distinct glass content pane —
//! the liquid-glass shell from the Electron layout, rebuilt on gpui-kit.
//!
//! Page bodies live in `root/pages/*` — `impl AppRoot` blocks only.

mod pages;

use std::collections::HashMap;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gateway_core::{
    AccountTestResult, ApiKeyEntry, GatewayService, GatewayStatusSnapshot, ModelMapping,
    ProviderStatus, generate_api_key,
};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Icon, StyledExt, Theme, ThemeMode, h_flex, input::InputState, label::Label, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

/// Content column width — the Electron layout centers `max-w-4xl` (896px)
/// inside the glass pane.
pub(crate) const PAGE_MAX_W: f32 = 896.;
/// Provider detail pages were `max-w-5xl` in the Electron layout.
pub(crate) const DETAIL_MAX_W: f32 = 1024.;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Page {
    Dashboard,
    ApiKeys,
    Mappings,
    Playground,
    Usage,
    Logs,
    Settings,
}

pub struct AppRoot {
    pub(crate) service: Arc<GatewayService>,
    pub(crate) page: Page,
    /// Provider detail view — set when a sidebar provider row is clicked.
    pub(crate) detail: Option<String>,
    /// None = follow the OS appearance (the "System" segment).
    pub(crate) mode_choice: Option<ThemeMode>,
    /// "provider/accountId" → last test outcome line.
    pub(crate) test_results: HashMap<String, String>,
    /// In-flight account tests; drained each render via try_recv.
    pub(crate) test_pending: HashMap<String, tokio::sync::oneshot::Receiver<AccountTestResult>>,
    /// provider → fetched model ids (lazy, fetched on detail open).
    pub(crate) detail_models: HashMap<String, Vec<String>>,
    pub(crate) models_pending: HashMap<String, tokio::sync::oneshot::Receiver<Vec<String>>>,
    /// API-key page: name for the next generated key.
    pub(crate) key_name_input: Entity<InputState>,
    /// Mapping page inputs.
    pub(crate) map_alias_input: Entity<InputState>,
    pub(crate) map_target_input: Entity<InputState>,
    /// Newly generated key shown once so it can be copied.
    pub(crate) new_key: Option<String>,
    /// Provider detail: paste-an-account-JSON import box + last result.
    pub(crate) import_input: Entity<InputState>,
    pub(crate) import_result: Option<String>,
    /// Playground: model + prompt inputs, transcript, in-flight reply.
    pub(crate) pg_model_input: Entity<InputState>,
    pub(crate) pg_msg_input: Entity<InputState>,
    pub(crate) pg_log: Vec<(SharedString, SharedString)>,
    pub(crate) pg_pending: Option<tokio::sync::oneshot::Receiver<String>>,
}

impl AppRoot {
    pub fn new(service: Arc<GatewayService>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Status poll — the Electron UI refetches every 5s; here we just
        // re-render since the service snapshot is a cheap in-process read.
        cx.spawn(async move |this, cx| {
            loop {
                smol::Timer::after(Duration::from_secs(5)).await;
                if this.update(cx, |_root, cx| cx.notify()).is_err() {
                    break;
                }
            }
        })
        .detach();
        Self {
            service,
            page: Page::Dashboard,
            detail: None,
            mode_choice: None,
            test_results: HashMap::new(),
            test_pending: HashMap::new(),
            detail_models: HashMap::new(),
            models_pending: HashMap::new(),
            key_name_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder("key name (e.g. laptop)")),
            map_alias_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder("alias (e.g. sonnet)")),
            map_target_input: cx.new(|cx| {
                InputState::new(_window, cx)
                    .placeholder("provider/model (e.g. kiro/claude-sonnet-4)")
            }),
            new_key: None,
            import_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder("paste account JSON to import")),
            import_result: None,
            pg_model_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder("model (e.g. claude-sonnet-4)")),
            pg_msg_input: cx.new(|cx| InputState::new(_window, cx).placeholder("message…")),
            pg_log: Vec::new(),
            pg_pending: None,
        }
    }

    pub(crate) fn toggle_server(&mut self, cx: &mut Context<Self>) {
        if self.service.server_running() {
            self.service.stop_server();
        } else if let Err(e) = self.service.start_server() {
            tracing::error!(error = %e, "failed to start gateway server");
        }
        cx.notify();
    }

    fn add_api_key(&mut self, cx: &mut Context<Self>) {
        let name = self.key_name_input.read(cx).value().trim().to_string();
        if name.is_empty() {
            return;
        }
        let key = generate_api_key();
        let mut cfg = self.service.config();
        cfg.server.api_keys.push(ApiKeyEntry {
            id: uuid::Uuid::new_v4().to_string(),
            key: key.clone(),
            name,
            created_at: gateway_core::pool::now_ms(),
            last_used_at: None,
            expires_at: None,
            scopes: None,
            extra: Default::default(),
        });
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.new_key = Some(key);
        cx.notify();
    }

    fn delete_api_key(&mut self, key_id: &str, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        cfg.server.api_keys.retain(|k| k.id != key_id);
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    fn add_mapping(&mut self, cx: &mut Context<Self>) {
        let alias = self.map_alias_input.read(cx).value().trim().to_string();
        let target = self.map_target_input.read(cx).value().trim().to_string();
        let Some((provider, model)) = target.split_once('/') else {
            return;
        };
        if alias.is_empty() || provider.is_empty() || model.is_empty() {
            return;
        }
        let mut cfg = self.service.config();
        cfg.model_mappings.push(ModelMapping {
            alias,
            provider: provider.to_string(),
            model: model.to_string(),
            enabled: true,
            note: None,
            extra: Default::default(),
        });
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    fn toggle_mapping(&mut self, ix: usize, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        if let Some(m) = cfg.model_mappings.get_mut(ix) {
            m.enabled = !m.enabled;
        }
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    fn delete_mapping(&mut self, ix: usize, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        if ix < cfg.model_mappings.len() {
            cfg.model_mappings.remove(ix);
        }
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    /// Provider-level enable / proxy toggles — config write + registry
    /// rebuild so the change takes effect for new requests.
    pub(crate) fn toggle_provider_flag(
        &mut self,
        provider: &str,
        flag: &'static str,
        cx: &mut Context<Self>,
    ) {
        let mut cfg = self.service.config();
        let entry = cfg
            .providers
            .entry(provider.to_string())
            .or_insert_with(|| serde_json::json!({}));
        let mut pcfg = gateway_core::ProviderConfig::from_value(&entry);
        match flag {
            "enabled" => pcfg.enabled = !pcfg.enabled,
            "useProxy" => pcfg.use_proxy = Some(!pcfg.use_proxy.unwrap_or(false)),
            _ => {}
        }
        *entry = serde_json::to_value(&pcfg).unwrap_or_default();
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.service.reload_registry();
        cx.notify();
    }

    fn toggle_account(&mut self, provider: &str, account_id: &str, cx: &mut Context<Self>) {
        let mut account = self
            .service
            .accounts(provider)
            .into_iter()
            .find(|a| a.id == account_id);
        if let Some(acc) = account.as_mut() {
            acc.enabled = !acc.enabled;
            if let Err(e) = self.service.store().write_account(provider, acc) {
                tracing::error!(error = %e, "write account failed");
            }
        }
        cx.notify();
    }

    fn delete_account(&mut self, provider: &str, account_id: &str, cx: &mut Context<Self>) {
        if let Err(e) = self.service.store().delete_account(provider, account_id) {
            tracing::error!(error = %e, "delete account failed");
        }
        cx.notify();
    }

    fn import_account(&mut self, provider: &str, window: &mut Window, cx: &mut Context<Self>) {
        let raw = self.import_input.read(cx).value().trim().to_string();
        if raw.is_empty() {
            return;
        }
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) if v.is_object() => {
                let mut account: gateway_core::AccountFile =
                    serde_json::from_value(v).unwrap_or_default();
                if account.id.is_empty() {
                    account.id = uuid::Uuid::new_v4().to_string();
                }
                if !raw.contains("\"enabled\"") {
                    account.enabled = true;
                }
                match self.service.store().write_account(provider, &account) {
                    Ok(path) => {
                        self.import_result = Some(format!("imported → {}", path.display()));
                        self.import_input.update(cx, |input, cx| {
                            input.set_value("", window, cx);
                        });
                    }
                    Err(e) => {
                        self.import_result = Some(format!("import failed: {e}"));
                    }
                }
            }
            _ => {
                self.import_result = Some("invalid JSON object".into());
            }
        }
        cx.notify();
    }

    /// Kick off provider.list_models when a detail page is opened
    /// (idempotent — pending tasks are not restarted).
    pub(crate) fn open_detail(&mut self, provider: &str) {
        self.detail = Some(provider.to_string());
        if !self.detail_models.contains_key(provider) && !self.models_pending.contains_key(provider)
        {
            let adapter = self.service.registry().provider(provider);
            let (tx, rx) = tokio::sync::oneshot::channel();
            self.service.spawn_ui(async move {
                let models = match adapter {
                    Some(a) => a.list_models().await.into_iter().map(|m| m.id).collect(),
                    None => Vec::new(),
                };
                let _ = tx.send(models);
            });
            self.models_pending.insert(provider.to_string(), rx);
        }
    }

    pub(crate) fn test_account(&mut self, provider: &str, account_id: &str) {
        let key = format!("{provider}/{account_id}");
        if self.test_pending.contains_key(&key) {
            return;
        }
        let Some(adapter) = self.service.registry().provider(provider) else {
            self.test_results.insert(key, "provider not loaded".into());
            return;
        };
        let account_id = account_id.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.service.spawn_ui(async move {
            let result = adapter.test_account(&account_id).await;
            let _ = tx.send(result);
        });
        self.test_results.insert(key.clone(), "testing…".into());
        self.test_pending.insert(key, rx);
    }

    /// Playground send — goes through the in-process registry (the same
    /// path the HTTP server uses) rather than HTTP, so it works whether
    /// or not the server is running.
    fn playground_send(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.pg_pending.is_some() {
            return;
        }
        let model = self.pg_model_input.read(cx).value().trim().to_string();
        let text = self.pg_msg_input.read(cx).value().trim().to_string();
        if model.is_empty() || text.is_empty() {
            return;
        }
        self.pg_log.push(("you".into(), text.clone().into()));
        self.pg_msg_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        let registry = self.service.registry();
        let body = serde_json::json!({
            "model": model,
            "messages": [{"role": "user", "content": text}],
            "stream": false,
        });
        let ctx = gateway_core::GatewayRequestContext {
            request_id: uuid::Uuid::new_v4().to_string(),
            session_id: None,
            session_source: None,
            api_format: gateway_core::ApiFormat::OpenAi,
            on_usage: None,
            cancel: tokio_util::sync::CancellationToken::new(),
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.service.spawn_ui(async move {
            use futures::StreamExt;
            let reply = match registry.chat_completions(body, &ctx).await {
                gateway_core::GatewayResponse::Json { status, body } => {
                    if status >= 400 {
                        let msg = body
                            .pointer("/error/message")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| body.to_string());
                        format!("error {status}: {msg}")
                    } else {
                        body.pointer("/choices/0/message/content")
                            .and_then(serde_json::Value::as_str)
                            .map(str::to_string)
                            .unwrap_or_else(|| body.to_string())
                    }
                }
                gateway_core::GatewayResponse::Sse { stream, .. } => {
                    let mut text = String::new();
                    futures::pin_mut!(stream);
                    while let Some(chunk) = stream.next().await {
                        for line in chunk.lines() {
                            if let Some(data) = line.strip_prefix("data: ")
                                && data != "[DONE]"
                                && let Ok(v) = serde_json::from_str::<serde_json::Value>(data)
                                && let Some(t) = v
                                    .pointer("/choices/0/delta/content")
                                    .and_then(serde_json::Value::as_str)
                            {
                                text.push_str(t);
                            }
                        }
                    }
                    text
                }
            };
            let _ = tx.send(reply);
        });
        self.pg_pending = Some(rx);
        cx.notify();
    }

    /// Drain completed test/model futures into their result maps.
    pub(crate) fn drain_pending(&mut self) {
        let mut done = Vec::new();
        for (key, rx) in &mut self.test_pending {
            match rx.try_recv() {
                Ok(result) => {
                    self.test_results.insert(
                        key.clone(),
                        format!(
                            "{}{}",
                            if result.ok { "ok — " } else { "fail — " },
                            result.message
                        ),
                    );
                    done.push(key.clone());
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                Err(_) => done.push(key.clone()),
            }
        }
        for key in done {
            self.test_pending.remove(&key);
        }
        let mut done = Vec::new();
        for (name, rx) in &mut self.models_pending {
            match rx.try_recv() {
                Ok(models) => {
                    self.detail_models.insert(name.clone(), models);
                    done.push(name.clone());
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                Err(_) => done.push(name.clone()),
            }
        }
        for name in done {
            self.models_pending.remove(&name);
        }
        if let Some(rx) = &mut self.pg_pending {
            match rx.try_recv() {
                Ok(reply) => {
                    self.pg_log.push(("gateway".into(), reply.into()));
                    self.pg_pending = None;
                }
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
                Err(_) => {
                    self.pg_log
                        .push(("gateway".into(), "request failed".into()));
                    self.pg_pending = None;
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// shared chrome — used by the shell and the page bodies
// ---------------------------------------------------------------------------

pub(crate) fn provider_icon(provider: &str) -> Option<&'static str> {
    Some(match provider {
        "trae" | "traework" => "providers/trae-icon.png",
        "workbuddy" => "providers/workbuddy-icon.png",
        "openrouter" => "providers/openrouter-icon.png",
        "nvidia" => "providers/nvidia-icon.png",
        "grokWeb" => "providers/grok-icon.png",
        "qoder" => "providers/qoder-icon.png",
        "gemini" | "geminiWeb" => "providers/gemini-icon.svg",
        "windsurf" => "providers/windsurf-icon.svg",
        "kiro" => "providers/kiro-icon.svg",
        "codex" => "providers/codex-icon-dark.svg",
        _ => return None,
    })
}

pub(crate) fn status_label(p: &ProviderStatus) -> &'static str {
    match p.status {
        "ready" => "ready",
        "placeholder" => "soon",
        "error" => "error",
        _ => "off",
    }
}

/// `PageHeader` — title + description, same shape as the Electron component.
pub(crate) fn page_header(title: &str, desc: &str, cx: &App) -> impl IntoElement {
    let theme = cx.theme().clone();
    v_flex()
        .gap_0p5()
        .pt_5()
        .pb_4()
        .child(
            Label::new(title.to_string())
                .text_lg()
                .font_semibold()
                .text_color(theme.foreground),
        )
        .child(
            Label::new(desc.to_string())
                .text_xs()
                .text_color(theme.muted_foreground),
        )
}

/// Card row chrome shared by account/key/mapping lists.
pub(crate) fn list_row(cx: &App) -> gpui_kit::Div {
    let theme = cx.theme().clone();
    h_flex()
        .items_center()
        .gap_3()
        .p_3()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.muted.opacity(0.35))
}

/// Segmented control (Light / Dark / System) — the NSSegmentedControl idiom,
/// same shape as Heimdall's `chrome::segmented`.
fn segmented(
    id_prefix: &str,
    items: Vec<SharedString>,
    selected: usize,
    on_pick: impl Fn(usize, &mut Window, &mut App) + 'static,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme().clone();
    let on_pick = Rc::new(on_pick);
    let mut track = h_flex()
        .p_0p5()
        .gap_0p5()
        .rounded(theme.radius)
        .bg(theme.accent);
    for (ix, label) in items.into_iter().enumerate() {
        let sel = ix == selected;
        let on_pick = on_pick.clone();
        track = track.child(
            div()
                .id(SharedString::from(format!("{id_prefix}-{ix}")))
                .px_3()
                .h_6()
                .flex()
                .items_center()
                .justify_center()
                .rounded(theme.radius)
                .when(sel, |d| d.bg(theme.button_primary).shadow_sm())
                .when(!sel, |d| {
                    d.cursor_pointer().hover(|d| d.bg(theme.list_hover))
                })
                .on_click(move |_, window, cx| on_pick(ix, window, cx))
                .child(Label::new(label).text_xs().when(sel, |l| {
                    l.font_medium().text_color(theme.button_primary_foreground)
                })),
        );
    }
    track
}

/// Sidebar nav item — 40px icon lane + 12px label, brass-tint active state,
/// matching the Electron `navItemClass` (rounded-md, border on active only).
fn nav_item(
    id: &'static str,
    icon: IconName,
    label: &'static str,
    active: bool,
    cx: &App,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let theme = cx.theme().clone();
    div()
        .id(id)
        .py_1p5()
        .px_2()
        .flex()
        .items_center()
        .gap_2()
        .rounded(theme.radius)
        .cursor_pointer()
        .border_1()
        .when(active, |d| {
            d.bg(theme.list_active)
                .border_color(theme.list_active_border)
        })
        .when(!active, |d| {
            d.border_color(gpui::transparent_black())
                .hover(|d| d.bg(theme.list_hover))
        })
        .child(div().w(px(40.)).flex_none().flex().justify_center().child(
            Icon::new(icon).size(px(15.)).text_color(if active {
                theme.foreground
            } else {
                theme.muted_foreground
            }),
        ))
        .child(
            Label::new(label)
                .text_xs()
                .when(active, |l| l.font_medium())
                .text_color(if active {
                    theme.foreground
                } else {
                    theme.muted_foreground
                }),
        )
}

/// Sidebar provider row — logo in the same 40px lane; unconfigured accounts
/// dim to 45% like the Electron `opacity-45` rule.
fn provider_nav_item(
    p: &ProviderStatus,
    active: bool,
    cx: &App,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let theme = cx.theme().clone();
    let row = div()
        .id(SharedString::from(format!("nav-p-{}", p.name)))
        .py_1p5()
        .px_2()
        .flex()
        .items_center()
        .gap_2()
        .rounded(theme.radius)
        .cursor_pointer()
        .border_1()
        .when(active, |d| {
            d.bg(theme.list_active)
                .border_color(theme.list_active_border)
        })
        .when(!active, |d| {
            d.border_color(gpui::transparent_black())
                .hover(|d| d.bg(theme.list_hover))
        });
    let mut icon_lane = div().w(px(40.)).flex_none().flex().justify_center();
    if let Some(src) = provider_icon(&p.provider_type) {
        icon_lane = icon_lane.child(
            img(src)
                .size_4()
                .rounded_sm()
                .when(!p.configured, |i| i.opacity(0.45)),
        );
    }
    row.child(icon_lane).child(
        Label::new(p.display_name.clone().unwrap_or_else(|| p.name.clone()))
            .text_xs()
            .when(active, |l| l.font_medium())
            .text_color(if active {
                theme.foreground
            } else {
                theme.muted_foreground
            }),
    )
}

impl Render for AppRoot {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().clone();
        let snapshot: GatewayStatusSnapshot = self.service.status();
        let running = snapshot.server.running;
        let ready = snapshot
            .providers
            .iter()
            .filter(|p| p.enabled && p.status == "ready")
            .count();
        let errors = snapshot
            .logs
            .iter()
            .filter(|l| l.level == gateway_core::LogLevel::Error)
            .count();

        // ---- sidebar: 148px rail, mark centered in the 72px lane ----
        let mut nav = v_flex().gap_px().px_2();
        for (page, id, icon, label) in [
            (
                Page::Dashboard,
                "nav-dashboard",
                IconName::LayoutDashboard,
                "Dashboard",
            ),
            (Page::ApiKeys, "nav-apikeys", IconName::Key, "API Keys"),
            (
                Page::Mappings,
                "nav-mappings",
                IconName::ArrowLeftRight,
                "Mappings",
            ),
            (
                Page::Playground,
                "nav-playground",
                IconName::MessageCircle,
                "Playground",
            ),
            (Page::Usage, "nav-usage", IconName::ChartPie, "Usage"),
            (Page::Logs, "nav-logs", IconName::List, "Logs"),
            (
                Page::Settings,
                "nav-settings",
                IconName::Settings,
                "Settings",
            ),
        ] {
            let active = self.detail.is_none() && self.page == page;
            nav = nav.child(nav_item(id, icon, label, active, cx).on_click(cx.listener(
                move |this, _, _w, cx| {
                    this.page = page;
                    this.detail = None;
                    cx.notify();
                },
            )));
        }

        let mut providers = v_flex().gap_px().px_2();
        for p in snapshot
            .providers
            .iter()
            .filter(|p| p.enabled || p.status != "disabled")
        {
            if p.status == "placeholder" {
                continue;
            }
            let active = self.detail.as_deref() == Some(p.name.as_str());
            let name = p.name.clone();
            providers = providers.child(provider_nav_item(p, active, cx).on_click(cx.listener(
                move |this, _, _w, cx| {
                    this.open_detail(&name);
                    cx.notify();
                },
            )));
        }

        let sel_ix = match self.mode_choice {
            Some(ThemeMode::Light) => 0,
            Some(ThemeMode::Dark) => 1,
            None => 2,
        };
        let me = cx.entity();
        let theme_seg = segmented(
            "theme-mode",
            vec!["Light".into(), "Dark".into(), "System".into()],
            sel_ix,
            move |ix, _w, cx| {
                me.update(cx, |root, cx| {
                    root.mode_choice = match ix {
                        0 => Some(ThemeMode::Light),
                        1 => Some(ThemeMode::Dark),
                        _ => None,
                    };
                    let mode = root.mode_choice.unwrap_or_else(|| {
                        crate::theme::theme_mode_for_appearance(cx.window_appearance())
                    });
                    Theme::change(mode, None, cx);
                });
            },
            cx,
        );

        let sidebar = v_flex()
            .w(px(148.))
            .h_full()
            .child(
                // 64px header keeps the mark below the traffic lights,
                // anchored to the 72px rail center like the Electron rail.
                div().h(px(64.)).flex().items_end().pb_2().child(
                    div()
                        .w(px(72.))
                        .flex()
                        .justify_center()
                        .child(img("gatewayhub-mark.png").size(px(18.)).rounded(px(3.))),
                ),
            )
            .child(nav)
            .child(div().my_2().mx_2().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("provider-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(providers),
            )
            .child(h_flex().p_2().items_center().child(theme_seg));

        // ---- status strip: 10px mono-ish, matches the Electron StatusStrip ----
        let status_strip = h_flex()
            .h_10()
            .items_center()
            .gap_3()
            .px_4()
            .border_b_1()
            .border_color(theme.border)
            .child(
                Label::new(if running {
                    "● running"
                } else {
                    "○ stopped"
                })
                .text_xs()
                .font_semibold()
                .text_color(if running {
                    theme.primary
                } else {
                    theme.muted_foreground
                }),
            )
            .child(
                Label::new(snapshot.server.url.clone())
                    .text_xs()
                    .text_color(theme.muted_foreground),
            )
            .child(div().flex_1())
            .child(
                Label::new(format!("{ready}/{}", snapshot.providers.len()))
                    .text_xs()
                    .text_color(theme.muted_foreground),
            )
            .child(
                Label::new(format!("{errors} err"))
                    .text_xs()
                    .text_color(if errors > 0 {
                        theme.danger
                    } else {
                        theme.muted_foreground
                    }),
            )
            .child(
                Label::new(format!("v{}", env!("CARGO_PKG_VERSION")))
                    .text_xs()
                    .text_color(theme.muted_foreground),
            );

        self.drain_pending();
        let (body, max_w) = if let Some(provider) = self.detail.clone() {
            (
                self.render_provider_detail(&provider, &snapshot, cx),
                DETAIL_MAX_W,
            )
        } else {
            (
                match self.page {
                    Page::Dashboard => self.render_dashboard(&snapshot, cx),
                    Page::ApiKeys => self.render_api_keys(&snapshot, cx),
                    Page::Mappings => self.render_mappings(&snapshot, cx),
                    Page::Playground => self.render_playground(&snapshot, cx),
                    Page::Usage => self.render_usage(&snapshot, cx),
                    Page::Logs => self.render_logs(&snapshot, cx),
                    Page::Settings => self.render_settings(&snapshot, cx),
                },
                PAGE_MAX_W,
            )
        };

        // ---- glass pane + specular top edge + centered page column ----
        h_flex()
            .items_stretch()
            .size_full()
            .p_3()
            .gap_3()
            .child(sidebar)
            .child(
                v_flex()
                    .flex_1()
                    .h_full()
                    .rounded(theme.radius_lg)
                    .bg(theme.group_box.opacity(0.88))
                    .border_1()
                    .border_color(theme.border)
                    .shadow_lg()
                    .overflow_hidden()
                    .child(
                        // specular top edge — the 1px highlight that reads as glass
                        div().h_px().bg(gpui::white().opacity(0.08)),
                    )
                    .child(status_strip)
                    .child(
                        div()
                            .id("page-scroll")
                            .flex_1()
                            .min_h_0()
                            .overflow_y_scroll()
                            .child(
                                div()
                                    .mx_auto()
                                    .w_full()
                                    .max_w(px(max_w))
                                    .px_6()
                                    .pb_6()
                                    .child(body),
                            ),
                    ),
            )
    }
}
