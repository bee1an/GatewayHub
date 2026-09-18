//! Logs — level filter + search + clear/export, virtualized row list.

use std::rc::Rc;

use gateway_core::{GatewayStatusSnapshot, LogLevel};
use gpui_kit::component::{
    ActiveTheme, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, MONO, card, card_uniform_list, clock_time, enter, one_line, page_header,
    section_header, t, tf, toggle_filter,
};

impl AppRoot {
    pub(crate) fn render_logs(
        &self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        let query = self.log_search.read(cx).value().to_lowercase();
        let level_ix = self.log_level;

        // Keep only indices into the cached Arc snapshot. Cloning thousands of
        // log strings on each five-second status refresh caused a visible
        // hitch even though row painting itself was virtualized.
        let mut entry_indices: Vec<usize> = snapshot
            .logs
            .iter()
            .enumerate()
            .filter_map(|(index, e)| {
                let level_ok = match level_ix {
                    1 => e.level == LogLevel::Info,
                    2 => e.level == LogLevel::Warn,
                    3 => e.level == LogLevel::Error,
                    _ => true,
                };
                let query_ok = query.is_empty()
                    || e.message.to_lowercase().contains(&query)
                    || e.provider
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query);
                (level_ok && query_ok).then_some(index)
            })
            .collect();
        entry_indices.reverse(); // newest first
        let total = entry_indices.len();
        let entry_indices = Rc::new(entry_indices);
        let snapshot_for_rows = self.snapshot.clone();

        // ---- toolbar: level segments | search | export / clear ----
        let root_entity = cx.entity();
        let toolbar = h_flex()
            .items_center()
            .gap_3()
            .child(toggle_filter(
                "log-level",
                vec![
                    (t(lang, "all").into(), level_ix == 0),
                    (t(lang, "info").into(), level_ix == 1),
                    (t(lang, "warn").into(), level_ix == 2),
                    (t(lang, "error").into(), level_ix == 3),
                ],
                move |ix, _w, app| {
                    let root = root_entity.clone();
                    app.update_entity(&root, |this, cx| {
                        this.log_level = ix;
                        cx.notify();
                    });
                },
                cx,
            ))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&self.log_search).small()),
            )
            .child(
                Button::new("logs-export")
                    .outline()
                    .small()
                    .label(t(lang, "export"))
                    .loading(self.exporting_logs)
                    .on_click(cx.listener(|this, _, _w, cx| this.export_logs(cx))),
            )
            .child(
                Button::new("logs-clear")
                    .danger()
                    .small()
                    .label(t(lang, "clear"))
                    .on_click(cx.listener(|this, _e: &ClickEvent, _w, cx| {
                        let title = t(this.lang, "clear_logs_title");
                        let desc = t(this.lang, "clear_logs_desc").to_string();
                        this.confirm(title, desc, "clear", cx, |this, cx| {
                            this.clear_logs(cx);
                        });
                    })),
            );

        // ---- virtualized rows inside one card ----
        let theme_for_rows = theme.clone();
        let row_height = px(34.);
        let render_row = move |ix: usize, _window: &mut Window, _app: &mut App| -> AnyElement {
            let entry = &snapshot_for_rows.logs[entry_indices[ix]];
            let (level_label, level_color) = match entry.level {
                LogLevel::Info => ("info", theme_for_rows.muted_foreground),
                LogLevel::Warn => ("warn", theme_for_rows.warning),
                LogLevel::Error => ("error", theme_for_rows.danger),
                LogLevel::Debug => ("debug", theme_for_rows.muted_foreground),
            };
            h_flex()
                .w_full()
                .h(row_height)
                .px_4()
                .items_center()
                .gap_2p5()
                .child(
                    div().w_16().flex_none().child(
                        Label::new(clock_time(entry.ts))
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme_for_rows.muted_foreground),
                    ),
                )
                .child(
                    div().w_12().flex_none().child(
                        Label::new(level_label)
                            .text_xs()
                            .font_medium()
                            .text_color(level_color),
                    ),
                )
                .child(
                    div().w_24().flex_none().child(
                        Label::new(entry.provider.clone().unwrap_or_default())
                            .text_xs()
                            .text_color(theme_for_rows.secondary_foreground)
                            .truncate(),
                    ),
                )
                .child(
                    div().flex_1().min_w_0().child(
                        Label::new(one_line(&entry.message, 200))
                            .text_xs()
                            .text_color(theme_for_rows.foreground)
                            .truncate(),
                    ),
                )
                .when_some(entry.status_code, |d, code| {
                    d.child(
                        Label::new(code.to_string())
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme_for_rows.danger),
                    )
                })
                .when_some(entry.duration, |d, ms| {
                    d.child(
                        Label::new(format!("{ms}ms"))
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme_for_rows.muted_foreground),
                    )
                })
                .into_any_element()
        };

        let logs_card: AnyElement = if total == 0 {
            card(cx)
                .py_6()
                .flex()
                .justify_center()
                .child(
                    Label::new(if snapshot.logs.is_empty() {
                        t(lang, "no_logs")
                    } else {
                        t(lang, "no_match_filter")
                    })
                    .text_sm()
                    .text_color(theme.muted_foreground),
                )
                .into_any_element()
        } else {
            div()
                .flex_1()
                .min_h_0()
                .child(card_uniform_list(
                    "logs-list",
                    total,
                    &self.log_scroll,
                    render_row,
                    cx,
                ))
                .into_any_element()
        };

        v_flex()
            .h_full()
            .min_h_0()
            .gap_4()
            .child(
                div()
                    .flex_none()
                    .child(page_header(t(lang, "logs_title"), "", None, cx)),
            )
            .child(div().flex_none().child(toolbar))
            .child(div().flex_none().child(section_header(
                tf(lang, "n_entries", &[("n", &total.to_string())]),
                None,
                cx,
            )))
            .when_some(self.log_notice.as_ref(), |d, notice| {
                d.child(
                    div().flex_none().child(enter(
                        div().child(
                            Label::new(notice.clone())
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                        format!("log-notice-{}", self.notice_nonce),
                    )),
                )
            })
            .child(logs_card)
            .into_any_element()
    }
}
