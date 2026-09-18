// ---------------------------------------------------------------------------
// shared chrome — native macOS inspector language, aligned with Heimdall
// ---------------------------------------------------------------------------

use std::ops::Range;
use std::rc::Rc;
use std::time::Duration;

use gateway_core::ProviderStatus;

use gpui_kit::component::{
    ActiveTheme, Icon, IconName, StyledExt, h_flex, label::Label, skeleton::Skeleton, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

pub(crate) fn provider_icon(provider: &str, dark: bool) -> Option<&'static str> {
    Some(match provider {
        "trae" | "traework" => "providers/trae-icon.png",
        "workbuddy" => "providers/workbuddy-icon.png",
        "openrouter" => "providers/openrouter-icon.png",
        "nvidia" => "providers/nvidia-icon.png",
        "grokWeb" => {
            if dark {
                "providers/grok-icon-dark.svg"
            } else {
                "providers/grok-icon-light.svg"
            }
        }
        "qoder" => "providers/qoder-icon.png",
        "gemini" | "geminiWeb" => "providers/gemini-icon.svg",
        "kiro" => "providers/kiro-icon.svg",
        "gptWeb" | "codex" => {
            if dark {
                "providers/codex-icon-dark.svg"
            } else {
                "providers/codex-icon-light.svg"
            }
        }
        _ => return None,
    })
}

/// Provider artwork has widely different intrinsic whitespace. Render it in a
/// fixed optical frame so the sidebar does not alternate between tiny and
/// oversized marks even though every row uses the same geometry.
pub(crate) fn provider_logo(provider: &str, size: f32, dimmed: bool, cx: &App) -> AnyElement {
    let visual_scale = match provider {
        // These PNGs include generous transparent padding.
        "nvidia" => 1.34,
        "workbuddy" => 1.18,
        _ => 1.0,
    };

    let glyph = match provider_icon(provider, cx.theme().is_dark()) {
        Some(source) => img(source)
            .size(px(size * visual_scale))
            .when(dimmed, |image| image.opacity(0.45))
            .into_any_element(),
        None => Icon::new(IconName::Bot)
            .size(px(size))
            .text_color(cx.theme().muted_foreground)
            .when(dimmed, |icon| icon.opacity(0.45))
            .into_any_element(),
    };

    let theme = cx.theme().clone();
    div()
        .size(px(size))
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        // OpenRouter's source artwork is a white app tile. Its tile vanishes
        // into the light sidebar unless the edge is explicitly retained.
        .when(provider == "openrouter", |frame| {
            frame
                .rounded(px(size * 0.22))
                .border_1()
                .border_color(theme.border)
                .bg(theme.background)
        })
        .child(glyph)
        .into_any_element()
}

pub(crate) fn status_label(p: &ProviderStatus) -> &'static str {
    match p.status {
        "ready" => "ready",
        "placeholder" => "soon",
        "error" => "error",
        _ => "off",
    }
}

/// Monospace face for identifiers, URLs, keys, model ids — values worth
/// copying. Never used for labels, status, or prose.
pub(crate) const MONO: &str = "SF Mono";

/// Page header matching Electron's 19px title, mono subtitle and bottom rule.
pub(crate) fn page_header(
    title: &str,
    desc: &str,
    trailing: Option<AnyElement>,
    cx: &App,
) -> impl IntoElement {
    let theme = cx.theme().clone();
    h_flex()
        .items_end()
        .justify_between()
        .gap_4()
        .pb_4()
        .border_b_1()
        .border_color(theme.border)
        .child(
            v_flex()
                .min_w_0()
                .gap_1()
                .child(
                    Label::new(title.to_string())
                        .text_size(px(19.))
                        .font_semibold()
                        .text_color(theme.foreground),
                )
                .when(!desc.is_empty(), |d| {
                    d.child(
                        Label::new(desc.to_string())
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme.muted_foreground)
                            .truncate(),
                    )
                }),
        )
        .when_some(trailing, |d, t| {
            d.child(h_flex().flex_none().items_center().gap_2().child(t))
        })
}

/// Quiet section label — `text_xs font_medium muted_foreground`.
pub(crate) fn section_label(text: impl Into<SharedString>, cx: &App) -> impl IntoElement {
    Label::new(text.into())
        .text_xs()
        .font_medium()
        .text_color(cx.theme().muted_foreground)
}

