//! Dashboard — PageHeader + gateway control bar + recent errors, matching
//! the Electron Dashboard page (providers live in the sidebar rail).

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{AppRoot, Page, page_header};

const RECENT_ERROR_LIMIT: usize = 5;

impl AppRoot {
    pub(crate) fn render_dashboard(
        &mut self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let running = snapshot.server.running;
        let providers: Vec<_> = snapshot
            .providers
            .iter()
            .filter(|p| p.status != "placeholder")
            .collect();
        let ready_count = providers
            .iter()
            .filter(|p| p.enabled && p.status == "ready")
            .count();
        let error_logs: Vec<_> = snapshot
            .logs
            .iter()
            .filter(|l| l.level == gateway_core::LogLevel::Error)
            .collect();
        let total_errors = error_logs.len();

        // ---- control bar: status ● + url | ready/errors + start/stop ----
        let control_bar = h_flex()
            .items_center()
            .justify_between()
            .gap_4()
            .py_4()
            .border_b_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(
                        Label::new(if running { "running" } else { "stopped" })
                            .text_base()
                            .font_semibold()
                            .text_color(if running {
                                theme.primary
                            } else {
                                theme.muted_foreground
                            }),
                    )
                    .child(div().size(px(6.)).rounded_full().bg(if running {
                        theme.primary
                    } else {
                        theme.border
                    }))
                    .child(
                        Label::new(snapshot.server.url.clone())
                            .text_xs()
                            .text_color(theme.muted_foreground),
                    ),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .child(
                        Button::new("dash-errors-link")
                            .ghost()
                            .small()
                            .label(format!(
                                "{}/{} ready · {} errors",
                                ready_count,
                                providers.len(),
                                total_errors
                            ))
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.page = Page::Logs;
                                this.detail = None;
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("power")
                            .when(running, |b| b.danger())
                            .when(!running, |b| b.primary())
                            .small()
                            .label(if running { "Stop" } else { "Start" })
                            .icon(if running {
                                IconName::CircleStop
                            } else {
                                IconName::Play
                            })
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.toggle_server(cx);
                            })),
                    ),
            );

        // ---- recent errors ----
        let mut errors = v_flex().pt_4().gap_2();
        errors = errors.child(
            h_flex()
                .items_center()
                .justify_between()
                .child(
                    Label::new("Recent errors")
                        .text_xs()
                        .font_semibold()
                        .text_color(theme.muted_foreground),
                )
                .child(
                    Button::new("view-all-logs")
                        .ghost()
                        .xsmall()
                        .label("View all")
                        .icon(IconName::ArrowRight)
                        .on_click(cx.listener(|this, _, _w, cx| {
                            this.page = Page::Logs;
                            this.detail = None;
                            cx.notify();
                        })),
                ),
        );
        if error_logs.is_empty() {
            errors = errors.child(
                div().py_2().child(
                    Label::new("No errors")
                        .text_xs()
                        .text_color(theme.muted_foreground),
                ),
            );
        } else {
            let mut list = v_flex();
            for (i, log) in error_logs.iter().rev().take(RECENT_ERROR_LIMIT).enumerate() {
                list = list.child(
                    h_flex()
                        .items_start()
                        .gap_2p5()
                        .py_1p5()
                        .when(i > 0, |d| d.border_t_1().border_color(theme.border))
                        .child(
                            Label::new(log.provider.clone().unwrap_or_default())
                                .text_xs()
                                .text_color(theme.danger),
                        )
                        .child(
                            Label::new(log.message.clone())
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                );
            }
            errors = errors.child(list);
        }

        v_flex()
            .gap_5()
            .child(page_header(
                "Dashboard",
                "Local multi-provider AI gateway — OpenAI / Anthropic / Responses compatible",
                cx,
            ))
            .child(control_bar)
            .child(errors)
            .into_any_element()
    }
}
