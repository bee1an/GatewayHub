//! Logs — gateway request/error log tail.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::component::{ActiveTheme, h_flex, label::Label, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::AppRoot;

impl AppRoot {
    pub(crate) fn render_logs(
        &self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
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
}
