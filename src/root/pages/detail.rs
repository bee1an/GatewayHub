//! Provider detail — accounts, model list, JSON import, enable/proxy toggles.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::component::{
    ActiveTheme, IconName, Sizable, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Input,
    label::Label,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use crate::root::{AppRoot, list_row, provider_icon, status_label};

impl AppRoot {
    pub(crate) fn render_provider_detail(
        &mut self,
        provider: &str,
        snapshot: &GatewayStatusSnapshot,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let status = snapshot.providers.iter().find(|p| p.name == provider);
        let provider_name = provider.to_string();
        let accounts = self.service.accounts(provider);
        let models = self
            .detail_models
            .get(provider)
            .cloned()
            .unwrap_or_default();
        let enabled = status.map(|p| p.enabled).unwrap_or(false);

        // ---- header: back + icon + name/status + enable/proxy toggles ----
        let mut title_lane = h_flex().items_center().gap_2();
        if let Some(src) =
            provider_icon(&status.map(|p| p.provider_type.clone()).unwrap_or_default())
        {
            title_lane = title_lane.child(img(src).size_5().rounded_sm());
        }
        title_lane = title_lane.child(
            Label::new(provider.to_string())
                .text_lg()
                .font_semibold()
                .text_color(theme.foreground),
        );

        let header = h_flex()
            .pt_5()
            .pb_4()
            .items_center()
            .gap_3()
            .child(
                Button::new("back")
                    .ghost()
                    .small()
                    .icon(IconName::ArrowLeft)
                    .tooltip("Back")
                    .on_click(cx.listener(|this, _, _w, cx| {
                        this.detail = None;
                        cx.notify();
                    })),
            )
            .child(
                v_flex().gap_0p5().child(title_lane).child(
                    Label::new(format!(
                        "{}{}{}",
                        status.map(status_label).unwrap_or("off"),
                        if status.and_then(|p| p.message.clone()).is_some() {
                            " · "
                        } else {
                            ""
                        },
                        status.and_then(|p| p.message.clone()).unwrap_or_default(),
                    ))
                    .text_xs()
                    .text_color(theme.muted_foreground),
                ),
            )
            .child(div().flex_1())
            .child(
                Button::new("toggle-proxy")
                    .outline()
                    .small()
                    .label("Proxy")
                    .on_click(cx.listener({
                        let p = provider_name.clone();
                        move |this, _, _w, cx| {
                            this.toggle_provider_flag(&p, "useProxy", cx);
                        }
                    })),
            )
            .child(
                Button::new("toggle-enabled")
                    .when(enabled, |b| b.danger())
                    .when(!enabled, |b| b.primary())
                    .small()
                    .label(if enabled { "Disable" } else { "Enable" })
                    .on_click(cx.listener({
                        let p = provider_name.clone();
                        move |this, _, _w, cx| {
                            this.toggle_provider_flag(&p, "enabled", cx);
                        }
                    })),
            );

        // ---- accounts ----
        let mut rows = v_flex().gap_1p5();
        if accounts.is_empty() {
            rows = rows.child(
                div().py_3().child(
                    Label::new("No account files for this provider")
                        .text_sm()
                        .text_color(theme.muted_foreground),
                ),
            );
        }
        for account in &accounts {
            let key = format!("{provider}/{}", account.id);
            let label = account
                .label
                .clone()
                .or_else(|| account.email.clone())
                .unwrap_or_else(|| account.id.clone());
            let account_id = account.id.clone();
            let provider_name1 = provider_name.clone();
            let provider_name2 = provider_name.clone();
            let provider_name3 = provider_name.clone();
            let account_id2 = account_id.clone();
            let account_id3 = account_id.clone();
            let row = list_row(cx)
                .gap_2()
                .px_3()
                .py_2p5()
                .child(
                    v_flex()
                        .gap_0p5()
                        .flex_1()
                        .min_w_0()
                        .child(
                            Label::new(label)
                                .text_sm()
                                .font_medium()
                                .text_color(theme.foreground),
                        )
                        .child(
                            Label::new(self.test_results.get(&key).cloned().unwrap_or_else(|| {
                                if account.enabled {
                                    "enabled".into()
                                } else {
                                    "disabled".into()
                                }
                            }))
                            .text_xs()
                            .text_color(theme.muted_foreground),
                        ),
                )
                .child(
                    Button::new(SharedString::from(format!("test-{}", account.id)))
                        .outline()
                        .xsmall()
                        .label("Test")
                        .on_click(cx.listener(move |this, _, _w, _cx| {
                            this.test_account(&provider_name1, &account_id);
                        })),
                )
                .child(
                    Button::new(SharedString::from(format!("toggle-{}", account.id)))
                        .outline()
                        .xsmall()
                        .label(if account.enabled { "Disable" } else { "Enable" })
                        .on_click(cx.listener(move |this, _, _w, cx| {
                            this.toggle_account(&provider_name2, &account_id2, cx);
                        })),
                )
                .child(
                    Button::new(SharedString::from(format!("del-{}", account.id)))
                        .ghost()
                        .xsmall()
                        .label("Delete")
                        .on_click(cx.listener(move |this, _, _w, cx| {
                            this.delete_account(&provider_name3, &account_id3, cx);
                        })),
                );
            rows = rows.child(row);
        }

        // ---- import box ----
        let import_result = self.import_result.clone();
        let provider_name4 = provider_name.clone();
        let mut import_bar = h_flex()
            .items_center()
            .gap_2()
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&self.import_input)),
            )
            .child(
                Button::new("import-account")
                    .primary()
                    .small()
                    .label("Import")
                    .icon(IconName::Plus)
                    .on_click(cx.listener(move |this, _, w, cx| {
                        this.import_account(&provider_name4, w, cx);
                    })),
            );
        if let Some(msg) = import_result {
            import_bar =
                import_bar.child(Label::new(msg).text_xs().text_color(theme.muted_foreground));
        }

        // ---- models ----
        let mut model_rows = v_flex().gap_1();
        for m in models.iter().take(50) {
            model_rows = model_rows.child(
                Label::new(m.clone())
                    .text_xs()
                    .text_color(theme.muted_foreground),
            );
        }
        let models_block = v_flex()
            .gap_2()
            .child(
                Label::new(format!("Models ({})", models.len()))
                    .text_xs()
                    .font_semibold()
                    .text_color(theme.muted_foreground),
            )
            .child(model_rows);

        v_flex()
            .gap_4()
            .child(header)
            .child(div().h_px().bg(theme.border))
            .child(
                v_flex()
                    .gap_2()
                    .child(
                        Label::new(format!("Accounts ({})", accounts.len()))
                            .text_xs()
                            .font_semibold()
                            .text_color(theme.muted_foreground),
                    )
                    .child(rows)
                    .child(import_bar),
            )
            .child(models_block)
            .into_any_element()
    }
}
