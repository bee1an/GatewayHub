//! Account overlays — the add-account dialog (JSON import / CLI login /
//! Discover panes) and the per-account detail dialog, plus their builders.

use gateway_core::types::AccountRuntimeState;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    scroll::ScrollableElement,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{
    AppRoot, DIALOG_W_LG, DIALOG_W_MD, MONO, OverlayRequest, SCROLL_H_MD, SCROLL_H_SM, hairline, t,
    tf, toggle_filter,
};

use super::{
    CHECKIN_PROVIDERS, account_status_meta, cn_today, discover::discover_overlay_body,
    short_duration,
};

impl AppRoot {
    /// Paste-JSON import lives in an overlay card now — the page keeps just
    /// the "Add account" affordance and a result line.
    fn open_import_overlay(&mut self, provider: &str, cx: &mut Context<Self>) {
        let lang = self.lang;
        let p = provider.to_string();
        self.open_overlay(
            OverlayRequest {
                title: t(lang, "add_account").into(),
                width: DIALOG_W_MD,
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
                                .label(t(lang, "cancel"))
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.dismiss_overlay(cx);
                                })),
                        )
                        .child(
                            Button::new("import-ok")
                                .primary()
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

    /// "Add account" — providers get whichever extra tabs they support next to
    /// paste-JSON: CLI detect/login (kiro/qoder) and the local-credential
    /// Discover scan (live for traework/workbuddy; kiro/trae/windsurf show a
    /// coming-soon placeholder).
    pub(crate) fn open_add_account_overlay(&mut self, provider: &str, cx: &mut Context<Self>) {
        let cli = Self::cli_capable(provider);
        let discover = Self::discover_capable(provider);
        if !cli && !discover {
            return self.open_import_overlay(provider, cx);
        }
        let lang = self.lang;
        self.cli_provider = Some(provider.to_string());
        self.cli_tab = 0;
        self.cli_login_output.clear();
        self.cli_login_err = None;
        self.cli_import_msg = None;
        self.cli_import_busy = false;
        self.cli_copy_ok = false;
        self.discover_loading = false;
        self.discover_candidates.clear();
        self.discover_selected.clear();
        self.discover_import_busy = false;
        self.import_result = None;
        let p = provider.to_string();
        self.open_overlay(
            OverlayRequest {
                title: t(lang, "add_account").into(),
                width: DIALOG_W_LG,
                content: Some(std::rc::Rc::new(move |root, _w, cx| {
                    add_account_body(&p, root, cx)
                })),
                footer: Some(std::rc::Rc::new(|root, _w, cx| {
                    add_account_footer(root, cx)
                })),
                ..OverlayRequest::default()
            },
            cx,
        );
        if cli {
            self.start_cli_detect(provider, cx);
        }
        if discover {
            self.start_discover_scan(provider, cx);
        }
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
        self.ensure_account_models(&p, &a, cx);
        self.open_overlay(
            OverlayRequest {
                title: title.into(),
                width: DIALOG_W_LG,
                content: Some(std::rc::Rc::new(move |root, _w, cx| {
                    let theme = cx.theme().clone();
                    let key = format!("{p}/{a}");
                    let lang = root.lang;
                    let state = root.account_states.get(&p).and_then(|m| m.get(&a)).cloned();
                    let checking = root.checkin_pending.contains(&key);
                    let checkin_msg = root.checkin_results.get(&key).cloned();
                    let refreshing = root.models_refresh_pending.contains(&key);
                    let models_msg = root.models_refresh_results.get(&key).cloned();
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
                                    .rounded_sm()
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
                            .small()
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
                        let balance = checkin
                            .as_ref()
                            .and_then(|c| c.extra.get("creditsTotal"))
                            .and_then(|v| v.as_f64());
                        let work_credits = checkin
                            .as_ref()
                            .and_then(|c| c.extra.get("creditsWork"))
                            .and_then(|v| v.as_f64())
                            .filter(|w| *w > 0.0);
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
                                        .small()
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
                        if let Some(b) = balance {
                            let mut line = format!("{} {}", t(lang, "credits_balance"), b as u64);
                            if let Some(w) = work_credits {
                                line.push_str(&format!(
                                    " · {} {}",
                                    t(lang, "credits_work_only"),
                                    w as u64
                                ));
                            }
                            body = body.child(
                                Label::new(line)
                                    .text_xs()
                                    .text_color(theme.muted_foreground),
                            );
                        }
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
                                        .small()
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
                                .w_full()
                                .relative()
                                .child(
                                    div()
                                        .id(SharedString::from(format!("dlg-models-scroll-{key}")))
                                        .w_full()
                                        .max_h(SCROLL_H_MD)
                                        .overflow_y_scroll()
                                        .track_scroll(&root.models_scroll)
                                        .child(chips),
                                )
                                .vertical_scrollbar(&root.models_scroll),
                        );
                    if let Some(msg) = &models_msg {
                        body = body.child(
                            Label::new(msg.clone())
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .truncate(),
                        );
                    }

                    body.into_any_element()
                })),
                ..OverlayRequest::default()
            },
            cx,
        );
    }
}

