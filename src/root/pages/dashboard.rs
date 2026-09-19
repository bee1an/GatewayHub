//! Dashboard — gateway control, health summary, and recent failures.

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

use crate::root::{AppRoot, MONO, Page, card, card_rows, one_line, section_header, t, tf};

const RECENT_ERROR_LIMIT: usize = 5;

impl AppRoot {
    pub(crate) fn render_dashboard(
        &mut self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        let running = snapshot.server.running;
        let ready = snapshot
            .providers
            .iter()
            .filter(|provider| provider.enabled && provider.status == "ready")
            .count();
        let enabled = snapshot
            .providers
            .iter()
            .filter(|provider| provider.enabled && provider.status != "placeholder")
            .count();
        let error_logs: Vec<_> = snapshot
            .logs
            .iter()
            .filter(|entry| entry.level == gateway_core::LogLevel::Error)
            .collect();

        let gateway_card = card(cx).px_4().py_3().child(
            h_flex()
                .items_center()
                .gap_3()
                .child(div().size_2().rounded_full().bg(if running {
                    theme.success
                } else {
                    theme.muted_foreground
                }))
                .child(
                    v_flex()
                        .gap_0p5()
                        .child(
                            Label::new(t(lang, if running { "running" } else { "stopped" }))
                                .text_sm()
                                .font_medium()
                                .text_color(theme.foreground),
                        )
                        .child(
                            Label::new(snapshot.server.url.clone())
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                )
                .child(div().flex_1())
                .child(
                    v_flex()
                        .items_end()
                        .gap_0p5()
                        .child(
                            Label::new(tf(
                                lang,
                                "n_ready",
                                &[
                                    ("ready", &ready.to_string()),
                                    ("enabled", &enabled.to_string()),
                                ],
                            ))
                            .text_xs()
                            .text_color(theme.muted_foreground),
                        )
                        .when(!error_logs.is_empty(), |d| {
                            d.child(
                                Label::new(tf(
                                    lang,
                                    "n_errors",
                                    &[("n", &error_logs.len().to_string())],
                                ))
                                .text_xs()
                                .text_color(theme.danger),
                            )
                        }),
                )
                .child(
                    Button::new("dash-power")
                        .when(running, |button| button.danger())
                        .when(!running, |button| button.primary())
                        .small()
                        .label(t(
                            lang,
                            if self.server_pending {
                                if running { "stopping" } else { "starting" }
                            } else if running {
                                "stop"
                            } else {
                                "start"
                            },
                        ))
                        .icon(if running {
                            IconName::CircleX
                        } else {
                            IconName::Play
                        })
                        .loading(self.server_pending)
                        .on_click(cx.listener(|this, _, _window, cx| this.toggle_server(cx))),
                ),
        );

        let mut error_rows = Vec::new();
        for entry in error_logs.iter().rev().take(RECENT_ERROR_LIMIT) {
            error_rows.push(
                h_flex()
                    .w_full()
                    .px_4()
                    .py_2()
                    .items_center()
                    .gap_3()
                    .child(
                        div().w_16().flex_none().child(
                            Label::new(crate::root::clock_time(entry.ts))
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                    )
                    .child(
                        div().w_20().flex_none().child(
                            Label::new(entry.provider.clone().unwrap_or_else(|| "—".into()))
                                .text_xs()
                                .text_color(theme.secondary_foreground)
                                .truncate(),
                        ),
                    )
                    .child(
                        div().flex_1().min_w_0().child(
                            Label::new(one_line(&entry.message, 180))
                                .text_xs()
                                .text_color(theme.foreground)
                                .truncate(),
                        ),
                    )
                    .when_some(entry.status_code, |row, status| {
                        row.child(
                            Label::new(status.to_string())
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.danger),
                        )
                    })
                    .into_any_element(),
            );
        }

        let errors_card = if error_rows.is_empty() {
            card(cx)
                .px_4()
                .py_5()
                .flex()
                .justify_center()
                .child(
                    Label::new(t(lang, "no_recent_errors"))
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element()
        } else {
            card_rows(error_rows, cx)
        };

        v_flex()
            .gap_4()
            .child(gateway_card)
            .child(
                v_flex()
                    .gap_2()
                    .child(section_header(
                        t(lang, "recent_errors"),
                        Some(
                            Button::new("dash-view-logs")
                                .ghost()
                                .xsmall()
                                .label(t(lang, "view_all"))
                                .on_click(cx.listener(|this, _, _window, cx| {
                                    this.page = Page::Logs;
                                    this.detail = None;
                                    cx.notify();
                                }))
                                .into_any_element(),
                        ),
                        cx,
                    ))
                    .child(errors_card),
            )
            .into_any_element()
    }
}
