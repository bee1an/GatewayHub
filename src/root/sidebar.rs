//! Sidebar chrome — rail geometry constants, the sliding selection pill,
//! and the row/section-label builders used by `Render for AppRoot`.

use gpui_kit::assets::IconName;
use gpui_kit::component::{ActiveTheme, StyledExt, label::Label, tooltip::Tooltip};
use gpui_kit::prelude::*;
use gpui_kit::*;

use super::Page;

pub(crate) const SIDEBAR_W: f32 = 148.;
pub(crate) const SIDEBAR_W_COLLAPSED: f32 = 72.;
/// Fixed row height — every nav row shares this so icons and labels sit on
/// one vertical spine.
pub(crate) const NAV_ROW_H: f32 = 32.;
/// Leading icon lane — fixed width so labels align whether or not a row
/// carries an icon.
pub(crate) const ICON_LANE: f32 = 40.;
/// Nav icon size — compact but still legible in the 32px navigation row.
pub(crate) const NAV_ICON: f32 = 15.;

/// Row pitch — NAV_ROW_H plus the gap_0p5 spacing between rows.
pub(crate) const NAV_PITCH: f32 = NAV_ROW_H + 2.;

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
    target_y: f32,
    animate: bool,
    collapsed: bool,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme();
    div()
        .absolute()
        .left_0()
        .right_0()
        .h(px(NAV_ROW_H))
        .rounded(theme.radius)
        .bg(theme.list_active)
        // Collapsed rows shrink to a centered 40px tile — match it.
        .when(collapsed, |d| d.w_10().mx_auto())
        .with_spring(
            "nav-sel-pill",
            SpringAnimation::new(SpringConfig::new(300., 26., 1.))
                .to(px(target_y))
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
        .h(px(NAV_ROW_H))
        .px_2()
        .flex()
        .items_center()
        .gap_0()
        .rounded(theme.radius)
        .cursor_pointer()
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
                .w(px(ICON_LANE))
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

/// Section label inside the sidebar — quiet eyebrow between nav and providers.
pub(crate) fn sidebar_section_label(text: &str, cx: &App) -> impl IntoElement {
    Label::new(text)
        .text_xs()
        .font_medium()
        .text_color(cx.theme().muted_foreground)
}