/// Which pane an add-account tab index maps to — the tab list is ordered
/// [CLI?] [Discover?] [JSON] with the optional ones gated per provider.
#[derive(Clone, Copy, PartialEq, Eq)]
enum AcctPane {
    Cli,
    Discover,
    Json,
}

/// The tab list for a provider, in display order.
fn acct_panes(provider: &str, lang: crate::root::i18n::Lang) -> Vec<(SharedString, AcctPane)> {
    let mut panes = Vec::new();
    if AppRoot::cli_capable(provider) {
        panes.push(("CLI".into(), AcctPane::Cli));
    }
    if AppRoot::discover_capable(provider) {
        panes.push((t(lang, "discover_tab").into(), AcctPane::Discover));
    }
    panes.push(("JSON".into(), AcctPane::Json));
    panes
}

fn acct_pane(provider: &str, lang: crate::root::i18n::Lang, ix: usize) -> AcctPane {
    acct_panes(provider, lang)
        .get(ix)
        .map(|(_, p)| *p)
        .unwrap_or(AcctPane::Json)
}

/// Add-account body — tab strip plus the active pane: CLI detect/login,
/// Discover candidate list, or the plain JSON import box.
fn add_account_body(provider: &str, root: &AppRoot, cx: &mut Context<AppRoot>) -> AnyElement {
    let theme = cx.theme().clone();
    let lang = root.lang;
    let root_entity = cx.entity();

    let pane = acct_pane(provider, lang, root.cli_tab);
    let mut body = v_flex().gap_3().child(toggle_filter(
        "add-acct-tab",
        acct_panes(provider, lang)
            .into_iter()
            .enumerate()
            .map(|(ix, (label, _))| (label, root.cli_tab == ix))
            .collect(),
        move |ix, _w, app| {
            let e = root_entity.clone();
            app.update_entity(&e, |this, cx| {
                this.cli_tab = ix;
                cx.notify();
            });
        },
        cx,
    ));

    match pane {
        AcctPane::Json => {
            return body
                .child(Input::new(&root.import_input))
                .when_some(root.import_result.clone(), |d, m| {
                    d.child(
                        Label::new(m)
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme.muted_foreground),
                    )
                })
                .into_any_element();
        }
        AcctPane::Discover => {
            return body
                .child(discover_overlay_body(provider, root, cx))
                .into_any_element();
        }
        AcctPane::Cli => {}
    }

    let bin = gateway_core::cli_login::cli_bin(provider).unwrap_or("cli");

    if root.cli_login_active {
        body = body.child(cli_login_progress(provider, root, cx));
    } else if root.cli_detecting {
        body = body.child(
            Label::new(tf(lang, "cli_detecting", &[("bin", bin)]))
                .text_xs()
                .text_color(theme.muted_foreground),
        );
    } else {
        match &root.cli_detect {
            Some(d) if d.found => {
                body = body
                    .child(
                        h_flex()
                            .items_center()
                            .gap_2()
                            .child(
                                Label::new(tf(lang, "cli_found", &[("path", &d.path)]))
                                    .text_xs()
                                    .text_color(theme.muted_foreground)
                                    .truncate(),
                            )
                            .when_some(d.version.clone(), |el, v| {
                                el.child(
                                    Label::new(v)
                                        .font_family(MONO)
                                        .text_xs()
                                        .text_color(theme.secondary_foreground),
                                )
                            }),
                    )
                    .child(
                        h_flex()
                            .gap_2()
                            .child(
                                Button::new("cli-login")
                                    .primary()
                                    .small()
                                    .label(t(lang, "cli_login"))
                                    .on_click(cx.listener(|this, _, _w, cx| {
                                        this.begin_cli_login(cx);
                                    })),
                            )
                            .when(provider == "qoder", |d| {
                                d.child(
                                    Button::new("cli-import-current")
                                        .outline()
                                        .small()
                                        .label(t(lang, "cli_import_current"))
                                        .loading(root.cli_import_busy)
                                        .on_click(cx.listener(|this, _, _w, cx| {
                                            this.import_current_cli_auth(cx);
                                        })),
                                )
                            }),
                    );
            }
            _ => {
                body = body.child(
                    v_flex()
                        .gap_1()
                        .child(
                            Label::new(tf(lang, "cli_not_found", &[("bin", bin)]))
                                .text_xs()
                                .text_color(theme.warning_foreground),
                        )
                        .child(
                            Label::new(tf(lang, "cli_install_hint", &[("bin", bin)]))
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .whitespace_normal(),
                        ),
                );
            }
        }
    }
    if let Some(e) = &root.cli_login_err {
        body = body.child(
            Label::new(e.clone())
                .text_xs()
                .text_color(theme.danger)
                .whitespace_normal(),
        );
    }
    if let Some(m) = &root.cli_import_msg {
        body = body.child(
            Label::new(m.clone())
                .font_family(MONO)
                .text_xs()
                .text_color(theme.muted_foreground)
                .whitespace_normal(),
        );
    }
    body.into_any_element()
}

