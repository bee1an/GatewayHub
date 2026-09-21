//! Provider detail — header tile, check-in settings (TraeWork/WorkBuddy),
//! accounts card, import dialog. Per-account models/checkin live in the
//! account dialog — models differ per account, so they are not a
//! provider-level surface.

use gateway_core::GatewayStatusSnapshot;
use gateway_core::types::AccountStatus;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    label::Label,
    menu::{ContextMenuExt, PopupMenu, PopupMenuItem},
    popover::Popover,
    switch::Switch,
    tooltip::Tooltip,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, MONO, card, card_uniform_list, enter, provider_logo, row, section_header,
    skeleton_rows, status_label, t, tf,
};

mod discover;
mod overlays;

/// Providers that expose daily check-in (`checkin_accounts`).
pub(crate) const CHECKIN_PROVIDERS: &[&str] = &["traework", "workbuddy"];

/// Holds the built `PopupMenu` entity for a row's ⋯ popover — built once,
/// rebuilt after each dismiss (same contract as `dropdown_menu` internals).
#[derive(Default)]
struct AcctMenuState {
    menu: Option<Entity<PopupMenu>>,
}

/// YYYY-MM-DD in Asia/Shanghai — same day key the checkin state stores.
pub(crate) fn cn_today() -> String {
    chrono::DateTime::from_timestamp_millis(gateway_core::pool::now_ms())
        .map(|d| {
            d.with_timezone(&chrono::FixedOffset::east_opt(8 * 3600).expect("validated invariant"))
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

        // Coming-soon providers keep the page reachable from the sidebar
        // (the row stays openable) but the whole management surface is a
        // placeholder — no toggles, no accounts, no add-account.
        if !Self::provider_live(provider) {
            let provider_type = status.map(|p| p.provider_type.as_str()).unwrap_or_default();
            return v_flex()
                .w_full()
                .child(
                    h_flex()
                        .w_full()
                        .items_center()
                        .gap_3()
                        .pt_1()
                        .pb_2()
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
                        .child(provider_logo(provider_type, 24., true, cx))
                        .child(
                            Label::new(provider.to_string())
                                .text_base()
                                .font_semibold()
                                .text_color(theme.foreground),
                        ),
                )
                .child(
                    v_flex().w_full().py_20().items_center().child(
                        Label::new(t(lang, "coming_soon"))
                            .text_lg()
                            .text_color(theme.muted_foreground),
                    ),
                )
                .into_any_element();
        }

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
        let proxy_capable = status.is_some_and(|p| p.use_proxy.is_some());
        let use_proxy = status.and_then(|p| p.use_proxy).unwrap_or(false);

        let header = h_flex()
            .w_full()
            .items_center()
            .gap_3()
            .pt_1()
            .pb_2()
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
            .child(provider_logo(provider_type, 24., !enabled, cx))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap_0p5()
                    .child(
                        // Name + status share one line — a dedicated status
                        // row costs a whole text line of header height.
                        h_flex()
                            .w_full()
                            .min_w_0()
                            .items_center()
                            .gap_2()
                            .child(
                                Label::new(provider.to_string())
                                    .text_base()
                                    .font_semibold()
                                    .text_color(theme.foreground)
                                    .whitespace_nowrap()
                                    .overflow_hidden(),
                            )
                            .child(div().size_1p5().flex_none().rounded_full().bg(status_color))
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
                    .when(proxy_capable, |d| {
                        d.child(
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
                        .child(div().w(px(1.)).h(px(14.)).bg(theme.border))
                    })
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
                // list-row style. The trailing actions sit in a
                // bubble-stop wrapper so they don't re-trigger this.
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
                .when_some(checkin_badge, |r, badge| r.child(badge))
                .child({
                    // Row actions live in one bubble-stop wrapper: Button
                    // clicks propagate (gpui-component only stops them
                    // while `loading`), so without this every action would
                    // also fire the row's open-overlay handler.
                    h_flex()
                        .id(SharedString::from(format!("acct-actions-{key}")))
                        .items_center()
                        .gap_1()
                        .on_click(|_, _, cx| cx.stop_propagation())
                        .when(supports_checkin, |d| {
                            d.child(
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
                        .child({
                            // Hand-rolled popover instead of `dropdown_menu` — the
                            // helper sets overlay_closable(false), removing the
                            // popover's own outside-click dismiss and leaning on the
                            // menu's mouse_down_out alone. The default popover
                            // dismisses on any outside mousedown and returns focus
                            // through PopoverState, so the menu reliably closes.
                            let menu_state = _window.use_keyed_state(
                                SharedString::from(format!("acct-menu-state:{key}")),
                                _app,
                                |_, _| AcctMenuState::default(),
                            );
                            Popover::new(SharedString::from(format!("acct-menu-pop:{key}")))
                                .appearance(false)
                                .anchor(Anchor::TopRight)
                                .trigger(
                                    Button::new(SharedString::from(format!("acct-menu-{key}")))
                                        .ghost()
                                        .xsmall()
                                        .icon(IconName::Ellipsis)
                                        .tooltip(t(lang, "actions")),
                                )
                                .content({
                                    let menu_state = menu_state.clone();
                                    let menu_for = menu_for.clone();
                                    move |_, window, cx| match menu_state.read(cx).menu.clone() {
                                        Some(menu) => menu,
                                        None => {
                                            let builder = menu_for.clone();
                                            let menu =
                                                PopupMenu::build(window, cx, move |m, w, cx| {
                                                    builder(m, w, cx)
                                                });
                                            menu_state.update(cx, |state, _| {
                                                state.menu = Some(menu.clone());
                                            });
                                            menu.focus_handle(cx).focus(window, cx);
                                            let popover_state = cx.entity();
                                            window
                                                .subscribe(&menu, cx, {
                                                    let menu_state = menu_state.clone();
                                                    move |_, _: &DismissEvent, window, cx| {
                                                        popover_state.update(cx, |state, cx| {
                                                            state.dismiss(window, cx);
                                                        });
                                                        menu_state.update(cx, |state, _| {
                                                            state.menu = None;
                                                        });
                                                    }
                                                })
                                                .detach();
                                            menu
                                        }
                                    }
                                })
                        })
                })
                // Disclosure chevron stays rightmost — accessories first,
                // chevron last (standard list-row order).
                .child(
                    Icon::new(IconName::ChevronRight)
                        .size_3p5()
                        .text_color(theme_for_rows.muted_foreground),
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
        let add_btn = Button::new("add-account")
            .outline()
            .small()
            .icon(IconName::Plus)
            .label(t(lang, "add_account"))
            .on_click(cx.listener(move |this, _e: &ClickEvent, _w, cx| {
                this.open_add_account_overlay(&provider_name4, cx);
            }));

        v_flex()
            .gap_4()
            .child(header)
            .children(checkin_card)
            .child(
                v_flex()
                    .gap_2()
                    .child(section_header(
                        tf(lang, "accounts_n", &[("n", &accounts.len().to_string())]),
                        Some(add_btn.into_any_element()),
                        cx,
                    ))
                    .child(accounts_card)
                    .when_some(self.import_result.clone(), |d, msg| {
                        d.child(enter(
                            div().child(
                                Label::new(msg)
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .truncate(),
                            ),
                            format!("import-{}", self.notice_nonce),
                        ))
                    }),
            )
            .into_any_element()
    }
}
