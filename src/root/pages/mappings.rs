//! Model mappings — alias → provider/model rows with add/enable/delete.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Icon, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{AppRoot, MONO, card, card_rows, page_header, row, section_header, t, tf};

impl AppRoot {
    pub(crate) fn render_mappings(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        let cfg = self.service.config();

        let mut map_rows: Vec<AnyElement> = Vec::new();
        for (ix, m) in cfg.model_mappings.iter().enumerate() {
            let m_alias = m.alias.clone();
            let m_provider = m.provider.clone();
            let m_model = m.model.clone();
            map_rows.push(
                row()
                    .child(
                        h_flex()
                            .flex_1()
                            .min_w_0()
                            .items_center()
                            .gap_3()
                            .child(
                                Label::new(m.alias.clone())
                                    .text_sm()
                                    .font_medium()
                                    .text_color(if m.enabled {
                                        theme.foreground
                                    } else {
                                        theme.muted_foreground
                                    }),
                            )
                            .child(
                                Icon::new(IconName::ArrowRight)
                                    .size_3p5()
                                    .text_color(theme.muted_foreground),
                            )
                            .child(
                                Label::new(format!("{}/{}", m.provider, m.model))
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.secondary_foreground)
                                    .truncate(),
                            ),
                    )
                    .child(
                        Button::new(SharedString::from(format!("maptog-{ix}")))
                            .ghost()
                            .xsmall()
                            .label(t(lang, if m.enabled { "disable" } else { "enable" }))
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.toggle_mapping(ix, cx);
                            })),
                    )
                    .child(
                        Button::new(SharedString::from(format!("mapdel-{ix}")))
                            .ghost()
                            .xsmall()
                            .label(t(lang, "delete"))
                            .on_click(cx.listener(move |this, e: &ClickEvent, _w, cx| {
                                let desc = tf(
                                    this.lang,
                                    "delete_mapping_desc",
                                    &[
                                        ("alias", &m_alias),
                                        ("target", &format!("{}/{}", m_provider, m_model)),
                                    ],
                                );
                                this.confirm(
                                    t(this.lang, "delete_mapping_title"),
                                    desc,
                                    "delete",
                                    Some(e.position()),
                                    cx,
                                    move |this, cx| this.delete_mapping(ix, cx),
                                );
                            })),
                    )
                    .into_any_element(),
            );
        }

        let maps_card = if cfg.model_mappings.is_empty() {
            card(cx)
                .p_4()
                .child(
                    Label::new(t(lang, "no_mappings"))
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element()
        } else {
            card_rows(map_rows, cx)
        };

        v_flex()
            .gap_4()
            .child(page_header(
                t(lang, "mappings_title"),
                t(lang, "mappings_desc"),
                None,
                cx,
            ))
            .child(
                card(cx).p_3().child(
                    h_flex()
                        .items_center()
                        .gap_2()
                        .child(
                            div()
                                .w(px(160.))
                                .child(Input::new(&self.map_alias_input).small()),
                        )
                        .child(
                            div()
                                .flex_1()
                                .min_w_0()
                                .child(Input::new(&self.map_target_input).small()),
                        )
                        .child(
                            Button::new("add-map")
                                .primary()
                                .small()
                                .label(t(lang, "add"))
                                .icon(IconName::Plus)
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.add_mapping(cx);
                                })),
                        ),
                ),
            )
            .child(
                v_flex()
                    .gap_2()
                    .child(section_header(
                        tf(
                            lang,
                            "n_mappings",
                            &[("n", &cfg.model_mappings.len().to_string())],
                        ),
                        None,
                        cx,
                    ))
                    .child(maps_card),
            )
            .into_any_element()
    }
}
