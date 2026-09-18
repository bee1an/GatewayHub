//! Provider detail — header tile, check-in settings (TraeWork/WorkBuddy),
//! accounts card, import dialog. Per-account models/checkin live in the
//! account dialog — models differ per account, so they are not a
//! provider-level surface.

use gateway_core::GatewayStatusSnapshot;
use gateway_core::types::{AccountRuntimeState, AccountStatus};
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    menu::{ContextMenuExt, DropdownMenu, PopupMenu, PopupMenuItem},
    switch::Switch,
    tooltip::Tooltip,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, MONO, OverlayRequest, card, card_uniform_list, enter, hairline, provider_logo, row,
    section_header, skeleton_rows, status_label, t, tf,
};

/// Providers that expose daily check-in (`checkin_accounts`).
pub(crate) const CHECKIN_PROVIDERS: &[&str] = &["traework", "workbuddy"];

/// YYYY-MM-DD in Asia/Shanghai — same day key the checkin state stores.
pub(crate) fn cn_today() -> String {
    chrono::DateTime::from_timestamp_millis(gateway_core::pool::now_ms())
        .map(|d| {
            d.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).unwrap())
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

/// Compact duration like `12m` / `4h` / `2d` — for cooldown chips.
fn short_duration(ms: i64) -> String {
    let secs = (ms / 1000).max(0);
    if secs >= 86400 {
        format!("{}d", secs / 86400)
    } else if secs >= 3600 {
        format!("{}h", secs / 3600)
    } else if secs >= 60 {
        format!("{}m", secs / 60)
    } else {
        format!("{secs}s")
    }
}

/// Account runtime status → i18n key + semantic color.
fn account_status_meta(
    status: AccountStatus,
    theme: &gpui_kit::component::theme::Theme,
) -> (&'static str, gpui_kit::Hsla) {
    match status {
        AccountStatus::Available => ("acct_available", theme.success),
        AccountStatus::Cooling => ("acct_cooling", theme.warning_foreground),
        AccountStatus::RateLimited => ("acct_rate_limited", theme.warning_foreground),
        AccountStatus::QuotaExceeded => ("acct_quota", theme.danger),
        AccountStatus::AuthFailed => ("acct_auth", theme.danger),
        AccountStatus::ManualDisabled => ("acct_off", theme.muted_foreground),
    }
}

impl AppRoot {
    pub(crate) fn render_provider_detail(
        &mut self,
        provider: &str,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;
        let status = snapshot.providers.iter().find(|p| p.name == provider);
        let provider_name = provider.to_string();
        // Accounts come from the cache — scanning the account dir on every
        // render was the source of detail-page jank. First open loads async
        // and shows skeleton rows meanwhile.
        if !self.accounts_cache.contains_key(provider) {
            self.load_accounts(provider, cx);
        }
        let accounts = self
            .accounts_cache
            .get(provider)
            .cloned()
            .unwrap_or_default();
        let accounts_loading = !self.accounts_cache.contains_key(provider);
        let provider_applying = self.provider_pending.contains(provider);
        let account_scroll = self
            .account_scroll
            .entry(provider.to_string())
            .or_default()
            .clone();
        let states = self
            .account_states
            .get(provider)
            .cloned()
            .unwrap_or_default();
        let enabled = status.map(|p| p.enabled).unwrap_or(false);
        let supports_checkin = CHECKIN_PROVIDERS.contains(&provider);

        // ---- header: back + bare brand mark + name/status | toggles ----
        let provider_type = status.map(|p| p.provider_type.as_str()).unwrap_or_default();

        let status_text = status.map(status_label).unwrap_or("off");
        let status_color = match status_text {
            "ready" => theme.success,
            "error" => theme.danger,
            _ => theme.muted_foreground,
        };
        let message = status.and_then(|p| p.message.clone()).unwrap_or_default();
        let use_proxy = status.and_then(|p| p.use_proxy).unwrap_or(false);

        let header = h_flex()
            .w_full()
            .items_center()
            .gap_3()
            .pt_5()
            .pb_4()
            .border_b_1()
            .border_color(theme.border)
            .child(
                Button::new("back")
                    .ghost()
                    .small()
                    .icon(IconName::ArrowLeft)
                    .tooltip(t(lang, "back"))
                    .on_click(cx.listener(|this, _, _w, cx| {
                        this.detail = None;
                        cx.notify();
                    })),
            )
            .child(provider_logo(provider_type, 32., !enabled, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        Label::new(provider.to_string())
                            .text_lg()
                            .font_semibold()
                            .text_color(theme.foreground)
                            .whitespace_nowrap()
                            .overflow_hidden(),
                    )
                    .child(
                        h_flex()
                            .gap_1p5()
                            .child(div().size_1p5().rounded_full().bg(status_color))
                            .child(Label::new(status_text).text_xs().text_color(status_color)),
                    )
                    // Upstream/provider message on its own line — it can be
                    // long (quota/auth errors); truncation keeps a tooltip.
                    .when(!message.is_empty(), |d| {
                        let full: SharedString = message.clone().into();
                        d.child(
                            div()
                                .id("provider-message")
                                .tooltip(move |window, cx| {
                                    Tooltip::new(full.clone()).build(window, cx)
                                })
                                .w_full()
                                .min_w_0()
                                .child(
                                    Label::new(message.clone())
                                        .text_xs()
                                        .text_color(theme.muted_foreground)
                                        .truncate(),
                                ),
                        )
                    }),
            )
            .child(
                h_flex()
                    .flex_none()
                    .items_center()
                    .gap_3()
                    .child(
                        h_flex()
                            .items_center()
                            .gap_1p5()
                            .child(
                                Label::new(t(lang, "proxy"))
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            )
                            .child(
                                Switch::new("toggle-proxy")
                                    .small()
                                    .checked(use_proxy)
                                    .disabled(provider_applying)
                                    .on_change(cx.listener({
                                        let p = provider_name.clone();
                                        move |this, _checked, _w, cx| {
                                            this.toggle_provider_flag(&p, "useProxy", cx);
                                        }
                                    })),
                            ),
                    )
                    .child(
                        Button::new("toggle-enabled")
                            .when(enabled, |b| b.outline())
                            .when(!enabled, |b| b.primary())
                            .small()
                            .label(t(lang, if enabled { "disable" } else { "enable" }))
                            .loading(provider_applying)
                            .on_click(cx.listener({
                                let p = provider_name.clone();
                                move |this, _, _w, cx| {
                                    this.toggle_provider_flag(&p, "enabled", cx);
                                }
                            })),
                    ),
            );

        // ---- auto-checkin toggle (TraeWork/WorkBuddy) ----
        let auto_checkin = self
            .service
            .config()
            .providers
            .get(provider)
            .map(|v| gateway_core::ProviderConfig::from_value(v))
            .map(|c| {
                c.settings
                    .get("autoCheckin")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true)
            })
            .unwrap_or(true);
        let checkin_card: Option<AnyElement> = supports_checkin.then(|| {
            card(cx)
                .child(
                    row()
                        .py_3()
                        .child(
                            v_flex()
                                .flex_1()
                                .min_w_0()
                                .gap_0p5()
                                .child(
                                    Label::new(t(lang, "auto_checkin"))
                                        .text_sm()
                                        .font_medium()
                                        .text_color(theme.foreground),
                                )
                                .child(
                                    Label::new(t(lang, "auto_checkin_desc"))
                                        .text_xs()
                                        .text_color(theme.muted_foreground),
                                ),
                        )
                        .child(
                            Switch::new("auto-checkin")
                                .checked(auto_checkin)
                                .disabled(provider_applying)
                                .on_change({
                                    let weak = cx.weak_entity();
                                    let p = provider_name.clone();
                                    move |_checked, _w, cx| {
                                        let _ = weak.update(cx, |this, cx| {
                                            this.toggle_provider_setting(
                                                &p,
                                                "autoCheckin",
                                                true,
                                                cx,
                                            );
                                        });
                                    }
                                }),
                        ),
                )
                .into_any_element()
        });

        // ---- accounts: virtualized card sized to content (≤5 rows) ----
        let accounts_count = accounts.len();
        let accounts_for_rows = accounts.clone();
        let theme_for_rows = theme.clone();
        let provider_for_rows = provider.to_string();
        let checkin_pending_keys = self.checkin_pending.clone();
        let states_for_rows = states.clone();
        let weak = cx.weak_entity();
        let row_height = px(52.);
        let today = cn_today();
        let render_account = move |ix: usize, _window: &mut Window, _app: &mut App| -> AnyElement {
            let account = &accounts_for_rows[ix];
            let key = format!("{provider_for_rows}/{}", account.id);
            let label = account.display_label().to_string();
            let runtime = states_for_rows.get(&account.id);
            let account_id = account.id.clone();
            let account_for_dialog = account.clone();
            let (p2, p3, p4, p5) = (
                provider_for_rows.clone(),
                provider_for_rows.clone(),
                provider_for_rows.clone(),
                provider_for_rows.clone(),
            );
            let (a2, a3) = (account_id.clone(), account_id.clone());
            let is_checkin = checkin_pending_keys.contains(&key);

            // meta line: cooldown/status > enabled/disabled. The test
            // probe lives in the account dialog now, not on the row.
            let now = gateway_core::pool::now_ms();
            let cooling = runtime
                .and_then(|s| s.cooldown_until)
                .filter(|until| *until > now);
            let meta = if let Some(until) = cooling {
                tf(
                    lang,
                    "cooling_for",
                    &[("dur", &short_duration(until - now))],
                )
            } else if let Some(s) = runtime.filter(|s| s.status != AccountStatus::Available) {
                let (key, _) = account_status_meta(s.status, &theme_for_rows);
                t(lang, key).to_string()
            } else {
                t(
                    lang,
                    if account.enabled {
                        "enabled"
                    } else {
                        "disabled"
                    },
                )
                .to_string()
            };

            // check-in badge: ✓ +credits today, ⚠ on last failure
            let checkin = runtime.and_then(|s| s.checkin.clone());
            let checked_today = checkin
                .as_ref()
                .and_then(|c| c.last_day.as_deref())
                .map(|d| d == today)
                .unwrap_or(false);
            let checkin_badge: Option<AnyElement> = if checked_today {
                let credits = checkin
                    .as_ref()
                    .and_then(|c| c.last_credits)
                    .map(|c| format!(" +{c:.0}"))
                    .unwrap_or_default();
                Some(
                    h_flex()
                        .gap_1()
                        .px_1p5()
                        .py_0p5()
                        .rounded(px(3.))
                        .bg(theme_for_rows.success.opacity(0.18))
                        .border_1()
                        .border_color(theme_for_rows.success.opacity(0.35))
                        .child(
                            Icon::new(IconName::Check)
                                .size_3p5()
                                .text_color(theme_for_rows.success),
                        )
                        .child(
                            Label::new(credits.trim().to_string())
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme_for_rows.success),
                        )
                        .into_any_element(),
                )
            } else if checkin
                .as_ref()
                .and_then(|c| c.last_error.as_ref())
                .is_some()
            {
                Some(
                    div()
                        .px_1p5()
                        .py_0p5()
                        .rounded(px(3.))
                        .bg(theme_for_rows.danger.opacity(0.18))
                        .border_1()
                        .border_color(theme_for_rows.danger.opacity(0.35))
                        .child(
                            Icon::new(IconName::Close)
                                .size_3p5()
                                .text_color(theme_for_rows.danger),
                        )
                        .into_any_element(),
                )
            } else {
                None
            };

            // Object-scoped commands (enable/disable, delete) live in a menu:
            // right-click on the row or the trailing ellipsis button opens
            // the same PopupMenu — only the frequent `Test` stays visible.
            let label_for_menu = label.clone();
            let weak_for_menu = weak.clone();
            let account_enabled = account.enabled;
            let menu_for: std::rc::Rc<
                dyn Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu,
            > = std::rc::Rc::new(move |menu, _window, _cx| {
                let (weak2, weak3) = (weak_for_menu.clone(), weak_for_menu.clone());
                let (p2, p3) = (p2.clone(), p3.clone());
                let (a2, a2d) = (a2.clone(), a2.clone());
                let acct_enabled = account_enabled;
                let label2 = label_for_menu.clone();
                menu.item(
                    PopupMenuItem::new(t(lang, if acct_enabled { "disable" } else { "enable" }))
                        .icon(if acct_enabled {
                            IconName::Pause
                        } else {
                            IconName::Play
                        })
                        .on_click(move |_, _, cx| {
                            let (p2, a2) = (p2.clone(), a2.clone());
                            let _ = weak2.update(cx, |this, cx| {
                                this.toggle_account(&p2, &a2, cx);
                            });
                        }),
                )
                .separator()
                .item(
                    PopupMenuItem::new(t(lang, "delete"))
                        .icon(IconName::Delete)
                        .on_click(move |_, _, cx| {
                            let (p3, a2d, label2) = (p3.clone(), a2d.clone(), label2.clone());
                            let _ = weak3.update(cx, |this, cx| {
                                this.confirm(
                                    t(this.lang, "delete_account_title"),
                                    tf(this.lang, "delete_account_desc", &[("label", &label2)]),
                                    "delete",
                                    cx,
                                    move |this, cx| {
                                        this.delete_account(&p3, &a2d, cx);
                                    },
                                );
                            });
                        }),
                )
            });

            row()
                .id(SharedString::from(format!("acct-row-{key}")))
                .h(row_height)
                // Whole-row hover + click opens the account dialog — Heimdall
                // list-row style. Buttons inside stop propagation.
                .hover(|d| d.bg(theme_for_rows.list_hover))
                .on_click({
                    let weak = weak.clone();
                    move |_e, _window, cx| {
                        let _ = weak.update(cx, |this, cx| {
                            this.open_account_overlay(&p5, &account_for_dialog, cx);
                        });
                    }
                })
                .child(
                    v_flex()
                        .gap_0p5()
                        .flex_1()
                        .min_w_0()
                        .child(
                            Label::new(label)
                                .text_sm()
                                .font_medium()
                                .text_color(theme_for_rows.foreground)
                                .truncate(),
                        )
                        .child(
                            Label::new(meta)
                                .text_xs()
                                .text_color(theme_for_rows.muted_foreground)
                                .truncate(),
                        ),
                )
                .child(
                    Icon::new(IconName::ChevronRight)
                        .size_3p5()
                        .text_color(theme_for_rows.muted_foreground),
                )
                .when_some(checkin_badge, |r, badge| r.child(badge))
                .when(supports_checkin, |r| {
                    r.child(
                        Button::new(SharedString::from(format!("checkin-{key}")))
                            .ghost()
                            .xsmall()
                            .icon(IconName::Calendar)
                            .tooltip(t(lang, "checkin"))
                            .loading(is_checkin)
                            .disabled(checked_today)
                            .on_click({
                                let weak = weak.clone();
                                move |_, _w, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.checkin_account(&p4, &a3, cx);
                                    });
                                }
                            }),
                    )
                })
                .child(
                    Button::new(SharedString::from(format!("acct-menu-{key}")))
                        .ghost()
                        .xsmall()
                        .icon(IconName::Ellipsis)
                        .tooltip(t(lang, "actions"))
                        .dropdown_menu({
                            let menu_for = menu_for.clone();
                            move |menu, window, cx| menu_for(menu, window, cx)
                        }),
                )
                .context_menu(move |menu, window, cx| menu_for(menu, window, cx))
                .into_any_element()
        };

        let accounts_card: AnyElement = if accounts_loading {
            skeleton_rows(4, cx)
        } else if accounts_count == 0 {
            card(cx)
                .p_4()
                .child(
                    Label::new(t(lang, "no_accounts"))
                        .text_sm()
                        .text_color(theme.muted_foreground),
                )
                .into_any_element()
        } else {
            // Size to content — one account should look like one row, not
            // a five-row void. Cap at 5 rows so long pools still scroll.
            let cap = accounts_count.min(5) as f32 * 52.;
            div()
                .h(px(cap))
                .child(card_uniform_list(
                    SharedString::from(format!("accounts-{provider}")),
                    accounts_count,
                    &account_scroll,
                    render_account,
                    cx,
                ))
                .into_any_element()
        };

        let provider_name4 = provider_name.clone();
        let mut accounts_footer = h_flex().items_center().gap_2().child(
            Button::new("add-account")
                .outline()
                .small()
                .label(t(lang, "add_account"))
                .icon(IconName::Plus)
                .on_click(cx.listener(move |this, _e: &ClickEvent, _w, cx| {
                    this.open_import_overlay(&provider_name4, cx);
                })),
        );
        if let Some(msg) = &self.import_result {
            accounts_footer = accounts_footer.child(enter(
                div().child(
                    Label::new(msg.clone())
                        .font_family(MONO)
                        .text_xs()
                        .text_color(theme.muted_foreground)
                        .truncate(),
                ),
                format!("import-{}", self.notice_nonce),
            ));
        }

        v_flex()
            .gap_4()
            .child(header)
            .children(checkin_card)
            .child(
                v_flex()
                    .gap_2()
                    .child(section_header(
                        tf(lang, "accounts_n", &[("n", &accounts.len().to_string())]),
                        None,
                        cx,
                    ))
                    .child(accounts_card)
                    .child(accounts_footer),
            )
            .into_any_element()
    }

    /// Paste-JSON import lives in an overlay card now — the page keeps just
    /// the "Add account" affordance and a result line.
    fn open_import_overlay(&mut self, provider: &str, cx: &mut Context<Self>) {
        let lang = self.lang;
        let p = provider.to_string();
        self.open_overlay(
            OverlayRequest {
                title: t(lang, "add_account").into(),
                width: px(460.),
                content: Some(std::rc::Rc::new(|root, _w, cx| {
                    let theme = cx.theme().clone();
                    v_flex()
                        .gap_2()
                        .child(Input::new(&root.import_input))
                        .when_some(root.import_result.clone(), |d, m| {
                            d.child(
                                Label::new(m)
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            )
                        })
                        .into_any_element()
                })),
                footer: Some(std::rc::Rc::new(move |_root, _w, cx| {
                    h_flex()
                        .justify_end()
                        .gap_2()
                        .child(
                            Button::new("import-cancel")
                                .outline()
                                .small()
                                .label(t(lang, "cancel"))
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.dismiss_overlay(cx);
                                })),
                        )
                        .child(
                            Button::new("import-ok")
                                .primary()
                                .small()
                                .label(t(lang, "import"))
                                .on_click(cx.listener({
                                    let p = p.clone();
                                    move |this, _, w, cx| {
                                        this.import_account(&p, w, cx);
                                    }
                                })),
                        )
                        .into_any_element()
                })),
                ..OverlayRequest::default()
            },
            cx,
        );
    }

    /// Per-account dialog: runtime status, stats, check-in state and the
    /// account's own model list (with refresh). The builder receives `&AppRoot`
    /// directly — the overlay renders inside `AppRoot::render` where the
    /// entity is already borrowed.
    pub(crate) fn open_account_overlay(
        &mut self,
        provider: &str,
        account: &gateway_core::AccountFile,
        cx: &mut Context<Self>,
    ) {
        let (p, a) = (provider.to_string(), account.id.clone());
        let title = account.display_label().to_string();
        let supports_checkin = CHECKIN_PROVIDERS.contains(&provider);
        self.open_overlay(
            OverlayRequest {
                title: title.into(),
                width: px(520.),
                content: Some(std::rc::Rc::new(move |root, _w, cx| {
                    let theme = cx.theme().clone();
                    let key = format!("{p}/{a}");
                    let lang = root.lang;
                    let state = root.account_states.get(&p).and_then(|m| m.get(&a)).cloned();
                    let checking = root.checkin_pending.contains(&key);
                    let checkin_msg = root.checkin_results.get(&key).cloned();
                    let refreshing = root.models_refresh_pending.contains(&key);
                    let testing = root.test_pending.contains(&key);
                    let test_msg = root.test_results.get(&key).cloned();
                    let state: Option<AccountRuntimeState> = state;

                    // ---- status + stats ----
                    let mut top = h_flex().gap_2().items_center().flex_wrap();
                    if let Some(s) = &state {
                        let (skey, color) = account_status_meta(s.status, &theme);
                        let mut status_txt = t(lang, skey).to_string();
                        if let Some(until) = s.cooldown_until {
                            let now = gateway_core::pool::now_ms();
                            if until > now {
                                status_txt =
                                    format!("{status_txt} · {}", short_duration(until - now));
                            }
                        }
                        top = top
                            .child(
                                div()
                                    .px_2()
                                    .py_0p5()
                                    .rounded(px(3.))
                                    .bg(color.opacity(0.18))
                                    .border_1()
                                    .border_color(color.opacity(0.35))
                                    .child(Label::new(status_txt).text_xs().text_color(color)),
                            )
                            .child(
                                Label::new(tf(
                                    lang,
                                    "requests_n",
                                    &[("n", &s.stats.total_requests.to_string())],
                                ))
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground),
                            );
                        if s.stats.total_requests > 0 {
                            let rate = s.stats.successful_requests as f64
                                / s.stats.total_requests as f64
                                * 100.;
                            top = top.child(
                                Label::new(tf(
                                    lang,
                                    "success_rate",
                                    &[("rate", &format!("{rate:.0}"))],
                                ))
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground),
                            );
                        }
                    } else {
                        top = top.child(
                            Label::new(t(lang, "no_runtime"))
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        );
                    }
                    // Test probe lives here (was a row button) — right side of
                    // the status strip.
                    top = top.child(div().flex_1()).child(
                        Button::new(SharedString::from(format!("dlg-test-{key}")))
                            .outline()
                            .xsmall()
                            .label(t(lang, "test"))
                            .loading(testing)
                            .on_click(cx.listener({
                                let (p, a) = (p.clone(), a.clone());
                                move |this, _, _w, cx| {
                                    this.test_account(&p, &a, cx);
                                }
                            })),
                    );
                    let mut body = v_flex().gap_3().child(top);

                    if let Some(err) = state.as_ref().and_then(|s| s.last_error.clone()) {
                        body = body.child(
                            Label::new(format!("{}: {err}", t(lang, "last_error")))
                                .text_xs()
                                .text_color(theme.danger),
                        );
                    }
                    if let Some(msg) = test_msg {
                        // What the test actually did — one line per step.
                        let log_lines = msg
                            .lines()
                            .map(|line| {
                                Label::new(line.to_string())
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.secondary_foreground)
                                    .into_any_element()
                            })
                            .collect::<Vec<_>>();
                        body = body.child(
                            div()
                                .w_full()
                                .rounded(theme.radius)
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.muted)
                                .px_2p5()
                                .py_2()
                                .child(v_flex().gap_1().children(log_lines)),
                        );
                    }

                    // ---- check-in ----
                    if supports_checkin {
                        let checkin = state.as_ref().and_then(|s| s.checkin.clone());
                        let today = cn_today();
                        let checked = checkin.as_ref().and_then(|c| c.last_day.as_deref())
                            == Some(today.as_str());
                        let value = match &checkin {
                            Some(c) => {
                                let mut v = String::new();
                                if let Some(day) = &c.last_day {
                                    v.push_str(day);
                                }
                                if let Some(credits) = c.last_credits {
                                    v.push_str(&format!("  +{credits:.0}"));
                                }
                                if v.is_empty() {
                                    v = t(lang, "never_checked_in").to_string();
                                }
                                v
                            }
                            None => t(lang, "never_checked_in").to_string(),
                        };
                        let last_err = checkin.as_ref().and_then(|c| c.last_error.clone());
                        body = body.child(hairline(cx)).child(
                            h_flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    Label::new(t(lang, "checkin"))
                                        .text_xs()
                                        .font_semibold()
                                        .text_color(theme.secondary_foreground),
                                )
                                .child(
                                    Label::new(value)
                                        .font_family(MONO)
                                        .text_xs()
                                        .text_color(theme.muted_foreground),
                                )
                                .child(div().flex_1())
                                .child(
                                    Button::new(SharedString::from(format!("dlg-checkin-{key}")))
                                        .ghost()
                                        .xsmall()
                                        .label(t(
                                            lang,
                                            if checked {
                                                "checked_in_today"
                                            } else {
                                                "checkin_now"
                                            },
                                        ))
                                        .disabled(checked)
                                        .loading(checking)
                                        .on_click(cx.listener({
                                            let (p, a) = (p.clone(), a.clone());
                                            move |this, _, _w, cx| {
                                                this.checkin_account(&p, &a, cx);
                                            }
                                        })),
                                ),
                        );
                        if let Some(err) = last_err {
                            body = body.child(
                                Label::new(err)
                                    .text_xs()
                                    .text_color(theme.danger)
                                    .truncate(),
                            );
                        }
                        if let Some(msg) = &checkin_msg {
                            body = body.child(
                                Label::new(msg.clone())
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .truncate(),
                            );
                        }
                    }

                    // ---- models (per-account) ----
                    let models = state
                        .as_ref()
                        .map(|s| s.model_ids.clone())
                        .unwrap_or_default();
                    let mut chips = h_flex().gap_1p5().flex_wrap();
                    if models.is_empty() {
                        chips = chips.child(
                            Label::new(t(lang, "no_models_yet"))
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        );
                    } else {
                        for m in models.iter().take(60) {
                            chips = chips.child(
                                div()
                                    .px_2()
                                    .py_1()
                                    .rounded(theme.radius)
                                    .bg(theme.muted)
                                    .child(
                                        Label::new(m.clone())
                                            .font_family(MONO)
                                            .text_xs()
                                            .text_color(theme.secondary_foreground)
                                            .whitespace_nowrap(),
                                    ),
                            );
                        }
                        if models.len() > 60 {
                            chips = chips.child(
                                Label::new(tf(
                                    lang,
                                    "n_more",
                                    &[("n", &(models.len() - 60).to_string())],
                                ))
                                .text_xs()
                                .text_color(theme.muted_foreground),
                            );
                        }
                    }
                    body = body
                        .child(hairline(cx))
                        .child(
                            h_flex()
                                .items_center()
                                .gap_2()
                                .child(
                                    Label::new(t(lang, "models"))
                                        .text_xs()
                                        .font_semibold()
                                        .text_color(theme.secondary_foreground),
                                )
                                .child(
                                    Button::new(SharedString::from(format!("dlg-models-{key}")))
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::RotateCw)
                                        .tooltip(t(lang, "refresh_models"))
                                        .loading(refreshing)
                                        .on_click(cx.listener({
                                            let (p, a) = (p.clone(), a.clone());
                                            move |this, _, _w, cx| {
                                                this.refresh_account_models(&p, &a, cx);
                                            }
                                        })),
                                ),
                        )
                        // The chip wall wraps row after row — bound it and
                        // scroll inside so big catalogs can't push content
                        // past the panel's max height.
                        .child(
                            div()
                                .id(SharedString::from(format!("dlg-models-scroll-{key}")))
                                .w_full()
                                .max_h(px(168.))
                                .overflow_y_scroll()
                                .child(chips),
                        );

                    body.into_any_element()
                })),
                ..OverlayRequest::default()
            },
            cx,
        );
    }
}
