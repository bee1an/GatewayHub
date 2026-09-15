//! Root view: translucent sidebar rail + distinct glass content pane —
//! the liquid-glass shell from the Electron layout, rebuilt on gpui-kit.

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use std::collections::HashMap;

use gateway_core::{
    AccountTestResult, ApiKeyEntry, GatewayService, GatewayStatusSnapshot, ModelMapping,
    ProviderStatus, generate_api_key,
};
use gpui_kit::component::{
    ActiveTheme, IconName, Sizable, StyledExt, Theme, ThemeMode,
    button::{Button, ButtonVariants},
    h_flex,
    input::{Input, InputState},
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

const APP_NAME: &str = "GatewayHub";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Dashboard,
    ApiKeys,
    Mappings,
    Usage,
    Logs,
    Settings,
}

pub struct AppRoot {
    service: Arc<GatewayService>,
    page: Page,
    /// Provider detail view — set when a dashboard card is clicked.
    detail: Option<String>,
    /// None = follow the OS appearance (the "System" segment).
    mode_choice: Option<ThemeMode>,
    /// "provider/accountId" → last test outcome line.
    test_results: HashMap<String, String>,
    /// In-flight account tests; drained each render via try_recv.
    test_pending: HashMap<String, tokio::sync::oneshot::Receiver<AccountTestResult>>,
    /// provider → fetched model ids (lazy, fetched on detail open).
    detail_models: HashMap<String, Vec<String>>,
    models_pending: HashMap<String, tokio::sync::oneshot::Receiver<Vec<String>>>,
    /// API-key page: name for the next generated key.
    key_name_input: Entity<InputState>,
    /// Mapping page inputs.
    map_alias_input: Entity<InputState>,
    map_target_input: Entity<InputState>,
    /// Newly generated key shown once so it can be copied.
    new_key: Option<String>,
    /// Provider detail: paste-an-account-JSON import box + last result.
    import_input: Entity<InputState>,
    import_result: Option<String>,
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
        }
    }

    fn toggle_server(&mut self, cx: &mut Context<Self>) {
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

    /// Kick off provider.list_models + refresh test results when a detail
    /// page is opened (idempotent — pending tasks are not restarted).
    fn open_detail(&mut self, provider: &str) {
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

    fn test_account(&mut self, provider: &str, account_id: &str) {
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

    /// Drain completed test/model futures into their result maps.
    fn drain_pending(&mut self) {
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
    }
}

fn provider_icon(provider: &str) -> Option<&'static str> {
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

fn status_label(p: &ProviderStatus) -> &'static str {
    match p.status {
        "ready" => "ready",
        "placeholder" => "soon",
        "error" => "error",
        _ => "off",
    }
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
                .child(Label::new(label).text_sm().when(sel, |l| {
                    l.font_medium().text_color(theme.button_primary_foreground)
                })),
        );
    }
    track
}

