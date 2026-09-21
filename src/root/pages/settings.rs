//! Settings — mirrors the Electron settings hierarchy while keeping every
//! control native to GPUI Kit.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Sizable, StyledExt, Theme, ThemeMode,
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
    AppRoot, LANE_LABEL, Lang, MONO, card, enter, provider_logo, shake, t, tf, toggle_filter,
};

fn settings_section(
    title: &str,
    description: &str,
    trailing: Option<AnyElement>,
    content: Option<AnyElement>,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme().clone();
    v_flex()
        .mt_5()
        .pt_5()
        .gap_3()
        .border_t_1()
        .border_color(theme.border)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .gap_4()
                .child(
                    v_flex()
                        .min_w_0()
                        .gap_1()
                        .child(
                            Label::new(title.to_string())
                                .text_sm()
                                .font_medium()
                                .text_color(theme.foreground),
                        )
                        .when(!description.is_empty(), |this| {
                            this.child(
                                Label::new(description.to_string())
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            )
                        }),
                )
                .when_some(trailing, |this, trailing| {
                    this.child(div().flex_none().child(trailing))
                }),
        )
        .when_some(content, |this, content| this.child(content))
        .into_any_element()
}

fn settings_kv(label: &str, value: impl Into<SharedString>, cx: &App) -> AnyElement {
    let theme = cx.theme().clone();
    h_flex()
        .items_center()
        .gap_3()
        .child(
            div().w(LANE_LABEL).flex_none().child(
                Label::new(label.to_string())
                    .text_xs()
                    .text_color(theme.muted_foreground),
            ),
        )
        .child(
            Label::new(value.into())
                .font_family(MONO)
                .text_xs()
                .text_color(theme.secondary_foreground)
                .truncate(),
        )
        .into_any_element()
}

fn build_snippet(url: &str, format: usize) -> String {
    let endpoint = format!("{url}/v1/chat/completions");
    let body = r#"{"model":"kiro/claude-sonnet-4.5","messages":[{"role":"user","content":"hello"}],"stream":true}"#;
    match format {
        1 => format!(
            "const res = await fetch(\"{endpoint}\", {{\n  method: \"POST\",\n  headers: {{\n    \"Authorization\": \"Bearer YOUR_API_KEY\",\n    \"Content-Type\": \"application/json\",\n  }},\n  body: JSON.stringify({body}),\n}});"
        ),
        2 => format!(
            "import httpx\n\nres = httpx.post(\n    \"{endpoint}\",\n    headers={{\"Authorization\": \"Bearer YOUR_API_KEY\"}},\n    json={body},\n)\nprint(res.json())"
        ),
        _ => format!(
            "curl {endpoint} \\\n+  -H \"Authorization: Bearer YOUR_API_KEY\" \\\n+  -H \"Content-Type: application/json\" \\\n+  -d '{body}'"
        ),
    }
}

