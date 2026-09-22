//! In-window overlay layer — the request type plus open/dismiss/confirm
//! plumbing and the animated backdrop + panel renderer.

use std::rc::Rc;
use std::time::Instant;

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Sizable, StyledExt,
    button::{Button, ButtonVariant, ButtonVariants},
    h_flex,
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use super::{AppRoot, overlay_motion, overlay_panel_surface, t};

/// Vertical breathing room the overlay keeps to the window edges, in rem —
/// scales with interface zoom like the panel width does.
const OVERLAY_MARGIN_V_REM: f32 = 8.75;

/// Freeform overlay content/footer — rendered inside `AppRoot::render`, so
/// the builder receives `&AppRoot` directly (the entity is already borrowed
/// there; `weak.read_with` would panic).
pub(crate) type OverlayBuilder =
    Rc<dyn Fn(&AppRoot, &mut Window, &mut Context<AppRoot>) -> AnyElement>;

/// One in-window overlay card — centered with Heimdall's layered motion
/// (surface rises, then the content group clarifies). `content`/`footer`
/// builders get live `&AppRoot` state.
#[derive(Clone)]
pub(crate) struct OverlayRequest {
    pub title: SharedString,
    /// Confirm-style text body; `None` when `content` carries the body.
    pub body: Option<SharedString>,
    /// Custom body content — wins over `body`.
    pub content: Option<OverlayBuilder>,
    /// Custom footer — wins over the default cancel/ok pair.
    pub footer: Option<OverlayBuilder>,
    /// Primary action label; `None` hides the OK button.
    pub ok_label: Option<SharedString>,
    /// Variant for the OK button — `Danger` for destructive confirms,
    /// `Primary` for ordinary commits. Only used with the default footer.
    pub ok_variant: ButtonVariant,
    pub cancel_label: Option<SharedString>,
    pub width: Rems,
    /// Runs on OK then the overlay animates out.
    pub on_ok: Option<Rc<dyn Fn(&mut AppRoot, &mut Context<AppRoot>)>>,
    /// Whether a backdrop click dismisses (confirms set false).
    pub backdrop_dismiss: bool,
    /// Set by `open_overlay`.
    pub opened_at: Instant,
}

impl Default for OverlayRequest {
    fn default() -> Self {
        Self {
            title: SharedString::default(),
            body: None,
            content: None,
            footer: None,
            ok_label: None,
            ok_variant: ButtonVariant::Danger,
            cancel_label: None,
            width: crate::root::DIALOG_W_SM,
            on_ok: None,
            backdrop_dismiss: true,
            opened_at: Instant::now(),
        }
    }
}

impl AppRoot {
    /// Shared destructive-action confirm — an in-window overlay card with
    /// Heimdall's layered confirm motion, NOT a gpui-component Dialog: the
    /// stock OK/Cancel buttons dispatch a `Confirm`/`Cancel` action along
    /// the focus path, which is dead when the body holds no focusable
    /// element.
    pub(crate) fn confirm(
        &mut self,
        title: &'static str,
        description: String,
        ok_key: &'static str,
        cx: &mut Context<Self>,
        on_ok: impl Fn(&mut Self, &mut Context<Self>) + 'static,
    ) {
        let lang = self.lang;
        self.open_overlay(
            OverlayRequest {
                title: t(lang, title).into(),
                body: Some(description.into()),
                ok_label: Some(t(lang, ok_key).into()),
                ok_variant: ButtonVariant::Danger,
                cancel_label: Some(t(lang, "cancel").into()),
                width: crate::root::DIALOG_W_SM,
                on_ok: Some(Rc::new(on_ok)),
                backdrop_dismiss: false,
                ..OverlayRequest::default()
            },
            cx,
        );
    }

    pub(crate) fn open_overlay(&mut self, mut req: OverlayRequest, cx: &mut Context<Self>) {
        req.opened_at = Instant::now();
        self.overlay = Some(req);
        self.overlay_closing = None;
        self.overlay_sample = None;
        cx.notify();
    }

