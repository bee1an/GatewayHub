//! Sidebar chrome — rail geometry constants, the sliding selection pill,
//! and the row/section-label builders used by `Render for AppRoot`.

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme, StyledExt, label::Label, tooltip::Tooltip};
use gpui_kit::prelude::*;
use gpui_kit::*;

use super::Page;

/// Sidebar geometry lives on the rem scale so the rail follows interface
/// zoom instead of pinning a physical pixel width.
pub(crate) const SIDEBAR_W: Rems = rems(9.25); // 148px @16
pub(crate) const SIDEBAR_W_COLLAPSED: Rems = rems(4.5); // 72px @16
/// Fixed row height — every nav row shares this so icons and labels sit on
/// one vertical spine.
pub(crate) const NAV_ROW_H: Rems = rems(2.); // 32px @16
/// Leading icon lane — fixed width so labels align whether or not a row
/// carries an icon.
pub(crate) const ICON_LANE: Rems = rems(2.5); // 40px @16
/// Nav icon size — compact but still legible in the 32px navigation row.
/// `provider_logo` takes a px size for its optical frame, so this stays a
/// scalar; callers multiply by `window.rem_size()` when they need pixels.
pub(crate) const NAV_ICON: f32 = 15.;

/// Row pitch — NAV_ROW_H plus the gap_0p5 spacing between rows (2px @16).
pub(crate) const NAV_PITCH: Rems = rems(2.125);

/// Primary destinations in rail order — the selection pill's slot index
/// is a row's position in this table.
pub(crate) const NAV_ITEMS: [(Page, &str, IconName, &str); 7] = [
    (
        Page::Dashboard,
        "nav-dashboard",
        IconName::LayoutDashboard,
        "nav_dashboard",
    ),
    (Page::Logs, "nav-logs", IconName::FileText, "nav_logs"),
    (
        Page::Playground,
        "nav-playground",
        IconName::Bot,
        "nav_playground",
    ),
    (
        Page::ApiKeys,
        "nav-apikeys",
        IconName::Asterisk,
        "nav_api_keys",
    ),
    (
        Page::Mappings,
        "nav-mappings",
        IconName::Replace,
        "nav_mappings",
    ),
    (Page::Usage, "nav-usage", IconName::ChartPie, "nav_usage"),
    (
        Page::Settings,
        "nav-settings",
        IconName::Settings,
        "nav_settings",
    ),
];

/// The sliding selection highlight — a single pill mounted inside
/// whichever rail zone (primary nav or provider list) currently holds
/// the selection. Every mount shares the `nav-sel-pill` spring id, so
/// position and velocity carry across target changes and the fill
/// physically glides to the new row's slot (Heimdall's outline pill,
/// adapted to two zones). `target_y` is the slot's Y in the zone's
/// content space. First paint passes `animate: false` so the pill snaps
/// into place instead of travelling from a stale position.
pub(crate) fn nav_sel_pill(
    target_y: Rems,
    animate: bool,
    collapsed: bool,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    div()
        .absolute()
        .left_0()
        .right_0()
        .h(NAV_ROW_H)
        .rounded(theme.radius)
        .bg(theme.list_active)
        // Collapsed rows shrink to a centered 40px tile — match it.
        .when(collapsed, |d| d.w_10().mx_auto())
        .with_spring(
            "nav-sel-pill",
            SpringAnimation::new(SpringConfig::new(300., 26., 1.))
                .to(target_y)
                .playback(if animate {
                    SpringPlayback::Running
                } else {
                    SpringPlayback::Completed
                }),
            |el, pos| el.top(pos),
        )
}

/// One sidebar row: fixed height, leading icon lane, then the label.
/// The selection fill is painted by the pill behind the row — the row
/// itself only tints its icon and label.
pub(crate) fn nav_row(
    id: impl Into<ElementId>,
    glyph: AnyElement,
    label: SharedString,
    active: bool,
    collapsed: bool,
    cx: &App,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    let theme = cx.theme().clone();
    div()
        .id(id)
        .h(NAV_ROW_H)
        .px_2()
        .flex()
        .items_center()
        .gap_0()
        .rounded(theme.radius)
        .cursor_pointer()
        .focusable()
        .focus_visible(|style| {
            style
                .border_color(theme.ring)
                .border_1()
                .rounded(theme.radius)
        })
        .when(!active, |d| d.hover(|d| d.bg(theme.list_hover)))
        .when(collapsed, |d| {
            let tip = label.clone();
            d.w_10()
                .mx_auto()
                .px_0()
                .justify_center()
                .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
        })
        .child(
            div()
                .w(ICON_LANE)
                .flex_none()
                .flex()
                .items_center()
                .justify_center()
                .child(glyph),
        )
        .when(!collapsed, |d| {
            d.child(
                Label::new(label)
                    .text_sm()
                    .when(active, |l| l.font_medium())
                    .text_color(if active {
                        theme.foreground
                    } else {
                        theme.muted_foreground
                    })
                    .truncate(),
            )
        })
}

/// Section label inside the sidebar — same quiet eyebrow as page sections.
pub(crate) use super::chrome::section_label as sidebar_section_label;
