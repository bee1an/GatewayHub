//! Model mappings — alias → provider/model table.

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
    pub(crate) fn render_mappings(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let cfg = self.service.config();

        let mut rows = v_flex().gap_1p5().p_4();
        if cfg.model_mappings.is_empty() {
            rows = rows.child(
                div().p_4().child(
                    Label::new("No mappings — model names pass through to the provider unchanged")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for (ix, m) in cfg.model_mappings.iter().enumerate() {
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
                                Label::new(m.alias.clone())
                                    .text_sm()
                                    .font_medium()
                                    .text_color(theme.foreground),
                            )
                            .child(
                                Label::new(format!("→ {}/{}", m.provider, m.model))
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            ),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new(SharedString::from(format!("maptog-{ix}")))
                            .outline()
                            .small()
                            .label(if m.enabled { "Disable" } else { "Enable" })
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.toggle_mapping(ix, cx);
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("mapdel-{ix}")))
                            .danger()
                            .small()
                            .label("Delete")
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.delete_mapping(ix, cx);
                            })),
                    ),
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
                        Label::new("Model Mappings")
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(div().w(px(160.)).child(Input::new(&self.map_alias_input)))
                    .child(div().w(px(240.)).child(Input::new(&self.map_target_input)))
                    .child(
                        Button::new("add-map")
                            .primary()
                            .small()
                            .label("Add")
                            .icon(IconName::Plus)
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.add_mapping(cx);
                            })),
                    ),
            )
            .child(div().mx_4().h_px().bg(theme.border))
            .child(
                v_flex()
                    .id("mappings-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(rows),
            )
            .into_any_element()
    }
}
