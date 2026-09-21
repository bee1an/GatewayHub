//! Model mappings — alias → ordered provider/model failover targets. Rows
//! and the header action open the add/edit overlay; no inline form on the
//! page itself.

use std::rc::Rc;

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    scroll::ScrollableElement,
    select::Select,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, DIALOG_W_LG, MENU_W_MD, MENU_W_SM, MONO, OverlayRequest, SCROLL_H_LG, card, card_rows,
    row, section_header, t, tf,
};

impl AppRoot {
    /// Open the add/edit mapping overlay — `Some(ix)` pre-fills from
    /// `model_mappings[ix]`, `None` starts a blank one-target form.
    pub(crate) fn open_mapping_overlay(
        &mut self,
        editing: Option<usize>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let lang = self.lang;
        let cfg = self.service.config();
        let editing = editing.filter(|&ix| ix < cfg.model_mappings.len());
        self.map_editing = editing;
        self.map_err = None;

        let (alias, targets) = editing
            .and_then(|ix| cfg.model_mappings.get(ix))
            .map(|m| (m.alias.clone(), m.targets()))
            .unwrap_or_default();
        self.map_alias_input.update(cx, |input, cx| {
            input.set_value(alias, window, cx);
        });
        self.map_target_rows.clear();
        for t in &targets {
            self.push_map_target_row(t.provider.clone(), t.model.clone(), window, cx);
        }
        if self.map_target_rows.is_empty() {
            self.push_map_target_row(String::new(), String::new(), window, cx);
        }

        let title = if editing.is_some() {
            t(lang, "edit_mapping")
        } else {
            t(lang, "add_mapping")
        };
        self.open_overlay(
            OverlayRequest {
                title: title.into(),
                width: DIALOG_W_LG,
                content: Some(Rc::new(|root, w, cx| mapping_overlay_body(root, w, cx))),
                footer: Some(Rc::new(|root, _w, cx| {
                    let lang = root.lang;
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("map-cancel")
                                .outline()
                                .small()
                                .label(t(lang, "cancel"))
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.dismiss_overlay(cx);
                                })),
                        )
                        .child(
                            Button::new("map-save")
                                .primary()
                                .small()
                                .label(t(lang, "save"))
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.save_mapping_overlay(cx);
                                })),
                        )
                        .into_any_element()
                })),
                ..OverlayRequest::default()
            },
            cx,
        );
    }

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
            let m_targets = m
                .targets()
                .iter()
                .map(|t| format!("{}/{}", t.provider, t.model))
                .collect::<Vec<_>>()
                .join(" → ");
            map_rows.push(
                row()
                    .id(SharedString::from(format!("map-row-{ix}")))
                    // Whole-row click opens the edit overlay — buttons inside
                    // stop propagation (same contract as the accounts rows).
                    .cursor_pointer()
                    .hover(|d| d.bg(theme.list_hover))
                    .on_click(cx.listener(move |this, _e: &ClickEvent, w, cx| {
                        this.open_mapping_overlay(Some(ix), w, cx);
                    }))
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
                                Label::new(m_targets.clone())
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.secondary_foreground)
                                    .truncate(),
                            ),
                    )
                    .child(
                        // Button clicks bubble — gpui-component only stops
                        // propagation while `loading` — so without this
                        // wrapper every action would also fire the row's
                        // edit-overlay handler.
                        h_flex()
                            .id(SharedString::from(format!("map-actions-{ix}")))
                            .items_center()
                            .gap_1()
                            .on_click(|_, _, cx| cx.stop_propagation())
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
                                    .danger()
                                    .label(t(lang, "delete"))
                                    .on_click(cx.listener(move |this, _e: &ClickEvent, _w, cx| {
                                        let desc = tf(
                                            this.lang,
                                            "delete_mapping_desc",
                                            &[("alias", &m_alias), ("target", &m_targets)],
                                        );
                                        this.confirm(
                                            t(this.lang, "delete_mapping_title"),
                                            desc,
                                            "delete",
                                            cx,
                                            move |this, cx| this.delete_mapping(ix, cx),
                                        );
                                    })),
                            ),
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
            .child(
                v_flex()
                    .gap_2()
                    .child(section_header(
                        tf(
                            lang,
                            "n_mappings",
                            &[("n", &cfg.model_mappings.len().to_string())],
                        ),
                        Some(
                            Button::new("add-mapping")
                                .outline()
                                .small()
                                .icon(IconName::Plus)
                                .label(t(lang, "add_mapping"))
                                .on_click(cx.listener(|this, _e: &ClickEvent, w, cx| {
                                    this.open_mapping_overlay(None, w, cx);
                                }))
                                .into_any_element(),
                        ),
                        cx,
                    ))
                    .child(maps_card),
            )
            .into_any_element()
    }
}

