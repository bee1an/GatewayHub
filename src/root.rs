//! Root view: translucent sidebar rail + distinct glass content pane —
//! the liquid-glass shell from the Electron layout, rebuilt on gpui-kit.

use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use gateway_core::{GatewayService, GatewayStatusSnapshot, ProviderStatus};
use gpui_kit::component::{
    ActiveTheme, IconName, Sizable, StyledExt, Theme, ThemeMode,
    button::{Button, ButtonVariants},
    h_flex,
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

const APP_NAME: &str = "GatewayHub";

#[derive(Clone, Copy, PartialEq, Eq)]
enum Page {
    Dashboard,
    Logs,
    Settings,
}

pub struct AppRoot {
    service: Arc<GatewayService>,
    page: Page,
    /// None = follow the OS appearance (the "System" segment).
    mode_choice: Option<ThemeMode>,
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
            mode_choice: None,
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
                .child(
                    Label::new(label).text_sm().when(sel, |l| {
                        l.font_medium().text_color(theme.button_primary_foreground)
                    }),
                ),
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
        let ready = snapshot.providers.iter().filter(|p| p.status == "ready").count();

        // ---- sidebar ----
        let mut nav = v_flex().gap_px().px_2();
        for (page, id, label) in [
            (Page::Dashboard, "nav-dashboard", "Dashboard"),
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
                    let mode = root
                        .mode_choice
                        .unwrap_or_else(|| crate::theme::theme_mode_for_appearance(cx.window_appearance()));
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
                Label::new(if running { "● running" } else { "○ stopped" })
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

        let body = match self.page {
            Page::Dashboard => self.render_dashboard(&snapshot, cx),
            Page::Logs => self.render_logs(&snapshot, cx),
            Page::Settings => self.render_settings(&snapshot, cx),
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
    fn render_dashboard(&self, snapshot: &GatewayStatusSnapshot, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().clone();
        let running = snapshot.server.running;

        let mut cards = v_flex().gap_2().p_4();
        for p in &snapshot.providers {
            let mut card = h_flex()
                .items_center()
                .gap_3()
                .p_3()
                .rounded(theme.radius)
                .border_1()
                .border_color(theme.border)
                .bg(theme.muted.opacity(0.35));
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
                            .label(if running { "Stop gateway" } else { "Start gateway" })
                            .icon(IconName::RotateCw)
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.toggle_server(cx);
                            })),
                    )
                    .child(
                        Label::new(format!(
                            "{} · {} api key(s)",
                            snapshot.config_path,
                            snapshot.server.api_keys
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

    fn render_settings(&self, snapshot: &GatewayStatusSnapshot, cx: &mut Context<Self>) -> AnyElement {
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
                    .child(Label::new("Config").text_sm().text_color(theme.muted_foreground))
                    .child(Label::new(snapshot.config_path.clone()).text_sm()),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(Label::new("Endpoint").text_sm().text_color(theme.muted_foreground))
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