fn nav_item(
    id: &'static str,
    label: &'static str,
    active: bool,
    cx: &App,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let theme = cx.theme().clone();
    div()
        .id(id)
        .h_7()
        .px_2()
        .flex()
        .items_center()
        .rounded(theme.radius)
        .cursor_pointer()
        .when(active, |d| d.bg(theme.list_active))
        .when(!active, |d| d.hover(|d| d.bg(theme.list_hover)))
        .child(
            Label::new(label)
                .text_sm()
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
            .filter(|p| p.status == "ready")
            .count();

        // ---- sidebar ----
        let mut nav = v_flex().gap_px().px_2();
        for (page, id, label) in [
            (Page::Dashboard, "nav-dashboard", "Dashboard"),
            (Page::ApiKeys, "nav-apikeys", "API Keys"),
            (Page::Mappings, "nav-mappings", "Mappings"),
            (Page::Usage, "nav-usage", "Usage"),
            (Page::Logs, "nav-logs", "Logs"),
            (Page::Settings, "nav-settings", "Settings"),
        ] {
            let active = self.page == page;
            nav = nav.child(nav_item(id, label, active, cx).on_click(cx.listener(
                move |this, _, _w, cx| {
                    this.page = page;
                    cx.notify();
                },
            )));
        }

        let mut providers = v_flex().gap_px().px_2();
        for p in snapshot.providers.iter().filter(|p| p.enabled) {
            let mut row = h_flex()
                .h_7()
                .px_2()
                .items_center()
                .gap_2()
                .rounded(theme.radius);
            if let Some(src) = provider_icon(&p.provider_type) {
                row = row.child(img(src).size_4().rounded_sm());
            }
            row = row.child(
                Label::new(p.display_name.clone().unwrap_or_else(|| p.name.clone()))
                    .text_sm()
                    .text_color(theme.foreground),
            );
            row = row.child(div().flex_1());
            if !p.configured {
                row = row.child(Label::new("—").text_xs().text_color(theme.muted_foreground));
            }
            providers = providers.child(row);
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
            .w_48()
            .h_full()
            .child(
                // traffic-light offset (~56px) doubles as the drag strip —
                // a platform boundary, so physical px is intentional here
                h_flex()
                    .h(px(56.))
                    .items_end()
                    .gap_2()
                    .pb_2()
                    .pl_3()
                    .child(img("gatewayhub-mark.png").size_5().rounded_sm())
                    .child(
                        Label::new(APP_NAME)
                            .text_sm()
                            .font_semibold()
                            .text_color(theme.foreground),
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

        // ---- content pane ----
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
                Label::new(format!("{ready}/{} providers", snapshot.providers.len()))
                    .text_xs()
                    .text_color(theme.muted_foreground),
            );

        self.drain_pending();
        let body = if let Some(provider) = self.detail.clone() {
            self.render_provider_detail(&provider, &snapshot, cx)
        } else {
            match self.page {
                Page::Dashboard => self.render_dashboard(&snapshot, cx),
                Page::ApiKeys => self.render_api_keys(&snapshot, cx),
                Page::Mappings => self.render_mappings(&snapshot, cx),
                Page::Usage => self.render_usage(&snapshot, cx),
                Page::Logs => self.render_logs(&snapshot, cx),
                Page::Settings => self.render_settings(&snapshot, cx),
            }
        };

        // Columns inside a bare h_flex don't fill its height — items_stretch
        // is required for the sidebar and pane to span the window.
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
                    .bg(theme.group_box)
                    .border_1()
                    .border_color(theme.border)
                    .shadow_lg()
                    .overflow_hidden()
                    .child(status_strip)
                    .child(body),
            )
    }
}

impl AppRoot {
    fn render_dashboard(
        &self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let running = snapshot.server.running;

        let mut cards = v_flex().gap_2().p_4();
        for p in &snapshot.providers {
            let name = p.name.clone();
            let mut card = h_flex()
                .id(SharedString::from(format!("card-{}", p.name)))
                .items_center()
                .gap_3()
                .p_3()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .bg(theme.muted.opacity(0.35))
                .cursor_pointer()
                .hover(|d| d.bg(theme.list_hover))
                .on_click(cx.listener(move |this, _, _w, cx| {
                    this.open_detail(&name);
                    cx.notify();
                }));
            if let Some(src) = provider_icon(&p.provider_type) {
                card = card.child(img(src).size_5().rounded_sm());
            }
            card = card.child(
                v_flex()
                    .child(
                        Label::new(p.display_name.clone().unwrap_or_else(|| p.name.clone()))
                            .text_sm()
                            .font_medium()
                            .text_color(theme.foreground),
                    )
                    .child(
                        Label::new(format!(
                            "{} · {} account(s) · {} model(s)",
                            status_label(p),
                            p.accounts,
                            p.models.len()
                        ))
                        .text_xs()
                        .text_color(theme.muted_foreground),
                    ),
            );
            cards = cards.child(card);
        }

        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .p_4()
                    .items_center()
                    .gap_3()
                    .child(
                        Button::new("power")
                            .primary()
                            .small()
                            .label(if running {
                                "Stop gateway"
                            } else {
                                "Start gateway"
                            })
                            .icon(IconName::RotateCw)
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.toggle_server(cx);
                            })),
                    )
                    .child(
                        Label::new(format!(
                            "{} · {} api key(s)",
                            snapshot.config_path, snapshot.server.api_keys
                        ))
                        .text_xs()
                        .text_color(theme.muted_foreground),
                    ),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("dashboard-cards")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(cards),
            )
            .into_any_element()
    }

    fn render_logs(&self, snapshot: &GatewayStatusSnapshot, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let mut list = v_flex().p_2();
        if snapshot.logs.is_empty() {
            list = list.child(
                div().p_4().child(
                    Label::new("No log entries yet")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for entry in snapshot.logs.iter().rev().take(200) {
            list = list.child(
                h_flex()
                    .px_3()
                    .py_1()
                    .gap_2()
                    .items_baseline()
                    .border_b_1()
                    .border_color(theme.table_row_border)
                    .child(
                        Label::new(format!("{:?}", entry.level).to_lowercase())
                            .text_xs()
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        Label::new(entry.provider.clone().unwrap_or_default())
                            .text_xs()
                            .text_color(theme.muted_foreground),
                    )
                    .child(Label::new(entry.message.clone()).text_xs()),
            );
        }
        v_flex()
            .id("logs-list")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .child(list)
            .into_any_element()
    }

    fn render_provider_detail(
        &self,
        provider: &str,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let status = snapshot.providers.iter().find(|p| p.name == provider);
        let accounts = self.service.accounts(provider);
        let models = self
            .detail_models
            .get(provider)
            .cloned()
            .unwrap_or_default();

        let mut rows = v_flex().gap_1p5().p_4();
        if accounts.is_empty() {
            rows = rows.child(
                div().p_4().child(
                    Label::new("No account files for this provider")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for account in &accounts {
            let key = format!("{provider}/{}", account.id);
            let result = self.test_results.get(&key).cloned();
            let label = account
                .label
                .clone()
                .or_else(|| account.email.clone())
                .unwrap_or_else(|| account.id.clone());
            let provider_name = provider.to_string();
            let account_id = account.id.clone();
            let mut row = h_flex()
                .items_center()
                .gap_3()
                .p_3()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .bg(theme.muted.opacity(0.35));
            row = row.child(
                v_flex()
                    .child(
                        Label::new(label)
                            .text_sm()
                            .font_medium()
                            .text_color(theme.foreground),
                    )
                    .child(
                        Label::new(format!(
                            "{}{}",
                            if account.enabled {
                                "enabled"
                            } else {
                                "disabled"
                            },
                            result.map(|r| format!(" · {r}")).unwrap_or_default()
                        ))
                        .text_xs()
                        .text_color(theme.muted_foreground),
                    ),
            );
            row = row.child(div().flex_1());
            let provider_name2 = provider_name.clone();
            let account_id2 = account_id.clone();
            let provider_name3 = provider_name.clone();
            let account_id3 = account_id.clone();
            row = row.child(
                Button::new(SharedString::from(format!("test-{}", account.id)))
                    .outline()
                    .small()
                    .label("Test")
                    .on_click(cx.listener(move |this, _, _w, cx| {
                        this.test_account(&provider_name, &account_id);
                        cx.notify();
                    })),
            );
            row = row.child(
                Button::new(SharedString::from(format!("toggle-{}", account.id)))
                    .outline()
                    .small()
                    .label(if account.enabled { "Disable" } else { "Enable" })
                    .on_click(cx.listener(move |this, _, _w, cx| {
                        this.toggle_account(&provider_name2, &account_id2, cx);
                    })),
            );
            row = row.child(
                Button::new(SharedString::from(format!("del-{}", account.id)))
                    .danger()
                    .small()
                    .label("Delete")
                    .on_click(cx.listener(move |this, _, _w, cx| {
                        this.delete_account(&provider_name3, &account_id3, cx);
                    })),
            );
            rows = rows.child(row);
        }

        let mut model_rows = v_flex().gap_1().px_4().pb_4();
        for m in models.iter().take(30) {
            model_rows = model_rows.child(
                Label::new(m.clone())
                    .text_xs()
                    .text_color(theme.muted_foreground),
            );
        }

        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .p_4()
                    .items_center()
                    .gap_3()
                    .child(
                        Button::new("back")
                            .outline()
                            .small()
                            .label("Back")
                            .icon(IconName::ArrowLeft)
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.detail = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Label::new(provider.to_string())
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    )
                    .child(
                        Label::new(status.and_then(|p| p.message.clone()).unwrap_or_default())
                            .text_xs()
                            .text_color(theme.muted_foreground),
                    ),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("detail-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(rows)
                    .child(
                        h_flex().px_4().pb_2().child(
                            Label::new(format!("{} model(s)", models.len()))
                                .text_xs()
                                .font_semibold()
                                .text_color(theme.foreground),
                        ),
                    )
                    .child(model_rows),
            )
            .into_any_element()
    }

    fn render_api_keys(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let cfg = self.service.config();

        let mut rows = v_flex().gap_1p5().p_4();
        if cfg.server.api_keys.is_empty() {
            rows = rows.child(
                div().p_4().child(
                    Label::new("No API keys — the gateway rejects every request until one exists")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for k in &cfg.server.api_keys {
            let masked = if k.key.len() > 10 {
                format!("{}…{}", &k.key[..6], &k.key[k.key.len() - 4..])
            } else {
                "•••".into()
            };
            let id = k.id.clone();
            rows = rows.child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .p_3()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.muted.opacity(0.35))
                    .child(
                        v_flex()
                            .child(
                                Label::new(k.name.clone())
                                    .text_sm()
                                    .font_medium()
                                    .text_color(theme.foreground),
                            )
                            .child(
                                Label::new(masked)
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            ),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new(SharedString::from(format!("delkey-{}", k.id)))
                            .danger()
                            .small()
                            .label("Delete")
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.delete_api_key(&id, cx);
                            })),
                    ),
            );
        }

        let mut page = v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .p_4()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("API Keys")
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(div().w(px(220.)).child(Input::new(&self.key_name_input)))
                    .child(
                        Button::new("gen-key")
                            .primary()
                            .small()
                            .label("Generate")
                            .icon(IconName::Plus)
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.add_api_key(cx);
                            })),
                    ),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("apikeys-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(rows),
            );
        if let Some(key) = &self.new_key {
            let shown = key.clone();
            page = page.child(
                h_flex()
                    .p_3()
                    .mx_4()
                    .mb_4()
                    .rounded(theme.radius)
                    .bg(theme.accent)
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new(format!("New key (copy now — shown once): {shown}"))
                            .text_xs()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("dismiss-key")
                            .ghost()
                            .small()
                            .label("Dismiss")
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.new_key = None;
                                cx.notify();
                            })),
                    ),
            );
        }
        page.into_any_element()
    }

    fn render_mappings(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let cfg = self.service.config();

        let mut rows = v_flex().gap_1p5().p_4();
        if cfg.model_mappings.is_empty() {
            rows = rows.child(
                div().p_4().child(
                    Label::new("No mappings — model names pass through to the provider unchanged")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for (ix, m) in cfg.model_mappings.iter().enumerate() {
            rows = rows.child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .p_3()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.muted.opacity(0.35))
                    .child(
                        v_flex()
                            .child(
                                Label::new(m.alias.clone())
                                    .text_sm()
                                    .font_medium()
                                    .text_color(theme.foreground),
                            )
                            .child(
                                Label::new(format!("→ {}/{}", m.provider, m.model))
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            ),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new(SharedString::from(format!("maptog-{ix}")))
                            .outline()
                            .small()
                            .label(if m.enabled { "Disable" } else { "Enable" })
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.toggle_mapping(ix, cx);
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("mapdel-{ix}")))
                            .danger()
                            .small()
                            .label("Delete")
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.delete_mapping(ix, cx);
                            })),
                    ),
            );
        }

        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .p_4()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("Model Mappings")
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(div().w(px(160.)).child(Input::new(&self.map_alias_input)))
                    .child(div().w(px(240.)).child(Input::new(&self.map_target_input)))
                    .child(
                        Button::new("add-map")
                            .primary()
                            .small()
                            .label("Add")
                            .icon(IconName::Plus)
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.add_mapping(cx);
                            })),
                    ),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("mappings-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(rows),
            )
            .into_any_element()
    }

    fn render_usage(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let detail = self
            .service
            .usage_store()
            .read(&gateway_core::usage_store::UsageReadOptions::default());
        let sum = &detail.summary;

        let stat = |label: &str, value: String| {
            v_flex()
                .p_3()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .bg(theme.muted.opacity(0.35))
                .child(
                    Label::new(label.to_string())
                        .text_xs()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    Label::new(value)
                        .text_lg()
                        .font_semibold()
                        .text_color(theme.foreground),
                )
        };
        let cost = |c: Option<f64>| c.map(|v| format!("${v:.4}")).unwrap_or_else(|| "—".into());

        let stats = h_flex()
            .p_4()
            .gap_3()
            .child(stat("today tokens", format!("{}", sum.today_tokens)))
            .child(stat("today requests", format!("{}", sum.today_requests)))
            .child(stat("today cost", cost(sum.today_cost_usd)))
            .child(stat("30d tokens", format!("{}", sum.last30days_tokens)))
            .child(stat("30d cost", cost(sum.last30days_cost_usd)));

        let mut rows = v_flex().gap_px().px_4().pb_4();
        if detail.daily.is_empty() {
            rows = rows.child(
                div().p_4().child(
                    Label::new("No usage recorded yet")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for e in &detail.daily {
            rows = rows.child(
                h_flex()
                    .px_3()
                    .py_1p5()
                    .gap_3()
                    .items_baseline()
                    .border_b_1()
                    .border_color(theme.table_row_border)
                    .child(Label::new(e.date.clone()).text_xs())
                    .child(
                        Label::new(format!(
                            "{}/{}",
                            e.provider.clone().unwrap_or_default(),
                            e.model
                        ))
                        .text_xs()
                        .text_color(theme.muted_foreground),
                    )
                    .child(div().flex_1())
                    .child(
                        Label::new(format!(
                            "in {} out {} req {}",
                            e.input_tokens, e.output_tokens, e.requests
                        ))
                        .text_xs()
                        .text_color(theme.muted_foreground),
                    )
                    .child(Label::new(cost(e.cost_usd)).text_xs()),
            );
        }

        v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex().p_4().items_center().child(
                    Label::new("Usage")
                        .text_lg()
                        .font_semibold()
                        .text_color(theme.foreground),
                ),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(stats)
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("usage-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(rows),
            )
            .into_any_element()
    }

    fn render_settings(
        &self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let auto_start = self.service.config().server.auto_start;
        let svc = self.service.clone();
        v_flex()
            .p_4()
            .gap_3()
            .child(
                Label::new("Settings")
                    .text_lg()
                    .font_semibold()
                    .text_color(theme.foreground),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("Config")
                            .text_sm()
                            .text_color(theme.muted_foreground),
                    )
                    .child(Label::new(snapshot.config_path.clone()).text_sm()),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("Endpoint")
                            .text_sm()
                            .text_color(theme.muted_foreground),
                    )
                    .child(Label::new(snapshot.server.url.clone()).text_sm()),
            )
            .child(
                Button::new("autostart")
                    .outline()
                    .small()
                    .label(if auto_start {
                        "Autostart: on"
                    } else {
                        "Autostart: off"
                    })
                    .on_click(cx.listener(move |_this, _, _w, cx| {
                        let mut cfg = svc.config();
                        cfg.server.auto_start = !cfg.server.auto_start;
                        if let Err(e) = svc.save_config(cfg) {
                            tracing::error!(error = %e, "save config failed");
                        }
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
}