/// Login-in-progress pane — once the device flow prints its URL (+ code for
/// kiro) swap the raw output for a copyable link card; otherwise stream the
/// terminal output into a scroll box.
fn cli_login_progress(provider: &str, root: &AppRoot, cx: &mut Context<AppRoot>) -> AnyElement {
    let theme = cx.theme().clone();
    let lang = root.lang;
    let output = &root.cli_login_output;
    let url = extract_login_url(output);
    let code = if provider == "kiro" {
        extract_device_code(output)
    } else {
        None
    };

    let content: AnyElement = if url.is_some() || code.is_some() {
        let url = url.unwrap_or_else(|| "https://device.sso.us-east-1.amazonaws.com/".into());
        v_flex()
            .gap_2()
            .child(
                Label::new(t(
                    lang,
                    if provider == "kiro" {
                        "cli_open_hint"
                    } else {
                        "cli_open_hint_plain"
                    },
                ))
                .text_xs()
                .text_color(theme.muted_foreground)
                .whitespace_normal(),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .rounded(theme.radius)
                            .bg(theme.accent)
                            .px_2()
                            .py_1p5()
                            .child(
                                Label::new(url.clone())
                                    .font_family(MONO)
                                    .text_xs()
                                    .text_color(theme.foreground)
                                    .truncate(),
                            ),
                    )
                    .child(
                        Button::new("cli-copy-link")
                            .outline()
                            .small()
                            .label(t(lang, if root.cli_copy_ok { "copied" } else { "copy" }))
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                cx.write_to_clipboard(ClipboardItem::new_string(url.clone()));
                                this.cli_copy_ok = true;
                                cx.notify();
                                cx.spawn(async move |this, cx| {
                                    smol::Timer::after(std::time::Duration::from_secs(2)).await;
                                    let _ = this.update(cx, |this, cx| {
                                        this.cli_copy_ok = false;
                                        cx.notify();
                                    });
                                })
                                .detach();
                            })),
                    ),
            )
            .when_some(code, |d, c| {
                d.child(
                    div().flex().justify_center().py_2().child(
                        Label::new(c)
                            .font_family(MONO)
                            .text_lg()
                            .font_medium()
                            .text_color(theme.foreground),
                    ),
                )
            })
            .child(
                Label::new(t(lang, "cli_wait"))
                    .text_xs()
                    .text_color(theme.muted_foreground),
            )
            .into_any_element()
    } else {
        div()
            .relative()
            .child(
                div()
                    .id("cli-login-output")
                    .max_h(SCROLL_H_SM)
                    .overflow_y_scroll()
                    .track_scroll(&root.cli_scroll)
                    .rounded(theme.radius)
                    .bg(theme.accent)
                    .p_3()
                    .child(
                        Label::new(if output.is_empty() {
                            SharedString::from("…")
                        } else {
                            SharedString::from(output.clone())
                        })
                        .font_family(MONO)
                        .text_xs()
                        .text_color(theme.secondary_foreground)
                        .whitespace_normal(),
                    ),
            )
            .vertical_scrollbar(&root.cli_scroll)
            .into_any_element()
    };

    v_flex()
        .gap_2()
        .child(content)
        .child(
            h_flex().child(
                Button::new("cli-cancel")
                    .outline()
                    .small()
                    .label(t(lang, "cancel"))
                    .on_click(cx.listener(|this, _, _w, cx| this.cancel_cli_login(cx))),
            ),
        )
        .into_any_element()
}

