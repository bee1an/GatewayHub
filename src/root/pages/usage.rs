//! Usage — summary stat row + virtualized daily/provider breakdown table.

use std::rc::Rc;

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::component::{
    ActiveTheme, StyledExt, h_flex, label::Label, skeleton::Skeleton, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, MONO, card, card_uniform_list, hairline, page_header, pop_in, section_header,
    skeleton_rows, t,
};

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
                            .rounded(px(3.)),
                    )
                    .child(Skeleton::new().w(relative(0.7)).h_4().rounded(px(3.)))
                    .into_any_element()
            })));
            return v_flex()
                .h_full()
                .min_h_0()
                .gap_4()
                .child(
                    div()
                        .flex_none()
                        .child(page_header(t(lang, "usage_title"), "", None, cx)),
                )
                .child(div().flex_none().child(stat_skel))
                .child(div().flex_1().min_h_0().child(skeleton_rows(8, cx)))
                .into_any_element();
        };
        let sum = &detail.summary;
        let cost = |c: Option<f64>| c.map(|v| format!("${v:.4}")).unwrap_or_else(|| "—".into());

        // ---- summary: 5 stat cells inside one card ----
        // pop_in keys the animation by the value, so a changed number
        // replays the rise+fade on the next poll refresh.
        let stat = |id: &str, label: &str, value: String| {
            v_flex()
                .flex_1()
                .gap_1()
                .px_4()
                .py_3()
                .child(
                    Label::new(label)
                        .text_xs()
                        .text_color(theme.muted_foreground),
                )
                .child(pop_in(
                    div().child(
                        Label::new(value.clone())
                            .font_family(MONO)
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    ),
                    format!("usage-{id}-{value}"),
                ))
        };
        let stats = card(cx).child(
            h_flex()
                .gap_0()
                .child(stat(
                    "tt",
                    t(lang, "today_tokens"),
                    format!("{}", sum.today_tokens),
                ))
                .child(hairline(cx).h_full())
                .child(stat(
                    "tr",
                    t(lang, "today_requests"),
                    format!("{}", sum.today_requests),
                ))
                .child(hairline(cx).h_full())
                .child(stat("tc", t(lang, "today_cost"), cost(sum.today_cost_usd)))
                .child(hairline(cx).h_full())
                .child(stat(
                    "t30",
                    t(lang, "tokens_30d"),
                    format!("{}", sum.last30days_tokens),
                ))
                .child(hairline(cx).h_full())
                .child(stat(
                    "c30",
                    t(lang, "cost_30d"),
                    cost(sum.last30days_cost_usd),
                )),
        );

        // ---- breakdown table ----
        // Column geometry is shared by the header row and every data row
        // (same px_4 / gap_3 / fixed lanes), so the header stays aligned
        // with the virtualized rows below it.
        let head_cell = |text: &str, w: Option<f32>| {
            let label = Label::new(text)
                .text_xs()
                .text_color(theme.muted_foreground);
            match w {
                Some(w) => div().w(px(w)).flex_none().child(label),
                None => div().flex_1().min_w_0().child(label),
            }
        };
        let header = h_flex()
            .items_center()
            .gap_3()
            .px_4()
            .py_2()
            .border_b_1()
            .border_color(theme.border)
            .child(head_cell(t(lang, "col_date"), Some(80.)))
            .child(head_cell(t(lang, "col_provider_model"), None))
            .child(head_cell(t(lang, "col_in"), Some(72.)))
            .child(head_cell(t(lang, "col_out"), Some(72.)))
            .child(head_cell(t(lang, "col_req"), Some(56.)))
            .child(head_cell(t(lang, "col_cost"), Some(72.)));

        let daily: Rc<Vec<gateway_core::usage_store::UsageDailyEntry>> =
            Rc::new(detail.daily.clone());
        let total = daily.len();

        let theme_for_rows = theme.clone();
        let row_height = px(30.);
        let render_row = move |ix: usize, _window: &mut Window, _app: &mut App| -> AnyElement {
            let e = &daily[ix];
            let cell = |text: String, w: f32, color: Hsla| {
                div().w(px(w)).flex_none().child(
                    Label::new(text)
                        .font_family(MONO)
                        .text_xs()
                        .text_color(color),
                )
            };
            h_flex()
                .w_full()
                .h(row_height)
                .items_center()
                .gap_3()
                .px_4()
                .child(cell(
                    e.date.clone(),
                    80.,
                    theme_for_rows.secondary_foreground,
                ))
                .child(
                    div().flex_1().min_w_0().child(
                        Label::new(format!(
                            "{}/{}",
                            e.provider.clone().unwrap_or_default(),
                            e.model
                        ))
                        .text_xs()
                        .text_color(theme_for_rows.foreground)
                        .truncate(),
                    ),
                )
                .child(cell(
                    format!("{}", e.input_tokens),
                    72.,
                    theme_for_rows.secondary_foreground,
                ))
                .child(cell(
                    format!("{}", e.output_tokens),
                    72.,
                    theme_for_rows.secondary_foreground,
                ))
                .child(cell(
                    format!("{}", e.requests),
                    56.,
                    theme_for_rows.secondary_foreground,
                ))
                .child(cell(cost(e.cost_usd), 72., theme_for_rows.foreground))
                .into_any_element()
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
            .child(
                div()
                    .flex_none()
                    .child(page_header(t(lang, "usage_title"), "", None, cx)),
            )
            .child(div().flex_none().child(stats))
            .child(
                v_flex()
                    .h_full()
                    .min_h_0()
                    .gap_2()
                    .child(div().flex_none().child(section_header(
                        t(lang, "daily_breakdown"),
                        None,
                        cx,
                    )))
                    .child(table),
            )
            .into_any_element()
    }
}
