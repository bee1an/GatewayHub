//! Playground — chat through the in-process registry.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::component::{
    ActiveTheme, IconName, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::AppRoot;

impl AppRoot {
    pub(crate) fn render_playground(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();

        let mut log = v_flex().gap_2().p_4();
        if self.pg_log.is_empty() {
            log = log.child(
                div().p_4().child(
                    Label::new("Send a chat request through the gateway — no HTTP server or API key needed")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for (role, text) in &self.pg_log {
            let is_you = role.as_ref() == "you";
            log = log.child(
                v_flex()
                    .p_3()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(theme.border)
                    .bg(if is_you {
                        theme.accent
                    } else {
                        theme.muted.opacity(0.35)
                    })
                    .child(
                        Label::new(role.to_string())
                            .text_xs()
                            .font_semibold()
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        Label::new(text.to_string())
                            .text_sm()
                            .text_color(theme.foreground),
                    ),
            );
        }
        if self.pg_pending.is_some() {
            log = log.child(
                div()
                    .p_3()
                    .child(Label::new("…").text_sm().text_color(theme.muted_foreground)),
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
                        Label::new("Playground")
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(div().w(px(280.)).child(Input::new(&self.pg_model_input))),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("pg-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(log),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                h_flex()
                    .p_4()
                    .gap_2()
                    .items_center()
                    .child(div().flex_1().child(Input::new(&self.pg_msg_input)))
                    .child(
                        Button::new("pg-send")
                            .primary()
                            .small()
                            .label("Send")
                            .icon(IconName::ArrowRight)
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.playground_send(window, cx);
                            })),
                    ),
            )
            .into_any_element()
    }
}
