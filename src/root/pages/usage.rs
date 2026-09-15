//! Usage — today/30-day totals + daily breakdown.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::component::{ActiveTheme, StyledExt, h_flex, label::Label, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::AppRoot;

impl AppRoot {
    pub(crate) fn render_usage(
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
}
