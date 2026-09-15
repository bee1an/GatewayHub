//! Settings — paths, theme, server info.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::component::{
    ActiveTheme, Sizable, StyledExt, button::Button, h_flex, label::Label, v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::AppRoot;

impl AppRoot {
    pub(crate) fn render_settings(
        &self,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let auto_start = self.service.config().server.auto_start;
        let svc = self.service.clone();
        v_flex()
            .p_4()
            .gap_3()
            .child(
                Label::new("Settings")
                    .text_lg()
                    .font_semibold()
                    .text_color(theme.foreground),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("Config")
                            .text_sm()
                            .text_color(theme.muted_foreground),
                    )
                    .child(Label::new(snapshot.config_path.clone()).text_sm()),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .child(
                        Label::new("Endpoint")
                            .text_sm()
                            .text_color(theme.muted_foreground),
                    )
                    .child(Label::new(snapshot.server.url.clone()).text_sm()),
            )
            .child(
                Button::new("autostart")
                    .outline()
                    .small()
                    .label(if auto_start {
                        "Autostart: on"
                    } else {
                        "Autostart: off"
                    })
                    .on_click(cx.listener(move |_this, _, _w, cx| {
                        let mut cfg = svc.config();
                        cfg.server.auto_start = !cfg.server.auto_start;
                        if let Err(e) = svc.save_config(cfg) {
                            tracing::error!(error = %e, "save config failed");
                        }
                        cx.notify();
                    })),
            )
            .into_any_element()
    }
}