impl AppRoot {
    pub(crate) fn render_settings(
        &self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        let cfg = self.service.config();
        let listen_on_lan = !matches!(
            cfg.server.host.to_ascii_lowercase().as_str(),
            "127.0.0.1" | "::1" | "localhost"
        );

        let connection = v_flex()
            .gap_2()
            .child(settings_kv(
                t(lang, "kv_url"),
                snapshot.server.url.clone(),
                cx,
            ))
            .child(settings_kv(
                t(lang, "kv_config"),
                snapshot.config_path.clone(),
                cx,
            ))
            .child(settings_kv(
                t(lang, "kv_state"),
                snapshot.state_path.clone(),
                cx,
            ))
            .into_any_element();

        let auto_start = Switch::new("settings-autostart")
            .small()
            .checked(cfg.server.auto_start)
            .accessibility_label(t(lang, "acc_autostart"))
            .on_change(cx.listener(|this, _, _window, cx| this.toggle_autostart(cx)))
            .into_any_element();

        let listen_switch = Switch::new("settings-listen-lan")
            .small()
            .checked(listen_on_lan)
            .accessibility_label(t(lang, "acc_listen_lan"))
            .on_change(cx.listener(|this, next, window, cx| {
                this.set_listen_on_lan(*next, window, cx);
            }))
            .into_any_element();
        let listen_warning = listen_on_lan.then(|| {
            Label::new(t(lang, "listen_warning"))
                .text_xs()
                .text_color(theme.warning)
                .into_any_element()
        });

        // Shake on an invalid port — replayed per attempt via shake_nonce.
        let port_field = div()
            .w_32()
            .child(Input::new(&self.port_input).small().font_family(MONO));
        let port_editor = h_flex()
            .items_center()
            .gap_3()
            .child(if self.shake_nonce > 0 {
                shake(port_field, format!("port-shake-{}", self.shake_nonce)).into_any_element()
            } else {
                port_field.into_any_element()
            })
            .child(
                Button::new("settings-save-port")
                    .outline()
                    .small()
                    .label(t(lang, "save"))
                    .on_click(cx.listener(|this, _, _window, cx| this.apply_port(cx))),
            )
            .into_any_element();

        let proxy_editor = h_flex()
            .items_center()
            .gap_3()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&self.proxy_input).small().font_family(MONO)),
            )
            .child(
                Button::new("settings-save-proxy")
                    .outline()
                    .small()
                    .label(t(lang, "save"))
                    .on_click(cx.listener(|this, _, _window, cx| this.apply_proxy(cx))),
            )
            .into_any_element();

        let snippet = build_snippet(&snapshot.server.url, self.snippet_format);
        let snippet_for_copy = snippet.clone();
        let root_entity = cx.entity();
        let snippet_actions = h_flex()
            .items_center()
            .gap_3()
            .child(toggle_filter(
                "snippet-format",
                vec![
                    ("curl".into(), self.snippet_format == 0),
                    ("fetch".into(), self.snippet_format == 1),
                    ("python".into(), self.snippet_format == 2),
                ],
                move |format, _window, app| {
                    let root = root_entity.clone();
                    app.update_entity(&root, |this, cx| {
                        this.snippet_format = format;
                        cx.notify();
                    });
                },
                cx,
            ))
            .child(
                Button::new("copy-snippet")
                    .outline()
                    .small()
                    .label(t(
                        lang,
                        if self.snippet_copied {
                            "copied"
                        } else {
                            "copy"
                        },
                    ))
                    .icon(if self.snippet_copied {
                        IconName::Check
                    } else {
                        IconName::Copy
                    })
                    .on_click(cx.listener(move |this, _, _w, cx| {
                        cx.write_to_clipboard(ClipboardItem::new_string(snippet_for_copy.clone()));
                        this.snippet_copied = true;
                        cx.spawn(async move |this, cx| {
                            smol::Timer::after(std::time::Duration::from_millis(1500)).await;
                            let _ = this.update(cx, |this, cx| {
                                this.snippet_copied = false;
                                cx.notify();
                            });
                        })
                        .detach();
                        cx.notify();
                    })),
            )
            .into_any_element();
        let snippet_card = card(cx).p_3().child(
            v_flex().gap_0().children(
                snippet
                    .lines()
                    .map(|line| {
                        Label::new(line.to_string())
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme.secondary_foreground)
                            .into_any_element()
                    })
                    .collect::<Vec<_>>(),
            ),
        );

        // All real providers — a disabled one stays dimmed but listed so
        // its sidebar visibility can still be managed.
        let visible_providers = snapshot
            .providers
            .iter()
            .filter(|provider| provider.status != "placeholder")
            .collect::<Vec<_>>();
        let sidebar_content = if visible_providers.is_empty() {
            Label::new(t(lang, "no_enabled_providers"))
                .text_xs()
                .text_color(theme.muted_foreground)
                .into_any_element()
        } else {
            let mut rows = v_flex().gap_0p5();
            for provider in visible_providers {
                let name = provider.name.clone();
                let visible = !self.hidden_providers.contains(&name);
                let live = Self::provider_live(&name);
                let label = provider
                    .display_name
                    .clone()
                    .unwrap_or_else(|| provider.name.clone());
                let icon = provider_logo(&provider.provider_type, 16., !provider.enabled, cx);
                rows = rows.child(
                    h_flex()
                        // Stateful — a stateless row's hover state only
                        // repaints when something else (e.g. scroll)
                        // invalidates the frame.
                        .id(SharedString::from(format!("sidebar-vis-row-{name}")))
                        .h_7()
                        .w_full()
                        .items_center()
                        .justify_between()
                        .gap_2()
                        .px_1p5()
                        .rounded(theme.radius)
                        .when(live, |d| d.hover(|this| this.bg(theme.list_hover)))
                        .child(
                            h_flex()
                                .min_w_0()
                                .items_center()
                                .gap_1p5()
                                .child(icon)
                                .child(
                                    Label::new(label)
                                        .text_xs()
                                        .text_color(if provider.enabled {
                                            theme.foreground
                                        } else {
                                            theme.muted_foreground
                                        })
                                        .truncate(),
                                )
                                .when(!live, |d| {
                                    d.child(
                                        Label::new(t(lang, "coming_soon"))
                                            .text_xs()
                                            .text_color(theme.muted_foreground),
                                    )
                                }),
                        )
                        .child(
                            Switch::new(SharedString::from(format!("sidebar-visible-{name}")))
                                .small()
                                .checked(visible)
                                .disabled(!live)
                                .accessibility_label(tf(
                                    lang,
                                    "acc_show_provider",
                                    &[("name", &name)],
                                ))
                                .on_change(cx.listener(move |this, next, _window, cx| {
                                    this.set_sidebar_provider_visible(&name, *next, cx);
                                })),
                        ),
                );
            }
            rows.into_any_element()
        };
        let show_all = (!self.hidden_providers.is_empty()).then(|| {
            Button::new("sidebar-show-all")
                .ghost()
                .xsmall()
                .label(t(lang, "show_all"))
                .on_click(cx.listener(|this, _, _window, cx| {
                    this.show_all_sidebar_providers(cx);
                }))
                .into_any_element()
        });

        let about = v_flex()
            .gap_2()
            .child(settings_kv(
                t(lang, "kv_version"),
                format!("v{}", env!("CARGO_PKG_VERSION")),
                cx,
            ))
            .child(settings_kv(t(lang, "kv_github"), "bee1an/GatewayHub", cx))
            .into_any_element();

        let mut page = v_flex()
            .child(settings_section(
                t(lang, "sec_connection"),
                "",
                None,
                Some(connection),
                cx,
            ))
            .child(settings_section(
                t(lang, "sec_autostart"),
                t(lang, "sec_autostart_desc"),
                Some(auto_start),
                None,
                cx,
            ))
            .child(settings_section(
                t(lang, "sec_listen_lan"),
                t(lang, "sec_listen_lan_desc"),
                Some(listen_switch),
                listen_warning,
                cx,
            ))
            .child(settings_section(
                t(lang, "sec_port"),
                t(lang, "sec_port_desc"),
                None,
                Some(port_editor),
                cx,
            ))
            .child(settings_section(
                t(lang, "sec_proxy"),
                t(lang, "sec_proxy_desc"),
                None,
                Some(proxy_editor),
                cx,
            ))
            .child(settings_section(
                t(lang, "sec_snippet"),
                t(lang, "sec_snippet_desc"),
                Some(snippet_actions),
                Some(snippet_card.into_any_element()),
                cx,
            ))
            .child(settings_section(
                t(lang, "sec_sidebar"),
                t(lang, "sec_sidebar_desc"),
                show_all,
                Some(sidebar_content),
                cx,
            ))
            .child({
                // Language selector — System / English / 中文
                let lang_entity = cx.entity();
                let lang_filter = toggle_filter(
                    "settings-lang",
                    vec![
                        (t(lang, "language_system").into(), self.lang == Lang::System),
                        (t(lang, "language_en").into(), self.lang == Lang::En),
                        (t(lang, "language_zh").into(), self.lang == Lang::Zh),
                    ],
                    move |ix, _w, app| {
                        let root = lang_entity.clone();
                        app.update_entity(&root, |this, cx| {
                            this.set_language(
                                match ix {
                                    1 => Lang::En,
                                    2 => Lang::Zh,
                                    _ => Lang::System,
                                },
                                cx,
                            );
                        });
                    },
                    cx,
                );
                settings_section(
                    t(lang, "language"),
                    "",
                    Some(lang_filter.into_any_element()),
                    None,
                    cx,
                )
            })
            .child({
                // Theme selector — same segmented idiom as the language row;
                // moved here from the sidebar footer.
                let theme_entity = cx.entity();
                let dark_now = theme.mode.is_dark();
                let theme_filter = toggle_filter(
                    "settings-theme",
                    vec![
                        (t(lang, "theme_light").into(), !dark_now),
                        (t(lang, "theme_dark").into(), dark_now),
                    ],
                    move |ix, window, app| {
                        let root = theme_entity.clone();
                        app.update_entity(&root, |this, cx| {
                            let next = if ix == 1 {
                                ThemeMode::Dark
                            } else {
                                ThemeMode::Light
                            };
                            this.mode_choice = Some(next);
                            Theme::change(next, Some(window), cx);
                            // Keep the native frosted material on the same
                            // appearance as the in-app theme.
                            #[cfg(target_os = "macos")]
                            if let Err(error) = crate::macos_blur::set_window_appearance(
                                window,
                                matches!(next, ThemeMode::Dark),
                            ) {
                                tracing::warn!(%error, "failed to pin window appearance");
                            }
                            cx.notify();
                        });
                    },
                    cx,
                );
                settings_section(
                    t(lang, "theme"),
                    "",
                    Some(theme_filter.into_any_element()),
                    None,
                    cx,
                )
            })
            .child(settings_section(
                t(lang, "sec_about"),
                "",
                None,
                Some(about),
                cx,
            ));

        if let Some(notice) = &self.settings_notice {
            page = page.child(enter(
                div().mt_4().child(
                    Label::new(notice.clone())
                        .font_family(MONO)
                        .text_xs()
                        .text_color(theme.muted_foreground),
                ),
                format!("settings-notice-{}", self.notice_nonce),
            ));
        }
        page.into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::build_snippet;

    #[test]
    fn snippet_formats_keep_the_gateway_endpoint() {
        for format in 0..=2 {
            let snippet = build_snippet("http://127.0.0.1:9743", format);
            assert!(snippet.contains("http://127.0.0.1:9743/v1/chat/completions"));
        }
    }
}
