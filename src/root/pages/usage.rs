//! Usage — summary stat row + virtualized daily/provider breakdown table.

use std::rc::Rc;

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::component::{
    ActiveTheme, Sizable, StyledExt, button::ButtonVariants, h_flex, label::Label,
    skeleton::Skeleton, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, CHART_H, LANE_DURATION, LANE_STATUS, LANE_TIME, MONO, ROW_H, card, card_uniform_list,
    fmt_count, hairline, pop_in, section_header, skeleton_rows, t, toggle_filter,
};

// Numeric column lanes — shared rem slots between the header row and every
// data row so the table scales with interface zoom.
const COL_TOKENS: Rems = LANE_TIME; // in/out token counts
const COL_CACHE: Rems = rems(3.25); // cache-hit %
const COL_REQ: Rems = LANE_STATUS; // request count
const COL_COST: Rems = LANE_DURATION; // dollar cost

impl AppRoot {
    pub(crate) fn render_usage(
        &mut self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        // The usage store is a JSON file — read it once on the UI runtime,
        // then serve renders from `usage_cache` (refreshed by the poll).
        if self.usage_cache.is_none() && !self.usage_loading {
            self.usage_loading = true;
            let service = self.service.clone();
            let svc = service.clone();
            let handle = service.spawn_ui(async move {
                svc.usage_store()
                    .read(&gateway_core::usage_store::UsageReadOptions::default())
            });
            cx.spawn(async move |this, cx| {
                let detail = handle.await;
                let _ = this.update(cx, |this, cx| {
                    this.usage_loading = false;
                    // On a join failure, land on an empty store rather than
                    // re-spawning the load on every animation frame.
                    this.usage_cache =
                        Some(
                            detail.unwrap_or_else(|_| gateway_core::usage_store::UsageDetail {
                                summary: Default::default(),
                                daily: Vec::new(),
                            }),
                        );
                    cx.notify();
                });
            })
            .detach();
        }
        let Some(detail) = self.usage_cache.as_ref() else {
            // First paint — skeleton the stat row and the table so the page
            // arrives shaped like the final content.
            let stat_skel = card(cx).child(h_flex().gap_0().children((0..5).map(|_| {
                v_flex()
                    .flex_1()
                    .gap_1p5()
                    .px_4()
                    .py_3()
                    .child(
                        Skeleton::new()
                            .secondary()
                            .w(relative(0.5))
                            .h_2p5()
                            .rounded_sm(),
                    )
                    .child(Skeleton::new().w(relative(0.7)).h_4().rounded_sm())
                    .into_any_element()
            })));
            return v_flex()
                .h_full()
                .min_h_0()
                .gap_4()
                .child(div().flex_none().child(stat_skel))
                .child(div().flex_1().min_h_0().child(skeleton_rows(8, cx)))
                .into_any_element();
        };
        let sum = &detail.summary;
        let cost = |c: Option<f64>| c.map(|v| format!("${v:.4}")).unwrap_or_else(|| "—".into());
        // Cache-hit rate = read share of input-side tokens; None on zero
        // traffic, rendered as an em-dash.
        let hit_rate = |input: i64, read: i64, write: i64| -> Option<f64> {
            let denom = input + read + write;
            (denom > 0).then(|| read as f64 / denom as f64)
        };
        let hit_pct = |r: Option<f64>| {
            r.map(|r| format!("{:.0}%", r * 100.))
                .unwrap_or_else(|| "—".into())
        };

        // ---- summary: two labeled clusters inside one card ----
        // pop_in keys the animation by the value, so a changed number
        // replays the rise+fade on the next poll refresh.
        let stat = |label: &str, value: String| {
            v_flex()
                .gap_1()
                .child(pop_in(
                    div().child(
                        Label::new(value.clone())
                            .font_family(MONO)
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    ),
                    format!("usage-{label}-{value}"),
                ))
                .child(
                    Label::new(label)
                        .text_xs()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element()
        };
        let group = |title: &str, cells: Vec<AnyElement>| {
            v_flex()
                .gap_2()
                .child(
                    Label::new(title)
                        .text_xs()
                        .font_semibold()
                        .text_color(theme.secondary_foreground),
                )
                .child(h_flex().gap_6().children(cells))
        };
        // The summary only carries today's cache lanes — fold the window
        // for the 30-day rate.
        let (mut in30, mut cr30, mut cw30) = (0_i64, 0_i64, 0_i64);
        for e in &detail.daily {
            in30 += e.input_tokens;
            cr30 += e.cache_read_tokens;
            cw30 += e.cache_write5m_tokens + e.cache_write1h_tokens;
        }
        let stats = card(cx).px_4().py_3().child(
            h_flex()
                .gap_8()
                .child(group(
                    t(lang, "usage_today"),
                    vec![
                        stat(t(lang, "col_tokens"), fmt_count(sum.today_tokens)),
                        stat(t(lang, "col_req"), fmt_count(sum.today_requests)),
                        stat(t(lang, "col_cost"), cost(sum.today_cost_usd)),
                        stat(
                            t(lang, "usage_hit"),
                            hit_pct(hit_rate(
                                sum.today_input_tokens,
                                sum.today_cache_read_tokens,
                                sum.today_cache_write_tokens,
                            )),
                        ),
                    ],
                ))
                .child(hairline(cx).h_full())
                .child(group(
                    t(lang, "usage_30d"),
                    vec![
                        stat(t(lang, "col_tokens"), fmt_count(sum.last30days_tokens)),
                        stat(t(lang, "col_cost"), cost(sum.last30days_cost_usd)),
                        stat(t(lang, "usage_hit"), hit_pct(hit_rate(in30, cr30, cw30))),
                    ],
                )),
        );

        // Breakdown axes — 0 provider, 1 model, 2 day. `usage_drill`
        // carries (axis, key) when a row is opened.
        fn key_of(e: &gateway_core::usage_store::UsageDailyEntry, dim: usize) -> String {
            match dim {
                0 => e.provider.clone().unwrap_or_else(|| "?".into()),
                1 => e.model.clone(),
                _ => e.date.clone(),
            }
        }
        let drill = self.usage_drill.clone();

        // ---- daily tokens chart ----
        // Same per-day totals the "by day" view reports, drawn as a 30-day
        // bar strip so the trend is visible at a glance. Missing days get
        // zero-height bars so the window reads as one continuous span. A
        // provider/model drill scopes the strip to that entity; a day drill
        // keeps the global shape (a single bar would say nothing).
        let mut day_totals: std::collections::HashMap<String, i64> =
            std::collections::HashMap::new();
        for e in &detail.daily {
            if let Some((dim, key)) = &drill {
                if *dim < 2 && key_of(e, *dim) != *key {
                    continue;
                }
            }
            *day_totals.entry(e.date.clone()).or_default() += e.input_tokens + e.output_tokens;
        }
        let today = chrono::Local::now().date_naive();
        // The built-in tooltip prints raw values — feed it a scaled series so
        // hover reads "26.61" under a "Tokens (M)" label instead of eight
        // raw digits. The divisor follows the window's largest day.
        let max_tok = day_totals.values().copied().max().unwrap_or(0) as f64;
        let (unit, divisor) = if max_tok >= 1e9 {
            ("B", 1e9)
        } else if max_tok >= 1e6 {
            ("M", 1e6)
        } else if max_tok >= 1e3 {
            ("k", 1e3)
        } else {
            ("", 1.)
        };
        let series: Vec<(String, f64)> = (0..30_i64)
            .rev()
            .map(|i| {
                let date = (today - chrono::Duration::days(i))
                    .format("%Y-%m-%d")
                    .to_string();
                let scaled = *day_totals.get(&date).unwrap_or(&0) as f64 / divisor;
                (date, (scaled * 100.).round() / 100.)
            })
            .collect();
        let series_name = if unit.is_empty() {
            t(lang, "col_tokens").to_string()
        } else {
            format!("{} ({})", t(lang, "col_tokens"), unit)
        };
        let chart = card(cx).px_4().py_3().child(
            v_flex()
                .gap_2()
                .child(
                    Label::new(t(lang, "usage_chart"))
                        .text_xs()
                        .font_semibold()
                        .text_color(theme.secondary_foreground),
                )
                .child(
                    div().h(CHART_H).child(
                        gpui_kit::component::chart::BarChart::new(series)
                            .id("usage-tokens-chart")
                            .name(series_name)
                            .band(|(d, _)| d[5..].to_string())
                            .value(|(_, v)| *v)
                            .tick_margin(5)
                            // No value axis — token counts render as
                            // unreadable 8-digit ticks; the hover tooltip
                            // carries the exact number instead.
                            .grid(false),
                    ),
                ),
        );

        // ---- aggregated breakdown ----
        // The store keeps date × account × model rows — far too fine to
        // scan. Collapse along one axis, and let a row drill into the
        // complementary cut: provider/model rows open that entity's daily
        // log, a day row opens that day's provider/model split.
        #[derive(Default)]
        struct UsageAgg {
            input: i64,
            output: i64,
            cache_read: i64,
            cache_write: i64,
            requests: i64,
            cost: f64,
            has_cost: bool,
        }
        impl UsageAgg {
            fn add(&mut self, e: &gateway_core::usage_store::UsageDailyEntry) {
                self.input += e.input_tokens;
                self.output += e.output_tokens;
                self.cache_read += e.cache_read_tokens;
                self.cache_write += e.cache_write5m_tokens + e.cache_write1h_tokens;
                self.requests += e.requests;
                if let Some(c) = e.cost_usd {
                    self.cost += c;
                    self.has_cost = true;
                }
            }
        }

        // Effective grouping for the table: an open drill flips to the
        // complementary axis — provider/model → that entity's daily log,
        // a day → that day's provider/model pairs.
        let (group_dim, combined) = match &drill {
            Some((0 | 1, _)) => (2, false),
            Some(_) => (1, true),
            None => (self.usage_view, false),
        };
        let mut groups: std::collections::HashMap<String, UsageAgg> =
            std::collections::HashMap::new();
        for e in &detail.daily {
            if let Some((dim, key)) = &drill {
                if key_of(e, *dim) != *key {
                    continue;
                }
            }
            let key = if combined {
                format!(
                    "{}/{}",
                    e.provider.clone().unwrap_or_else(|| "?".into()),
                    e.model
                )
            } else {
                key_of(e, group_dim)
            };
            groups.entry(key).or_default().add(e);
        }
        let mut rows: Vec<(String, UsageAgg)> = groups.into_iter().collect();
        // Day-grouped rows read newest-first; entity rows rank by tokens.
        if group_dim == 2 {
            rows.sort_by(|a, b| b.0.cmp(&a.0));
        } else {
            rows.sort_by(|a, b| (b.1.input + b.1.output).cmp(&(a.1.input + a.1.output)));
        }
        let rows = Rc::new(rows);
        let total = rows.len();

        // Column geometry is shared by the header row and every data row,
        // so the header stays aligned with the virtualized rows below it.
        let head_cell = |text: &str, w: Option<Rems>| {
            let label = Label::new(text)
                .text_xs()
                .text_color(theme.muted_foreground);
            match w {
                Some(w) => div().w(w).flex_none().child(label),
                None => div().flex_1().min_w_0().child(label),
            }
        };
        let head_key = if combined {
            "col_provider_model"
        } else {
            ["col_provider", "col_model", "col_date"][group_dim]
        };
        let header = h_flex()
            .items_center()
            .gap_3()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .child(head_cell(t(lang, head_key), None))
            .child(head_cell(t(lang, "col_in"), Some(COL_TOKENS)))
            .child(head_cell(t(lang, "col_out"), Some(COL_TOKENS)))
            .child(head_cell(t(lang, "col_cache"), Some(COL_CACHE)))
            .child(head_cell(t(lang, "col_req"), Some(COL_REQ)))
            .child(head_cell(t(lang, "col_cost"), Some(COL_COST)));

        let theme_for_rows = theme.clone();
        let row_height = ROW_H;
        let drillable = drill.is_none();
        let view = cx.entity().clone();
        let drill_dim = self.usage_view;
        let render_row = move |ix: usize, _window: &mut Window, _app: &mut App| -> AnyElement {
            let (label, e) = &rows[ix];
            let cell = |text: String, w: Rems, color: Hsla| {
                div().w(w).flex_none().child(
                    Label::new(text)
                        .font_family(MONO)
                        .text_xs()
                        .text_color(color),
                )
            };
            let row = h_flex()
                .w_full()
                .h(row_height)
                .items_center()
                .gap_3()
                .px_4()
                .child(
                    div().flex_1().min_w_0().child(
                        Label::new(label.clone())
                            .text_xs()
                            .text_color(theme_for_rows.foreground)
                            .truncate(),
                    ),
                )
                .child(cell(
                    fmt_count(e.input),
                    COL_TOKENS,
                    theme_for_rows.secondary_foreground,
                ))
                .child(cell(
                    fmt_count(e.output),
                    COL_TOKENS,
                    theme_for_rows.secondary_foreground,
                ))
                .child(cell(
                    hit_pct(hit_rate(e.input, e.cache_read, e.cache_write)),
                    COL_CACHE,
                    theme_for_rows.secondary_foreground,
                ))
                .child(cell(
                    fmt_count(e.requests),
                    COL_REQ,
                    theme_for_rows.secondary_foreground,
                ))
                .child(cell(
                    if e.has_cost {
                        format!("${:.4}", e.cost)
                    } else {
                        "—".into()
                    },
                    COL_COST,
                    theme_for_rows.foreground,
                ));
            if drillable {
                let key = label.clone();
                let view = view.clone();
                row.id(SharedString::from(format!("usage-row-{key}")))
                    .cursor_pointer()
                    .hover(|d| d.bg(theme_for_rows.list_hover))
                    .on_click(move |_, _, cx| {
                        view.update(cx, |this, cx| {
                            this.usage_drill = Some((drill_dim, key.clone()));
                            cx.notify();
                        });
                    })
                    .into_any_element()
            } else {
                row.into_any_element()
            }
        };

        let table: AnyElement = if total == 0 {
            card(cx)
                .py_6()
                .flex()
                .justify_center()
                .child(
                    Label::new(t(lang, "no_usage"))
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element()
        } else {
            // Header rides inside the card (single surface, single border);
            // the hairline under it separates it from the virtualized rows.
            div()
                .flex_1()
                .min_h_0()
                .child(card(cx).h_full().overflow_hidden().child(
                    v_flex().h_full().min_h_0().child(header).child(
                        div().flex_1().min_h_0().child(card_uniform_list(
                            "usage-list",
                            total,
                            &self.usage_scroll,
                            render_row,
                            cx,
                        )),
                    ),
                ))
                .into_any_element()
        };

        v_flex()
            .h_full()
            .min_h_0()
            .gap_4()
            .child(div().flex_none().child(stats))
            .child(div().flex_none().child(chart))
            .child(
                v_flex()
                    .h_full()
                    .min_h_0()
                    .gap_2()
                    .child(div().flex_none().child(section_header(
                        t(lang, "usage_breakdown"),
                        Some(if let Some((_, key)) = &drill {
                            // Drilled state: back button + the opened
                            // key replace the axis picker.
                            h_flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    gpui_kit::component::button::Button::new("usage-back")
                                        .ghost()
                                        .small()
                                        .icon(gpui_kit::assets::IconName::ArrowLeft)
                                        .tooltip(t(lang, "back"))
                                        .on_click(cx.listener(|this, _, _w, cx| {
                                            this.usage_drill = None;
                                            cx.notify();
                                        })),
                                )
                                .child(
                                    Label::new(key.clone())
                                        .text_xs()
                                        .font_medium()
                                        .text_color(theme.secondary_foreground),
                                )
                                .into_any_element()
                        } else {
                            toggle_filter(
                                "usage-view",
                                vec![
                                    (t(lang, "usage_by_provider").into(), self.usage_view == 0),
                                    (t(lang, "usage_by_model").into(), self.usage_view == 1),
                                    (t(lang, "usage_by_day").into(), self.usage_view == 2),
                                ],
                                cx.processor(|this, ix, _w, cx| {
                                    this.usage_view = ix;
                                    this.usage_drill = None;
                                    cx.notify();
                                }),
                                cx,
                            )
                            .into_any_element()
                        }),
                        cx,
                    )))
                    .child(table),
            )
            .into_any_element()
    }
}