/// Section header: label + optional trailing + hairline below.
pub(crate) fn section_header(
    title: impl Into<SharedString>,
    trailing: Option<AnyElement>,
    cx: &App,
) -> impl IntoElement {
    v_flex()
        .w_full()
        .child(
            h_flex()
                .w_full()
                .items_center()
                .gap_2()
                .pt_2()
                .pb_1()
                .child(section_label(title, cx))
                .child(div().flex_1())
                .when_some(trailing, |this, t| this.child(t)),
        )
        .child(hairline(cx))
}

/// Grouped card: hairline border + theme radius + `group_box` fill, rows
/// separated by hairlines.
pub(crate) fn card_rows(rows: Vec<AnyElement>, cx: &App) -> AnyElement {
    let theme = cx.theme().clone();
    let mut inner = v_flex().w_full();
    let last = rows.len().saturating_sub(1);
    for (ix, child) in rows.into_iter().enumerate() {
        inner = inner.child(child);
        if ix != last {
            inner = inner.child(hairline(cx));
        }
    }
    div()
        .w_full()
        .border_1()
        .border_color(theme.border)
        .rounded(theme.radius)
        .bg(theme.group_box)
        .overflow_hidden()
        .child(inner)
        .into_any_element()
}

/// Virtualized card list — renders only visible rows via `uniform_list`.
/// The list fills its container's height and scrolls internally.
/// Caller must provide a definite height (e.g. `flex_1 min_h_0` in a
/// `h_full` parent, or an explicit `h(px(N))`).
pub(crate) fn card_uniform_list(
    id: impl Into<ElementId>,
    count: usize,
    scroll_handle: &UniformListScrollHandle,
    render_item: impl Fn(usize, &mut Window, &mut App) -> AnyElement + 'static,
    cx: &App,
) -> AnyElement {
    let theme = cx.theme().clone();
    let border = theme.border;
    let total = count;
    let list = uniform_list(id, count, move |range: Range<usize>, window, app| {
        range
            .map(|ix| {
                let row = render_item(ix, window, app);
                div()
                    .w_full()
                    .border_b_1()
                    .border_color(if ix == total.saturating_sub(1) {
                        border.opacity(0.0)
                    } else {
                        border
                    })
                    .child(row)
                    .into_any_element()
            })
            .collect::<Vec<_>>()
    })
    .h_full()
    .track_scroll(scroll_handle);
    div()
        .w_full()
        .h_full()
        .min_h_0()
        .border_1()
        .border_color(theme.border)
        .rounded(theme.radius)
        .bg(theme.group_box)
        .overflow_hidden()
        .child(list)
        .into_any_element()
}

/// A single card surface — `group_box` fill, hairline border, theme radius.
pub(crate) fn card(cx: &App) -> gpui_kit::Div {
    let theme = cx.theme().clone();
    div()
        .rounded(theme.radius)
        .border_1()
        .border_color(theme.border)
        .bg(theme.group_box)
}

/// Inspector row: compact and aligned with Electron's repeated rows.
pub(crate) fn row() -> gpui_kit::Div {
    div()
        .w_full()
        .px_4()
        .py_2()
        .flex()
        .flex_row()
        .items_center()
        .gap_3()
}

/// Hairline divider.
pub(crate) fn hairline(cx: &App) -> gpui_kit::Div {
    div().h_px().w_full().bg(cx.theme().border)
}

/// Segmented control — recessed track, selected segment filled with primary.
pub(crate) fn toggle_filter(
    id_prefix: &'static str,
    items: Vec<(SharedString, bool)>,
    on_pick: impl Fn(usize, &mut Window, &mut App) + 'static,
    cx: &App,
) -> gpui_kit::Div {
    let theme = cx.theme().clone();
    let on_pick = Rc::new(on_pick);
    let mut track = h_flex()
        .flex_none()
        .p_0p5()
        .gap_0p5()
        .rounded(theme.radius)
        .bg(theme.accent);
    for (ix, (label, selected)) in items.into_iter().enumerate() {
        let on_pick = on_pick.clone();
        track = track.child(
            div()
                .id(SharedString::from(format!("{id_prefix}-{ix}")))
                .px_3()
                .h_6()
                .flex()
                .items_center()
                .justify_center()
                .rounded(theme.radius)
                .cursor_pointer()
                .when(selected, |d| d.bg(theme.button_primary))
                .when(!selected, |d| d.hover(|d| d.bg(theme.list_hover)))
                .on_click(move |_, window, cx| on_pick(ix, window, cx))
                .child(Label::new(label).text_sm().when(selected, |l| {
                    l.font_medium().text_color(theme.button_primary_foreground)
                })),
        );
    }
    track
}