/// Mapping overlay body — alias field plus editable (provider, model)
/// target rows; at least one row stays so a mapping is never targetless.
fn mapping_overlay_body(
    root: &AppRoot,
    _window: &mut Window,
    cx: &mut Context<AppRoot>,
) -> AnyElement {
    let theme = cx.theme().clone();
    let lang = root.lang;

    let row_count = root.map_target_rows.len();
    let mut rows = v_flex().gap_2();
    for (ix, row) in root.map_target_rows.iter().enumerate() {
        rows = rows.child(
            h_flex()
                .items_center()
                .gap_2()
                .child(
                    div().flex_1().min_w_0().child(
                        Select::new(&row.provider)
                            .small()
                            .menu_width(MENU_W_SM)
                            .placeholder(t(lang, "ph_provider")),
                    ),
                )
                .child(Label::new("/").text_sm().text_color(theme.muted_foreground))
                .child(
                    div().flex_1().min_w_0().child(
                        Select::new(&row.model)
                            .small()
                            .menu_width(MENU_W_MD)
                            .placeholder(t(lang, "ph_model")),
                    ),
                )
                .child(
                    Button::new(SharedString::from(format!("map-row-del-{ix}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::Close)
                        // Keep at least one row — a mapping with zero targets
                        // would be rejected on save anyway.
                        .disabled(row_count <= 1)
                        .on_click(cx.listener(move |this, _, _w, cx| {
                            if this.map_target_rows.len() > 1 {
                                this.map_target_rows.remove(ix);
                            }
                            cx.notify();
                        })),
                ),
        );
    }

    v_flex()
        .gap_3()
        .child(
            v_flex()
                .gap_1p5()
                .child(
                    Label::new(t(lang, "map_alias"))
                        .text_xs()
                        .font_medium()
                        .text_color(theme.secondary_foreground),
                )
                .child(Input::new(&root.map_alias_input)),
        )
        .child(
            v_flex()
                .gap_1p5()
                .child(
                    Label::new(t(lang, "map_targets"))
                        .text_xs()
                        .font_medium()
                        .text_color(theme.secondary_foreground),
                )
                .child(
                    div()
                        .relative()
                        .child(
                            div()
                                .id("map-target-rows")
                                .max_h(SCROLL_H_LG)
                                // p_1 keeps the focus ring of the inner
                                // inputs inside the clip region instead of
                                // half-cropping it.
                                .p_1()
                                .overflow_y_scroll()
                                .track_scroll(&root.map_scroll)
                                .child(rows),
                        )
                        .vertical_scrollbar(&root.map_scroll),
                )
                .child(
                    Button::new("map-add-target")
                        .ghost()
                        .small()
                        .icon(IconName::Plus)
                        .label(t(lang, "add_target"))
                        .on_click(cx.listener(|this, _, w, cx| {
                            this.push_map_target_row(String::new(), String::new(), w, cx);
                            cx.notify();
                        })),
                ),
        )
        .when_some(root.map_err.clone(), |d, e| {
            d.child(
                Label::new(e)
                    .text_xs()
                    .text_color(theme.danger)
                    .whitespace_normal(),
            )
        })
        .into_any_element()
}