    /// Starts the layered exit tween; the overlay is dropped when it
    /// finishes (handled inside `overlay_layer`).
    pub(crate) fn dismiss_overlay(&mut self, cx: &mut Context<Self>) {
        // Closing the dialog mid-login kills the subprocess (TS behavior).
        if self.cli_login_active {
            if let Some(provider) = self.cli_provider.clone() {
                self.service.cancel_cli_login(&provider);
            }
            self.cli_login_active = false;
        }
        if self.overlay.is_some() && self.overlay_closing.is_none() {
            // Reduce motion: no exit tween — drop the layer right away.
            if cx.reduce_motion() {
                self.overlay = None;
                self.overlay_closing = None;
                self.overlay_sample = None;
                cx.notify();
                return;
            }
            self.overlay_closing = Some(Instant::now());
            // Sample whatever is on screen — the exit continues from
            // these values instead of snapping to a schedule.
            self.overlay_sample = Some(match self.overlay.as_ref().map(|r| r.opened_at) {
                Some(at) => overlay_motion::open_at(at.elapsed().as_secs_f32() * 1000.),
                None => overlay_motion::steady(),
            });
            cx.notify();
        }
    }

    /// Full-window overlay layer rendered above the shell — Heimdall's
    /// layered confirm motion: the surface rises and fades first, then the
    /// content group clarifies. The panel is centered by real layout (no
    /// height_hint guessing); the exit continues from the frame sampled at
    /// dismiss time.
    pub(crate) fn overlay_layer(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        use overlay_motion::{CLOSE_MS, OPEN_MS, close_at, open_at, steady};

        let req = self.overlay.clone()?;
        let theme = cx.theme().clone();
        let closing = self.overlay_closing;
        let reduced = cx.reduce_motion();

        let (m, finished) = if reduced {
            // Reduce motion: opening shows the end state immediately; a
            // close request has already cleared the overlay.
            (steady(), false)
        } else {
            match closing {
                Some(at) => {
                    let e = at.elapsed().as_secs_f32() * 1000.;
                    (
                        close_at(self.overlay_sample.unwrap_or_else(steady), e),
                        e >= CLOSE_MS,
                    )
                }
                None => {
                    let e = self
                        .overlay
                        .as_ref()
                        .map(|r| r.opened_at.elapsed().as_secs_f32() * 1000.)
                        .unwrap_or(OPEN_MS);
                    (open_at(e), false)
                }
            }
        };
        let animating = !reduced
            && match closing {
                Some(at) => at.elapsed().as_secs_f32() * 1000. < CLOSE_MS,
                None => self
                    .overlay
                    .as_ref()
                    .is_some_and(|r| r.opened_at.elapsed().as_secs_f32() * 1000. < OPEN_MS),
            };
        if animating {
            let me = cx.weak_entity();
            window.on_next_frame(move |_, cx| {
                let _ = me.update(cx, |_, cx| cx.notify());
            });
        }
        if finished {
            // Exit landed: drop the layer entirely — AND return no element
            // this frame. Clearing state but still emitting the layer left
            // an invisible occluding backdrop mounted forever, which ate
            // every later click in the window.
            self.overlay = None;
            self.overlay_closing = None;
            self.overlay_sample = None;
            return None;
        }

        // Offsets in rem — they follow the user's UI scale.
        let rem_px = window.rem_size();
        let lang = self.lang;
        let panel_w = req.width;

        // ---- panel content (built once; the layers below carry motion) ----
        let content_group = v_flex()
            .w(panel_w)
            .max_h(window.viewport_size().height - rem_px * OVERLAY_MARGIN_V_REM)
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .px_4()
                    .pt_4()
                    .pb_2()
                    .child(
                        Label::new(req.title.clone())
                            .text_sm()
                            .font_semibold()
                            .text_color(theme.foreground),
                    )
                    .child(div().flex_1())
                    .child(
                        Button::new("overlay-close")
                            .ghost()
                            .small()
                            .icon(IconName::Close)
                            .tooltip(t(lang, "close"))
                            .accessibility_label(t(lang, "close"))
                            .on_click(cx.listener(|this, _, _w, cx| {
                                this.dismiss_overlay(cx);
                            })),
                    ),
            )
            .when_some(req.body.clone(), |d, body| {
                d.child(
                    div().px_4().pb_2().child(
                        Label::new(body)
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .whitespace_normal(),
                    ),
                )
            })
            .when_some(req.content.as_ref(), |d, content| {
                d.child(div().px_4().child((content)(&*self, window, cx)))
            })
            .when_some(req.footer.as_ref(), |d, footer| {
                d.child(
                    div()
                        .w_full()
                        .px_4()
                        .py_4()
                        .child((footer)(&*self, window, cx)),
                )
            })
            .when(req.footer.is_none(), |d| {
                let on_ok = req.on_ok.clone();
                d.child(
                    h_flex()
                        .w_full()
                        .px_4()
                        .py_4()
                        .justify_end()
                        .gap_2()
                        .when_some(req.cancel_label.clone(), |d, label| {
                            d.child(
                                Button::new("overlay-cancel")
                                    .outline()
                                    .label(label)
                                    .on_click(cx.listener(|this, _, _w, cx| {
                                        this.dismiss_overlay(cx);
                                    })),
                            )
                        })
                        .when_some(req.ok_label.clone(), |d, label| {
                            d.child(
                                Button::new("overlay-ok")
                                    .with_variant(req.ok_variant)
                                    .label(label)
                                    .on_click(cx.listener(move |this, _, _w, cx| {
                                        if let Some(ok) = &on_ok {
                                            ok(this, cx);
                                        }
                                        this.dismiss_overlay(cx);
                                    })),
                            )
                        }),
                )
            });