/// Formats a unix-seconds log timestamp as local `HH:MM:SS`.
pub(crate) fn clock_time(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%H:%M:%S")
                .to_string()
        })
        .unwrap_or_default()
}

/// Formats a unix-millis timestamp as `YYYY-MM-DD`.
pub(crate) fn short_date(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|t| {
            t.with_timezone(&chrono::Local)
                .format("%Y-%m-%d")
                .to_string()
        })
        .unwrap_or_default()
}

/// Shortens a message to one scannable line.
pub(crate) fn one_line(text: &str, max: usize) -> String {
    let first = text.lines().next().unwrap_or("").trim();
    if first.chars().count() > max {
        format!("{}…", first.chars().take(max).collect::<String>())
    } else {
        first.to_string()
    }
}

// ---------------------------------------------------------------------------
// motion — GPUI ports of the transitions-dev set. All are one-shot
// `with_animation` wrappers keyed by element id, so the platform's
// reduce-motion setting is honoured automatically.
// ---------------------------------------------------------------------------

/// Fade + 6px rise on mount — the "panel reveal" feel for page bodies,
/// banners and notices. Key `id` by the logical element (page name, notice
/// generation) so each remount replays it.
pub(crate) fn enter(el: gpui_kit::Div, id: impl Into<ElementId>) -> impl IntoElement {
    el.relative().with_animation(
        id,
        Animation::new(Duration::from_millis(180)).with_easing(ease_out_quint()),
        |el, d| el.opacity(d).top(px(6. * (1. - d))),
    )
}

/// Fade + slight rise for inline values that change in place — the
/// "number pop-in" feel. Key `id` by the new value so updates replay it.
pub(crate) fn pop_in(el: gpui_kit::Div, id: impl Into<ElementId>) -> impl IntoElement {
    el.relative().with_animation(
        id,
        Animation::new(Duration::from_millis(320)).with_easing(ease_out_quint()),
        |el, d| el.opacity(d).top(px(4. * (1. - d))),
    )
}

/// Decaying horizontal shake — the "error state" feedback for invalid input.
/// Key `id` by a nonce so each failed attempt replays it.
pub(crate) fn shake(el: gpui_kit::Div, id: impl Into<ElementId>) -> impl IntoElement {
    el.relative()
        .with_animation(id, Animation::new(Duration::from_millis(420)), |el, d| {
            let x = (d * std::f32::consts::TAU * 2.5).sin() * (1. - d) * 6.;
            el.left(px(x))
        })
}

/// Skeleton placeholder lines inside a card — used while a list is loading
/// so the layout arrives before the data does.
pub(crate) fn skeleton_rows(count: usize, cx: &App) -> AnyElement {
    let mut rows = v_flex();
    for i in 0..count {
        rows = rows.child(
            div().px_4().py_3().child(
                v_flex()
                    .gap_1p5()
                    .child(
                        Skeleton::new()
                            .w(relative(0.35 + 0.1 * (i % 3) as f32))
                            .h_3()
                            .rounded(px(3.)),
                    )
                    .child(
                        Skeleton::new()
                            .secondary()
                            .w(relative(0.22 + 0.08 * (i % 2) as f32))
                            .h_2p5()
                            .rounded(px(3.)),
                    ),
            ),
        );
        if i + 1 != count {
            rows = rows.child(hairline(cx));
        }
    }
    card(cx).overflow_hidden().child(rows).into_any_element()
}

/// A row of skeleton chips — placeholder for tag/model lists. Bare content;
/// the caller wraps it in a card if needed.
#[allow(dead_code)]
pub(crate) fn skeleton_chips(widths: &[f32], cx: &App) -> AnyElement {
    let mut chips = h_flex().gap_1p5().flex_wrap();
    for w in widths {
        chips = chips.child(Skeleton::new().w(px(*w)).h_5().rounded(cx.theme().radius));
    }
    div().px_4().py_3().child(chips).into_any_element()
}
