//! Playground — real requests through the running gateway server. Exercises
//! the actual auth/scope/protocol path: model + API-key pickers, streaming
//! SSE, multi-turn history, per-message retry, markdown replies.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Sizable, Size, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Textarea,
    label::Label,
    searchable_list::SearchableVec,
    select::Select,
    spinner::Spinner,
    text::TextView,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{AppRoot, MONO, PgKeyItem, PgMsg, PgRole, card, page_header, t};

/// Models + key select contents change with the snapshot — pushed into the
/// SelectState entities here, and a sane default is picked when the current
/// selection disappears.
fn sync_pg_selects(
    this: &mut AppRoot,
    snapshot: &GatewayStatusSnapshot,
    window: &mut Window,
    cx: &mut Context<AppRoot>,
) {
    // Aliases first, then every provider's models as `route/model`.
    let cfg = this.service.config();
    let mut models: Vec<String> = cfg
        .model_mappings
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.alias.clone())
        .collect();
    for p in &snapshot.providers {
        if !p.enabled || !p.configured {
            continue;
        }
        for m in &p.models {
            models.push(format!("{}/{m}", p.name));
        }
    }
    models.dedup();
    if models != this.pg_model_items {
        let keep = this
            .pg_model_sel
            .read(cx)
            .selected_value()
            .cloned()
            .filter(|v| models.contains(v));
        this.pg_model_items = models.clone();
        this.pg_model_sel.update(cx, |s, cx| {
            s.set_items(SearchableVec::new(models.clone()), window, cx);
            if let Some(v) = keep.or_else(|| models.first().cloned()) {
                s.set_selected_value(&v, window, cx);
            }
        });
    }

    let now = chrono::Utc::now().timestamp_millis();
    let keys: Vec<PgKeyItem> = cfg
        .server
        .api_keys
        .iter()
        .filter(|k| k.expires_at.is_none_or(|e| e > now))
        .map(|k| PgKeyItem {
            id: k.id.clone(),
            label: if k.name.is_empty() {
                format!(
                    "sk-…{}",
                    &k.key
                        .chars()
                        .rev()
                        .take(4)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                )
            } else {
                k.name.clone()
            },
        })
        .collect();
    if keys != this.pg_key_items {
        let keep = this
            .pg_key_sel
            .read(cx)
            .selected_value()
            .cloned()
            .filter(|v| keys.iter().any(|k| &k.id == v));
        this.pg_key_items = keys.clone();
        this.pg_key_sel.update(cx, |s, cx| {
            s.set_items(SearchableVec::new(keys.clone()), window, cx);
            if let Some(v) = keep.or_else(|| keys.first().map(|k| k.id.clone())) {
                s.set_selected_value(&v, window, cx);
            }
        });
    }
}