/// Footer — Cancel always; Import on the JSON tab, Add (n) on Discover.
fn add_account_footer(root: &AppRoot, cx: &mut Context<AppRoot>) -> AnyElement {
    let lang = root.lang;
    let provider = root.cli_provider.clone().unwrap_or_default();
    let pane = acct_pane(&provider, lang, root.cli_tab);
    h_flex()
        .justify_end()
        .gap_2()
        .child(
            Button::new("cli-overlay-cancel")
                .outline()
                .label(t(lang, "cancel"))
                .on_click(cx.listener(|this, _, _w, cx| this.dismiss_overlay(cx))),
        )
        .when(
            pane == AcctPane::Discover && AppRoot::discover_live(&provider),
            |d| {
                d.child(
                    Button::new("discover-import")
                        .primary()
                        .label(tf(
                            lang,
                            "discover_add",
                            &[("n", &root.discover_selected.len().to_string())],
                        ))
                        .disabled(
                            root.discover_selected.is_empty()
                                || root.discover_loading
                                || root.discover_import_busy,
                        )
                        .loading(root.discover_import_busy)
                        .on_click(cx.listener(|this, _, _w, cx| {
                            this.import_discover_selected(cx);
                        })),
                )
            },
        )
        .when(pane == AcctPane::Json, |d| {
            d.child(
                Button::new("cli-overlay-import")
                    .primary()
                    .label(t(lang, "import"))
                    .on_click(cx.listener(move |this, _, w, cx| {
                        this.import_account(&provider, w, cx);
                    })),
            )
        })
        .into_any_element()
}

/// First `http(s)://…` link in the CLI output — the device-flow verify URL.
fn extract_login_url(output: &str) -> Option<String> {
    let mut rest = output;
    while let Some(i) = rest.find("http") {
        let tail = &rest[i..];
        if tail.starts_with("http://") || tail.starts_with("https://") {
            let end = tail
                .find(|c: char| c.is_whitespace() || c == '"' || c == '\'')
                .unwrap_or(tail.len());
            return Some(tail[..end].to_string());
        }
        rest = &tail[4..];
    }
    None
}

/// `Code: ABCD-1234` line the kiro device flow prints.
fn extract_device_code(output: &str) -> Option<String> {
    let lower = output.to_lowercase();
    let i = lower.find("code:")?;
    let tail = output[i + 5..].trim_start();
    let code: String = tail
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    (!code.is_empty()).then_some(code)
}
