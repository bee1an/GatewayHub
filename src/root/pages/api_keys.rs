//! API keys — generate, list, delete gateway keys.

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
    pub(crate) fn render_api_keys(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let cfg = self.service.config();

        let mut rows = v_flex().gap_1p5().p_4();
        if cfg.server.api_keys.is_empty() {
            rows = rows.child(
                div().p_4().child(
                    Label::new("No API keys — the gateway rejects every request until one exists")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for k in &cfg.server.api_keys {
            let masked = if k.key.len() > 10 {
                format!("{}…{}", &k.key[..6], &k.key[k.key.len() - 4..])
            } else {
                "•••".into()
            };
            let id = k.id.clone();
            rows = rows.child(
                h_flex()
                    .items_center()
                    .gap_3()
                    .p_3()
                    .rounded(theme.radius)
                    .border_1()
                    .border_color(theme.border)
                    .bg(theme.muted.opacity(0.35))
                    .child(
                        v_flex()
                            .child(
                                Label::new(k.name.clone())
                                    .text_sm()
                                    .font_medium()
                                    .text_color(theme.foreground),
                            )
                            .child(
                                Label::new(masked)
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            ),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new(SharedString::from(format!("delkey-{}", k.id)))
                            .danger()
                            .small()
                            .label("Delete")
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.delete_api_key(&id, cx);
                            })),
                    ),
            );
        }

        let mut page = v_flex()
            .flex_1()
            .min_h_0()
            .child(
                h_flex()
                    .p_4()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("API Keys")
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(div().w(px(220.)).child(Input::new(&self.key_name_input)))
                    .child(
                        Button::new("gen-key")
                            .primary()
                            .small()
                            .label("Generate")
                            .icon(IconName::Plus)
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.add_api_key(cx);
                            })),
                    ),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("apikeys-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(rows),
            );
        if let Some(key) = &self.new_key {
            let shown = key.clone();
            page = page.child(
                h_flex()
                    .p_3()
                    .mx_4()
                    .mb_4()
                    .rounded(theme.radius)
                    .bg(theme.accent)
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new(format!("New key (copy now — shown once): {shown}"))
                            .text_xs()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("dismiss-key")
                            .ghost()
                            .small()
                            .label("Dismiss")
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.new_key = None;
                                cx.notify();
                            })),
                    ),
            );
        }
        page.into_any_element()
    }
}
