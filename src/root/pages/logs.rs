//! Logs — level filter + search + clear/export, virtualized row list.

use std::ops::Range;
use std::rc::Rc;

use gateway_core::{GatewayStatusSnapshot, LogLevel};
use gpui_kit::component::{
    ActiveTheme, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    searchable_list::SearchableVec,
    select::Select,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, MONO, MarqueeText, card, clock_time, enter, section_header, t, tf, toggle_filter,
};

// Shared column lanes — the header row and every data row use the same
// geometry so the labels stay aligned over the virtualized list.
const LANE_TIME: f32 = 64.;
const LANE_LEVEL: f32 = 72.;
const LANE_PROVIDER: f32 = 96.;
const LANE_STATUS: f32 = 56.;
const LANE_DURATION: f32 = 72.;

impl AppRoot {
    pub(crate) fn render_logs(
        &mut self,
        snapshot: &GatewayStatusSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        let query = self.log_search.read(cx).value().to_lowercase();
        let level_ix = self.log_level;
        let provider_pick = self.log_provider_sel.read(cx).selected_value().cloned();

        // Provider filter options — configured providers first, then any
        // names only seen in the log buffer (e.g. removed since). Re-synced
        // into the SelectState only when the snapshot actually changes the
        // set; the selection itself survives `set_items`.
        let mut providers: Vec<String> = snapshot
            .providers
            .iter()
            .map(|p| p.name.clone())
            .collect();
        for e in &snapshot.logs {
            if let Some(p) = &e.provider {
                if !providers.contains(p) {
                    providers.push(p.clone());
                }
            }
        }
        if providers != self.log_provider_items {
            self.log_provider_items = providers.clone();
            self.log_provider_sel.update(cx, |s, cx| {
                s.set_items(SearchableVec::new(providers), window, cx);
            });
        }

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
                let provider_ok = provider_pick
                    .as_deref()
                    .is_none_or(|p| e.provider.as_deref() == Some(p));
                let query_ok = query.is_empty()
                    || e.message.to_lowercase().contains(&query)
                    || e.provider
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query);
                (level_ok && provider_ok && query_ok).then_some(index)
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
                div().w(px(150.)).flex_none().child(
                    Select::new(&self.log_provider_sel)
                        .small()
                        .cleanable(true)
                        .placeholder(t(lang, "all_providers"))
                        .menu_width(px(200.)),
                ),
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

        // ---- column header rides inside the card (same lanes as rows) ----
        let head_cell = |text: &str, w: Option<f32>, right: bool| {
            let cell = match w {
                Some(w) => div().w(px(w)).flex_none(),
                None => div().flex_1().min_w_0(),
            };
            let label = Label::new(text)
                .text_xs()
                .text_color(theme.muted_foreground);
            if right {
                cell.flex().justify_end().child(label)
            } else {
                cell.child(label)
            }
        };
        let header = h_flex()
            .items_center()
            .gap_2p5()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .child(head_cell(t(lang, "col_time"), Some(LANE_TIME), false))
            .child(head_cell(t(lang, "col_level"), Some(LANE_LEVEL), false))
            .child(head_cell(
                t(lang, "col_provider"),
                Some(LANE_PROVIDER),
                false,
            ))
            .child(head_cell(t(lang, "col_message"), None, false))
            .child(head_cell(t(lang, "col_status"), Some(LANE_STATUS), true))
            .child(head_cell(
                t(lang, "col_duration"),
                Some(LANE_DURATION),
                true,
            ));

        // ---- virtualized rows inside one card ----
        let theme_for_rows = theme.clone();
        let row_height = px(34.);
        let render_row = move |ix: usize, _window: &mut Window, _app: &mut App| -> AnyElement {
            let entry = &snapshot_for_rows.logs[entry_indices[ix]];
            let (level_key, level_color) = match entry.level {
                LogLevel::Info => ("info", theme_for_rows.muted_foreground),
                LogLevel::Warn => ("warn", theme_for_rows.warning),
                LogLevel::Error => ("error", theme_for_rows.danger),
                LogLevel::Debug => ("debug", theme_for_rows.muted_foreground),
            };
            let status_color = match entry.status_code {
                Some(code) if code >= 400 => theme_for_rows.danger,
                _ => theme_for_rows.secondary_foreground,
            };
            h_flex()
                .w_full()
                .h(row_height)
                .hover(|d| d.bg(theme_for_rows.list_hover))
                .child(
                    h_flex()
                        .flex_1()
                        .min_w_0()
                        .items_center()
                        .gap_2p5()
                        .pl_4()
                        .pr_4()
                        .child(
                            div().w(px(LANE_TIME)).flex_none().child(
                                Label::new(clock_time(entry.ts))
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme_for_rows.muted_foreground),
                            ),
                        )
                        .child(
                            div().w(px(LANE_LEVEL)).flex_none().child(
                                div()
                                    .px_2()
                                    .h(px(18.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .bg(level_color.opacity(0.14))
                                    .child(
                                        Label::new(t(lang, level_key))
                                            .text_xs()
                                            .font_medium()
                                            .text_color(level_color),
                                    ),
                            ),
                        )
                        .child(
                            div().w(px(LANE_PROVIDER)).flex_none().child(
                                Label::new(entry.provider.clone().unwrap_or_else(|| "—".into()))
                                    .text_xs()
                                    .text_color(if entry.provider.is_some() {
                                        theme_for_rows.secondary_foreground
                                    } else {
                                        theme_for_rows.muted_foreground
                                    })
                                    .truncate(),
                            ),
                        )
                        .child(
                            MarqueeText::new(
                                format!("log-msg-{}", entry_indices[ix]),
                                entry.message.clone(),
                                false,
                                theme_for_rows.foreground,
                            )
                            .into_any_element(),
                        )
                        .child(
                            div()
                                .w(px(LANE_STATUS))
                                .flex_none()
                                .flex()
                                .justify_end()
                                .when_some(entry.status_code, |d, code| {
                                    d.child(
                                        Label::new(code.to_string())
                                            .font_family(MONO)
                                            .text_xs()
                                            .text_color(status_color),
                                    )
                                }),
                        )
                        .child(
                            div()
                                .w(px(LANE_DURATION))
                                .flex_none()
                                .flex()
                                .justify_end()
                                .when_some(entry.duration, |d, ms| {
                                    d.child(
                                        Label::new(format!("{ms}ms"))
                                            .font_family(MONO)
                                            .text_xs()
                                            .text_color(theme_for_rows.muted_foreground),
                                    )
                                }),
                        ),
                )
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
            let border = theme.border;
            let list = uniform_list(
                "logs-list",
                total,
                move |range: Range<usize>, window, app| {
                    range
                        .map(|ix| {
                            let row = render_row(ix, window, app);
                            div()
                                .w_full()
                                .border_b_1()
                                .border_color(if ix == total.saturating_sub(1) {
                                    border.opacity(0.0)
                                } else {
                                    border
                                })
                                .child(row)
                                .into_any_element()
                        })
                        .collect::<Vec<_>>()
                },
            )
            .h_full()
            .track_scroll(&self.log_scroll);
            div()
                .flex_1()
                .min_h_0()
                .child(
                    card(cx).h_full().overflow_hidden().child(
                        v_flex()
                            .h_full()
                            .min_h_0()
                            .child(header)
                            .child(div().flex_1().min_h_0().child(list)),
                    ),
                )
                .into_any_element()
        };

        v_flex()
            .h_full()
            .min_h_0()
            .gap_4()
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
