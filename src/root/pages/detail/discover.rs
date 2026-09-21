//! Discover pane of the add-account dialog — candidate list built from the
//! local-credential scan, with locked rows for existing non-updatable
//! accounts.

use gpui_kit::component::{
    ActiveTheme, Disableable, checkbox::Checkbox, h_flex, label::Label, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{AppRoot, MONO, t};

/// Discover pane — candidate list with checkboxes; `existing && !updatable`
/// rows are dimmed and locked, matching the Electron dialog. Providers that
/// aren't live yet get a coming-soon placeholder.
pub(super) fn discover_overlay_body(
    provider: &str,
    root: &AppRoot,
    cx: &mut Context<AppRoot>,
) -> AnyElement {
    let theme = cx.theme().clone();
    let lang = root.lang;
    let root_entity = cx.entity();

    if !AppRoot::discover_live(provider) {
        return Label::new(t(lang, "coming_soon"))
            .text_xs()
            .text_color(theme.muted_foreground)
            .into_any_element();
    }
    if root.discover_loading {
        return Label::new(t(lang, "discover_scanning"))
            .text_xs()
            .text_color(theme.muted_foreground)
            .into_any_element();
    }
    if root.discover_candidates.is_empty() {
        return Label::new(t(lang, "discover_empty"))
            .text_xs()
            .text_color(theme.muted_foreground)
            .into_any_element();
    }

    let mut list = v_flex().gap_0p5();
    for c in &root.discover_candidates {
        let id = c.account.id.clone();
        let locked = c.existing && !c.updatable;
        let checked = root.discover_selected.contains(&id);
        let sub = c
            .account
            .email
            .clone()
            .filter(|e| !e.is_empty())
            .or_else(|| {
                c.account
                    .field_str("refreshToken")
                    .map(|r| format!("{}…", &r[..r.len().min(20)]))
            })
            .unwrap_or_else(|| c.source.clone());
        let tag = if c.existing {
            if c.updatable {
                format!(
                    "{} · {}",
                    t(lang, "discover_exists"),
                    t(lang, "discover_updatable")
                )
            } else {
                t(lang, "discover_exists").to_string()
            }
        } else {
            c.source.clone()
        };
        let e = root_entity.clone();
        let cid = id.clone();
        list = list.child(
            h_flex()
                .items_center()
                .gap_2()
                .px_2()
                .py_1p5()
                .rounded(theme.radius)
                .when(locked, |d| d.opacity(0.4))
                .child(
                    Checkbox::new(SharedString::from(format!("disc-{id}")))
                        .checked(checked)
                        .disabled(locked)
                        .on_click(move |&val, _w, app| {
                            let e = e.clone();
                            let cid = cid.clone();
                            app.update_entity(&e, |this, cx| {
                                this.toggle_discover_candidate(&cid, val, cx);
                            });
                        }),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(
                            Label::new(c.account.display_label().to_string())
                                .text_xs()
                                .text_color(theme.foreground)
                                .truncate(),
                        )
                        .child(
                            Label::new(sub)
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground)
                                .truncate(),
                        ),
                )
                .child(
                    div()
                        .flex_none()
                        .rounded(theme.radius)
                        .bg(theme.accent)
                        .px_1p5()
                        .py_0p5()
                        .child(
                            Label::new(tag)
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                ),
        );
    }

    v_flex()
        .gap_2()
        .child(
            Label::new(t(lang, "discover_tip"))
                .text_xs()
                .text_color(theme.muted_foreground),
        )
        .child(
            div()
                .id("discover-list")
                .max_h(px(220.))
                .overflow_y_scroll()
                .track_scroll(&root.discover_scroll)
                .child(list),
        )
        .when_some(root.cli_login_err.clone(), |d, e| {
            d.child(
                Label::new(e)
                    .text_xs()
                    .text_color(theme.danger)
                    .whitespace_normal(),
            )
        })
        .into_any_element()
}
