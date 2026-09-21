//! Focus mechanism + sidebar visibility regression tests.

use super::{app_surface, overlay_panel_surface, read_hidden_providers, write_hidden_providers};
use gpui_kit::test::{TestSupportExt, TestWindowExt};
use gpui_kit::{
    AppContext, Context, Entity, FocusHandle, Focusable, MouseButton, TestAppContext, Window,
    component::{
        Root,
        input::{Input, InputState, Textarea, TextareaState},
        v_flex,
    },
    div,
    prelude::*,
    px, size,
};
use std::collections::HashSet;

struct InputFocusProbe {
    shell_focus: FocusHandle,
    overlay_focus: FocusHandle,
    page_input: Entity<InputState>,
    overlay_input: Entity<InputState>,
}

impl Render for InputFocusProbe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        app_surface(&self.shell_focus)
            .flex()
            .flex_col()
            .gap_4()
            .p_4()
            .child(Input::new(&self.page_input).id("page-input").w(px(240.)))
            .child(
                div()
                    .id("page-background")
                    .test_support()
                    .w(px(240.))
                    .h(px(48.))
                    .on_mouse_down(MouseButton::Left, |_, _, _| {}),
            )
            .child(
                overlay_panel_surface(&self.overlay_focus)
                    .flex()
                    .flex_col()
                    .child(
                        Input::new(&self.overlay_input)
                            .id("overlay-input")
                            .w(px(240.)),
                    )
                    .child(
                        div()
                            .id("overlay-background")
                            .test_support()
                            .w(px(240.))
                            .h(px(48.))
                            .on_mouse_down(MouseButton::Left, |_, _, _| {}),
                    ),
            )
    }
}

#[gpui_kit::test]
fn focus_moves_between_inputs_and_surrounding_surfaces(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let handle = cx.open_window(size(px(640.), px(480.)), |window, cx| {
        let probe = cx.new(|cx| InputFocusProbe {
            shell_focus: cx.focus_handle(),
            overlay_focus: cx.focus_handle(),
            page_input: cx.new(|cx| InputState::new(window, cx)),
            overlay_input: cx.new(|cx| InputState::new(window, cx)),
        });
        Root::new(probe, window, cx)
    });

    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);

        window.click("page-input", cx);
        window.input("page", cx);
        assert_eq!(window.find("page-input").focused(), Some(true));
        assert_eq!(window.find("page-input").value(), Some("page"));

        window.click("page-background", cx);
        window.input(" ignored", cx);
        assert_eq!(window.find("page-input").focused(), Some(false));
        assert_eq!(window.find("page-input").value(), Some("page"));

        window.click("overlay-input", cx);
        window.input("overlay", cx);
        assert_eq!(window.find("overlay-input").focused(), Some(true));
        assert_eq!(window.find("overlay-input").value(), Some("overlay"));

        window.click("overlay-background", cx);
        window.input(" ignored", cx);
        assert_eq!(window.find("overlay-input").focused(), Some(false));
        assert_eq!(window.find("overlay-input").value(), Some("overlay"));
    })
    .expect("input focus probe window should remain available");
}

struct ComposerFocusProbe {
    shell_focus: FocusHandle,
    pg_input: Entity<TextareaState>,
    disabled: bool,
}

impl Render for ComposerFocusProbe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        // Mirror the playground page's real nesting: scrolling page
        // container → centered column → message card → composer card.
        app_surface(&self.shell_focus).child(
            div()
                .id("page-scroll")
                .size_full()
                .overflow_y_scroll()
                .child(
                    div()
                        .mx_auto()
                        .w_full()
                        .max_w(px(960.))
                        .px_6()
                        .pt_6()
                        .pb_5()
                        .child(
                            v_flex()
                                .flex_1()
                                .min_h_0()
                                .gap_3()
                                .child(
                                    div().flex_1().min_h(px(200.)).overflow_hidden().child(
                                        div()
                                            .id("pg-scroll")
                                            .size_full()
                                            .overflow_y_scroll()
                                            .child("log"),
                                    ),
                                )
                                .child(
                                    div().p_3().child(
                                        v_flex().gap_2().child(
                                            div()
                                                .id("composer-field")
                                                .test_support()
                                                .w_full()
                                                .px_3()
                                                .py_2()
                                                .child(
                                                    Textarea::new(&self.pg_input)
                                                        .appearance(false)
                                                        .bordered(false)
                                                        .disabled(self.disabled),
                                                ),
                                        ),
                                    ),
                                ),
                        ),
                ),
        )
    }
}

#[gpui_kit::test]
fn playground_composer_focuses_on_click(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let slot = std::rc::Rc::new(std::cell::RefCell::new(None));
    let slot2 = slot.clone();
    let handle = cx.open_window(size(px(640.), px(480.)), |window, cx| {
        let pg_input = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx)
                .submit_on_enter(true)
                .placeholder("type");
            state.set_auto_grow(1, 5, cx);
            state
        });
        *slot2.borrow_mut() = Some(pg_input.clone());
        let probe = cx.new(|cx| ComposerFocusProbe {
            shell_focus: cx.focus_handle(),
            pg_input,
            disabled: false,
        });
        Root::new(probe, window, cx)
    });

    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let pg_input = slot.borrow().clone().unwrap();

        window.click("composer-field", cx);
        window.input("hello", cx);
        assert!(
            pg_input.read(cx).focus_handle(cx).is_focused(window),
            "composer Textarea should be focused after click"
        );
        assert_eq!(pg_input.read(cx).value().as_ref(), "hello");
    })
    .expect("composer probe window should remain available");
}

/// A disabled composer still takes the click focus (caret hidden, edits
/// rejected) — the field looks dead exactly the way users describe it.
#[gpui_kit::test]
fn disabled_composer_rejects_input(cx: &mut TestAppContext) {
    cx.update(gpui_kit::init);
    let slot = std::rc::Rc::new(std::cell::RefCell::new(None));
    let slot2 = slot.clone();
    let handle = cx.open_window(size(px(640.), px(480.)), |window, cx| {
        let pg_input = cx.new(|cx| {
            let mut state = TextareaState::new(window, cx).placeholder("type");
            state.set_auto_grow(1, 5, cx);
            state
        });
        *slot2.borrow_mut() = Some(pg_input.clone());
        let probe = cx.new(|cx| ComposerFocusProbe {
            shell_focus: cx.focus_handle(),
            pg_input,
            disabled: true,
        });
        Root::new(probe, window, cx)
    });

    cx.update_window(handle.into(), |_, window, cx| {
        window.render_frame(cx);
        let pg_input = slot.borrow().clone().unwrap();

        window.click("composer-field", cx);
        window.input("hello", cx);
        assert_eq!(
            pg_input.read(cx).value().as_ref(),
            "",
            "disabled composer must not accept typed text"
        );
    })
    .expect("composer probe window should remain available");
}

#[test]
fn sidebar_visibility_round_trips_without_disabling_provider() {
    let mut config = gateway_core::GatewayHubConfig::default();
    config.providers.insert(
        "kiro".into(),
        serde_json::json!({ "enabled": true, "useProxy": true }),
    );
    let hidden = HashSet::from(["kiro".to_string()]);

    write_hidden_providers(&mut config, &hidden);

    assert_eq!(read_hidden_providers(&config), hidden);
    let provider = gateway_core::ProviderConfig::from_value(&config.providers["kiro"]);
    assert!(
        provider.enabled,
        "sidebar visibility must not disable adapters"
    );
    assert_eq!(provider.use_proxy, Some(true));
}