impl AppRoot {
    pub(crate) fn render_playground(
        &mut self,
        snapshot: &GatewayStatusSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;

        // Enter pressed in the composer → the send already ran; the input
        // clear needed a Window, which subscriptions don't get.
        if self.pg_clear_input {
            self.pg_clear_input = false;
            self.pg_input
                .update(cx, |s, cx| s.set_value("", window, cx));
        }
        sync_pg_selects(self, snapshot, window, cx);

        let running = snapshot.server.running;
        let disabled_reason: Option<String> = if !running {
            Some(t(lang, "pg_start_server").to_string())
        } else if self.pg_key_items.is_empty() {
            Some(t(lang, "pg_no_key").to_string())
        } else if self.pg_model_items.is_empty() {
            Some(t(lang, "pg_no_model").to_string())
        } else {
            None
        };

        // ---- toolbar ----
        let toolbar = card(cx)
            .p_3()
            .flex()
            .items_end()
            .gap_3()
            .flex_wrap()
            .child(
                v_flex()
                    .gap_1()
                    .w(px(240.))
                    .child(
                        Label::new(t(lang, "pg_model"))
                            .text_xs()
                            .font_medium()
                            .text_color(theme.secondary_foreground),
                    )
                    .child(
                        Select::new(&self.pg_model_sel)
                            .placeholder(t(lang, "pg_no_model"))
                            .menu_width(px(320.)),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .w(px(200.))
                    .child(
                        Label::new(t(lang, "pg_key"))
                            .text_xs()
                            .font_medium()
                            .text_color(theme.secondary_foreground),
                    )
                    .child(
                        Select::new(&self.pg_key_sel)
                            .placeholder(t(lang, "pg_no_key"))
                            .menu_width(px(220.)),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        Label::new(t(lang, "pg_stream"))
                            .text_xs()
                            .font_medium()
                            .text_color(theme.secondary_foreground),
                    )
                    .child(
                        h_flex()
                            // Medium selects render at h_8 (32px); center the
                            // 16px switch on that line instead of a ghost label.
                            .h_8()
                            .items_center()
                            .child(
                                gpui_kit::component::switch::Switch::new("pg-stream")
                                    .xsmall()
                                    .checked(self.pg_stream)
                                    .on_change(cx.listener(|this, v, _w, cx| {
                                        this.pg_stream = *v;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(div().flex_1())
            .child(
                Button::new("pg-clear")
                    .ghost()
                    .small()
                    .label(t(lang, "clear"))
                    .icon(IconName::Delete)
                    .disabled(self.pg_msgs.is_empty())
                    .on_click(cx.listener(|this, _, _w, cx| this.pg_clear(cx))),
            );

        // ---- messages ----
        let mut log = v_flex().id("pg-log").gap_3().p_4();
        if self.pg_msgs.is_empty() {
            log = log.child(
                v_flex()
                    .items_center()
                    .justify_center()
                    .py_8()
                    .gap_3()
                    .child(
                        Icon::new(IconName::Bot)
                            .size(px(32.))
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div().max_w(rems(26.)).child(
                            Label::new(t(lang, "pg_empty"))
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .text_center(),
                        ),
                    ),
            );
        }
        for m in &self.pg_msgs {
            log = log.child(pg_message(m, lang, cx));
        }

        // ---- composer ----
        let composer = card(cx).p_3().child(
            v_flex()
                .gap_2()
                .when_some(disabled_reason.clone(), |d, reason| {
                    d.child(
                        Label::new(reason)
                            .text_xs()
                            .text_color(theme.warning_foreground),
                    )
                })
                .child(
                    div()
                        .w_full()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(theme.border)
                        .px_3()
                        .py_2()
                        // Page bg is darker than the card → the field reads
                        // as an actual editable surface, not a faint outline.
                        .bg(theme.background)
                        .child(
                            Textarea::new(&self.pg_input)
                                .appearance(false)
                                .bordered(false)
                                .disabled(disabled_reason.is_some()),
                        ),
                )
                .child(
                    h_flex()
                        .items_center()
                        .gap_2()
                        .child(
                            Label::new(t(lang, "pg_input_hint"))
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        )
                        .child(div().flex_1())
                        .when(self.pg_pending, |d| {
                            d.child(
                                Button::new("pg-stop")
                                    .outline()
                                    .small()
                                    .label(t(lang, "stop"))
                                    .icon(IconName::Close)
                                    .on_click(cx.listener(|this, _, _w, cx| this.pg_stop(cx))),
                            )
                        })
                        .child(
                            Button::new("pg-send")
                                .primary()
                                .small()
                                .label(t(lang, "send"))
                                .icon(IconName::ArrowRight)
                                .loading(self.pg_pending)
                                .disabled(disabled_reason.is_some())
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.playground_send(cx);
                                })),
                        ),
                ),
        );

        v_flex()
            .flex_1()
            .min_h_0()
            .gap_3()
            .child(page_header(
                t(lang, "playground_title"),
                t(lang, "pg_desc"),
                None,
                cx,
            ))
            .child(toolbar)
            .child(
                card(cx).flex_1().min_h(px(200.)).overflow_hidden().child(
                    div()
                        .id("pg-scroll")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.pg_scroll)
                        // Clicking blank space releases input focus — the
                        // textarea itself stop_propagation's, so this only
                        // fires outside focusable controls.
                        .on_mouse_down(MouseButton::Left, |_, window, cx| {
                            window.blur(cx);
                        })
                        .child(log),
                ),
            )
            .child(composer)
            .into_any_element()
    }
}

/// One chat bubble: user = accent block; assistant = markdown card with
/// pending dots, error + retry, and a meta line for finished replies.
fn pg_message(m: &PgMsg, lang: crate::root::Lang, cx: &mut Context<AppRoot>) -> AnyElement {
    let theme = cx.theme().clone();
    match m.role {
        PgRole::User => div()
            .flex()
            .justify_end()
            .child(
                div()
                    .max_w(rems(36.))
                    .px_3()
                    .py_2()
                    .rounded(theme.radius_lg)
                    .bg(theme.accent)
                    .child(
                        Label::new(m.content.clone())
                            .text_sm()
                            .text_color(theme.accent_foreground)
                            .whitespace_normal(),
                    ),
            )
            .into_any_element(),
        PgRole::Assistant => {
            let mut body = v_flex().gap_2();
            if m.pending && m.content.is_empty() {
                body = body.child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(
                            Spinner::new()
                                .with_size(Size::XSmall)
                                .color(theme.muted_foreground),
                        )
                        .child(
                            Label::new(t(lang, "pg_replying"))
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                );
            } else if let Some(err) = &m.error {
                let id = m.id;
                body = body
                    .child(
                        Label::new(err.clone())
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme.danger)
                            .whitespace_normal(),
                    )
                    .child(
                        Button::new(SharedString::from(format!("pg-retry-{id}")))
                            .ghost()
                            .xsmall()
                            .label(t(lang, "retry"))
                            .icon(IconName::RotateCw)
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.pg_retry(id, cx);
                            })),
                    );
            } else {
                body = body.child(
                    TextView::markdown(
                        SharedString::from(format!("pg-md-{}", m.id)),
                        m.content.clone(),
                    )
                    .selectable(true),
                );
                if m.pending {
                    body = body.child(
                        Spinner::new()
                            .with_size(Size::XSmall)
                            .color(theme.muted_foreground),
                    );
                }
            }
            if let Some(meta) = &m.meta {
                body = body.child(
                    Label::new(meta.clone())
                        .font_family(MONO)
                        .text_xs()
                        .text_color(theme.muted_foreground),
                );
            }
            div()
                .flex()
                .child(
                    div()
                        .max_w(rems(46.))
                        .px_3()
                        .py_2()
                        .rounded(theme.radius_lg)
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.group_box)
                        .child(body),
                )
                .into_any_element()
        }
    }
}