        let me = cx.weak_entity();
        let dismissible = req.backdrop_dismiss;
        let closing_gate = closing.is_some();

        Some(
            div()
                .id("overlay-layer")
                .absolute()
                .top_0()
                .left_0()
                .size_full()
                .child(
                    // Layer 1 — backdrop: dim to 0.5, cancels when
                    // dismissible; occluded so rows under the overlay
                    // never light up on hover.
                    div()
                        .id("overlay-dim")
                        .absolute()
                        .inset_0()
                        .size_full()
                        .occlude()
                        // Scrim: a dimming layer, always dark. Deriving it
                        // from `foreground` inverts in dark mode (foreground
                        // is light there) and renders as a white film — so
                        // the hue stays fixed black and `backdrop_a` animates
                        // to its 0.5 cap on its own.
                        .bg(hsla(0., 0., 0., m.backdrop_a.max(0.)))
                        .on_mouse_down(MouseButton::Left, move |_, _window, cx| {
                            if dismissible {
                                let _ = me.update(cx, |this, cx| this.dismiss_overlay(cx));
                            }
                        })
                        .on_scroll_wheel(|_, _, cx| cx.stop_propagation()),
                )
                // Centered by real layout — no height_hint guessing.
                .child(
                    div()
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .child(
                            overlay_panel_surface(&self.overlay_focus)
                                .top(rem_px * m.panel_off_rem)
                                .w(panel_w)
                                // Clicks/scroll inside the card must not
                                // reach the backdrop.
                                .on_scroll_wheel(|_, _, cx| cx.stop_propagation())
                                // Layer 2 — the surface: bg/border/radius/
                                // shadow as one sibling with its own alpha,
                                // never multiplied through the content's.
                                .child(
                                    div()
                                        .absolute()
                                        .inset_0()
                                        .bg(theme.background)
                                        .border_1()
                                        .border_color(theme.window_border)
                                        .rounded(theme.radius_lg)
                                        .shadow_lg()
                                        .opacity(m.panel_a.max(0.)),
                                )
                                // Layer 3 — the content group: one curve,
                                // one 3px micro-rise, laid out from frame
                                // one (opacity never clips focus rings).
                                .child(
                                    div()
                                        .relative()
                                        .top(rem_px * m.content_off_rem)
                                        .opacity(m.content_a.max(0.))
                                        .child(content_group),
                                )
                                // While exiting, an invisible blocker
                                // keeps content inert — the backdrop keeps
                                // shielding the layer below either way.
                                .when(closing_gate, |d| {
                                    d.child(
                                        div()
                                            .absolute()
                                            .inset_0()
                                            .occlude()
                                            .on_mouse_down(MouseButton::Left, |_, _, cx| {
                                                cx.stop_propagation()
                                            })
                                            .on_mouse_down(MouseButton::Right, |_, _, cx| {
                                                cx.stop_propagation()
                                            })
                                            .on_scroll_wheel(|_, _, cx| cx.stop_propagation()),
                                    )
                                }),
                        ),
                )
                .into_any_element(),
        )
    }
}
