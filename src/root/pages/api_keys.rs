//! API keys — name + masked token + usage meta + provider scopes.
//! Key creation lives in a dialog (name, expiry, per-provider scope).

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    switch::Switch,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, MONO, OverlayRequest, card, card_rows, enter, page_header, row, section_header,
    short_date, t, tf, toggle_filter,
};

/// Expiry choices for the generate dialog — days; 0 = never.
const EXPIRY_OPTIONS: &[i64] = &[0, 7, 30, 90];

impl AppRoot {
    pub(crate) fn render_api_keys(
        &self,
        _snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        let cfg = self.service.config();
        let now = gateway_core::pool::now_ms();

        let mut key_rows: Vec<AnyElement> = Vec::new();
        for k in &cfg.server.api_keys {
            let masked = if k.key.len() > 10 {
                format!("{}…{}", &k.key[..6], &k.key[k.key.len() - 4..])
            } else {
                "•••".into()
            };
            let mut meta = match k.last_used_at {
                Some(ts) => tf(
                    lang,
                    "created_last_used",
                    &[
                        ("created", &short_date(k.created_at)),
                        ("last", &short_date(ts)),
                    ],
                ),
                None => tf(
                    lang,
                    "created_never_used",
                    &[("created", &short_date(k.created_at))],
                ),
            };
            // Provider allowlist + expiry are part of the key's contract.
            let scopes = k.scopes.as_deref().unwrap_or(&[]);
            meta.push_str(&format!(
                " · {}",
                if scopes.is_empty() {
                    t(lang, "scope_all").to_string()
                } else {
                    scopes.join(", ")
                }
            ));
            let mut meta_color = theme.muted_foreground;
            if let Some(exp) = k.expires_at {
                meta.push_str(&format!(" · {}", short_date(exp)));
                if exp < now {
                    meta.push_str(&format!(" ({})", t(lang, "expired")));
                    meta_color = theme.danger;
                }
            }
            let id = k.id.clone();
            let k_name = k.name.clone();
            key_rows.push(
                row()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_0p5()
                            .child(
                                Label::new(k.name.clone())
                                    .text_sm()
                                    .font_medium()
                                    .text_color(theme.foreground),
                            )
                            .child(
                                Label::new(masked)
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.secondary_foreground),
                            )
                            .child(Label::new(meta).text_xs().text_color(meta_color)),
                    )
                    .child(
                        Button::new(SharedString::from(format!("delkey-{}", k.id)))
                            .ghost()
                            .xsmall()
                            .label(t(lang, "revoke"))
                            .on_click(cx.listener(move |this, e: &ClickEvent, _w, cx| {
                                let (key_name, id) = (k_name.clone(), id.clone());
                                this.confirm(
                                    t(this.lang, "revoke_key_title"),
                                    tf(this.lang, "revoke_key_desc", &[("name", &key_name)]),
                                    "revoke",
                                    Some(e.position()),
                                    cx,
                                    move |this, cx| this.delete_api_key(&id, cx),
                                );
                            })),
                    )
                    .into_any_element(),
            );
        }

        let keys_card = if cfg.server.api_keys.is_empty() {
            card(cx)
                .p_4()
                .child(
                    Label::new(t(lang, "no_api_keys"))
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element()
        } else {
            card_rows(key_rows, cx)
        };

        // Shown once after generation — the whole point is copying it out.
        let new_key_banner = self.new_key.as_ref().map(|key| {
            let key_for_copy = key.clone();
            let copied = self.key_copied;
            enter(
                card(cx)
                    .p_3()
                    .flex()
                    .items_center()
                    .gap_3()
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap_0p5()
                            .child(
                                Label::new(t(lang, "new_key_banner"))
                                    .text_xs()
                                    .font_medium()
                                    .text_color(theme.warning_foreground),
                            )
                            .child(
                                Label::new(key.clone())
                                    .font_family(MONO)
                                    .text_sm()
                                    .text_color(theme.foreground)
                                    .truncate(),
                            ),
                    )
                    .child(
                        Button::new("copy-key")
                            .outline()
                            .xsmall()
                            .label(t(lang, if copied { "copied" } else { "copy" }))
                            .icon(if copied {
                                IconName::Check
                            } else {
                                IconName::Copy
                            })
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(
                                    key_for_copy.clone(),
                                ));
                                this.key_copied = true;
                                cx.spawn(async move |this, cx| {
                                    smol::Timer::after(std::time::Duration::from_millis(1500))
                                        .await;
                                    let _ = this.update(cx, |this, cx| {
                                        this.key_copied = false;
                                        cx.notify();
                                    });
                                })
                                .detach();
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("dismiss-key")
                            .ghost()
                            .xsmall()
                            .label(t(lang, "dismiss"))
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.new_key = None;
                                this.key_copied = false;
                                cx.notify();
                            })),
                    ),
                "new-key-banner",
            )
            .into_any_element()
        });

        v_flex()
            .gap_4()
            .child(page_header(
                t(lang, "api_keys_title"),
                t(lang, "api_keys_desc"),
                Some(
                    Button::new("gen-key")
                        .primary()
                        .small()
                        .label(t(lang, "generate"))
                        .icon(IconName::Plus)
                        .on_click(cx.listener(|this, e: &ClickEvent, _w, cx| {
                            this.open_key_overlay(Some(e.position()), cx);
                        }))
                        .into_any_element(),
                ),
                cx,
            ))
            .when_some(new_key_banner, |d, b| d.child(b))
            .child(
                v_flex()
                    .gap_2()
                    .child(section_header(
                        tf(
                            lang,
                            "n_keys",
                            &[("n", &cfg.server.api_keys.len().to_string())],
                        ),
                        None,
                        cx,
                    ))
                    .child(keys_card),
            )
            .into_any_element()
    }

    /// Generate-key overlay: name, expiry, provider allowlist. Empty name or
    /// an empty non-"all" scope selection disables the submit button.
    fn open_key_overlay(&mut self, origin: Option<Point<Pixels>>, cx: &mut Context<Self>) {
        let lang = self.lang;
        let providers: Vec<String> = self
            .snapshot
            .providers
            .iter()
            .filter(|p| p.enabled)
            .map(|p| p.name.clone())
            .collect();
        self.open_overlay(
            OverlayRequest {
                title: t(lang, "generate_title").into(),
                width: px(460.),
                height_hint: px(330.),
                origin,
                content: Some(std::rc::Rc::new(move |root, _w, cx| {
                    let theme = cx.theme().clone();
                    let lang = root.lang;
                    let (scope_all, scopes, expiry_days) = (
                        root.key_scope_all,
                        root.key_scopes.clone(),
                        root.key_expiry_days,
                    );

                    // expiry pills — toggle_filter is the segmented control.
                    let expiry_pills = toggle_filter(
                        "key-expiry",
                        EXPIRY_OPTIONS
                            .iter()
                            .map(|d| {
                                (
                                    if *d == 0 {
                                        SharedString::from(t(lang, "expire_never").to_string())
                                    } else {
                                        SharedString::from(tf(
                                            lang,
                                            "expire_days",
                                            &[("n", &d.to_string())],
                                        ))
                                    },
                                    expiry_days == *d,
                                )
                            })
                            .collect(),
                        cx.processor(|this, ix, _w, cx| {
                            this.key_expiry_days = EXPIRY_OPTIONS[ix];
                            cx.notify();
                        }),
                        cx,
                    );

                    // scope: switch "all providers" + provider chips.
                    let mut scope_chips = h_flex().gap_1p5().flex_wrap();
                    if !scope_all {
                        for p in &providers {
                            let selected = scopes.contains(p.as_str());
                            let p2 = p.clone();
                            scope_chips = scope_chips.child(
                                div()
                                    .id(SharedString::from(format!("scope-{p}")))
                                    .px_2p5()
                                    .h_6()
                                    .flex()
                                    .items_center()
                                    .gap_1()
                                    .rounded(theme.radius)
                                    .border_1()
                                    .cursor_pointer()
                                    .when(selected, |d| {
                                        d.bg(theme.button_primary)
                                            .border_color(theme.button_primary)
                                    })
                                    .when(!selected, |d| {
                                        d.bg(theme.group_box)
                                            .border_color(theme.border)
                                            .hover(|d| d.bg(theme.list_hover))
                                    })
                                    .child(Label::new(p.clone()).text_xs().text_color(
                                        if selected {
                                            theme.button_primary_foreground
                                        } else {
                                            theme.muted_foreground
                                        },
                                    ))
                                    .on_click(cx.listener({
                                        let p = p2;
                                        move |this, _, _w, cx| {
                                            if !this.key_scopes.remove(&p) {
                                                this.key_scopes.insert(p.clone());
                                            }
                                            cx.notify();
                                        }
                                    })),
                            );
                        }
                    }

                    v_flex()
                        .gap_3()
                        .child(
                            v_flex()
                                .gap_1p5()
                                .child(
                                    Label::new(t(lang, "key_name"))
                                        .text_xs()
                                        .font_medium()
                                        .text_color(theme.secondary_foreground),
                                )
                                .child(Input::new(&root.key_name_input).small()),
                        )
                        .child(
                            v_flex()
                                .gap_1p5()
                                .child(
                                    Label::new(t(lang, "key_expiry"))
                                        .text_xs()
                                        .font_medium()
                                        .text_color(theme.secondary_foreground),
                                )
                                .child(expiry_pills),
                        )
                        .child(
                            v_flex()
                                .gap_2()
                                .child(
                                    h_flex()
                                        .items_center()
                                        .justify_between()
                                        .child(
                                            Label::new(t(lang, "scopes_label"))
                                                .text_xs()
                                                .font_medium()
                                                .text_color(theme.secondary_foreground),
                                        )
                                        .child(
                                            h_flex()
                                                .items_center()
                                                .gap_1p5()
                                                .child(
                                                    Label::new(t(lang, "scope_all"))
                                                        .text_xs()
                                                        .text_color(theme.muted_foreground),
                                                )
                                                .child(
                                                    Switch::new("scope-all")
                                                        .xsmall()
                                                        .checked(scope_all)
                                                        .on_change(cx.listener(
                                                            |this, checked, _w, cx| {
                                                                this.key_scope_all = *checked;
                                                                cx.notify();
                                                            },
                                                        )),
                                                ),
                                        ),
                                )
                                .when(!scope_all, |d| d.child(scope_chips)),
                        )
                        .into_any_element()
                })),
                footer: Some(std::rc::Rc::new(move |_root, _w, cx| {
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("gen-cancel")
                                .outline()
                                .small()
                                .label(t(lang, "cancel"))
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.dismiss_overlay(cx);
                                })),
                        )
                        .child(
                            Button::new("gen-ok")
                                .primary()
                                .small()
                                .label(t(lang, "generate"))
                                .on_click(cx.listener(|this, _, w, cx| {
                                    this.add_api_key(w, cx);
                                })),
                        )
                        .into_any_element()
                })),
                ..OverlayRequest::default()
            },
            cx,
        );
    }
}
