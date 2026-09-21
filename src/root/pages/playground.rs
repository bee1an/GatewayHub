//! Playground — real requests through the running gateway server. Exercises
//! the actual auth/scope/protocol path: model + API-key pickers, streaming
//! SSE, multi-turn history, per-message retry, markdown replies.

use gateway_core::GatewayStatusSnapshot;
use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Disableable, Icon, Sizable, Size, StyledExt,
    button::{Button, ButtonVariants},
    h_flex,
    input::Textarea,
    label::Label,
    searchable_list::SearchableVec,
    select::Select,
    spinner::Spinner,
    text::TextView,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

use std::time::Instant;

use crate::root::{
    AppRoot, MONO, PgApiType, PgEvent, PgKeyItem, PgMsg, PgRole, card, fmt_count, t, toggle_filter,
};

/// Models + key select contents change with the snapshot — pushed into the
/// SelectState entities here, and a sane default is picked when the current
/// selection disappears.
fn sync_pg_selects(
    this: &mut AppRoot,
    snapshot: &GatewayStatusSnapshot,
    window: &mut Window,
    cx: &mut Context<AppRoot>,
) {
    // Aliases first, then every provider's models as `route/model`.
    let cfg = this.service.config();
    let mut models: Vec<String> = cfg
        .model_mappings
        .iter()
        .filter(|m| m.enabled)
        .map(|m| m.alias.clone())
        .collect();
    for p in &snapshot.providers {
        if !p.enabled || !p.configured {
            continue;
        }
        for m in &p.models {
            models.push(format!("{}/{m}", p.name));
        }
    }
    models.dedup();
    if models != this.pg_model_items {
        let keep = this
            .pg_model_sel
            .read(cx)
            .selected_value()
            .cloned()
            .filter(|v| models.contains(v));
        this.pg_model_items = models.clone();
        this.pg_model_sel.update(cx, |s, cx| {
            s.set_items(SearchableVec::new(models.clone()), window, cx);
            if let Some(v) = keep.or_else(|| models.first().cloned()) {
                s.set_selected_value(&v, window, cx);
            }
        });
    }

    let now = chrono::Utc::now().timestamp_millis();
    let keys: Vec<PgKeyItem> = cfg
        .server
        .api_keys
        .iter()
        .filter(|k| k.expires_at.is_none_or(|e| e > now))
        .map(|k| PgKeyItem {
            id: k.id.clone(),
            label: if k.name.is_empty() {
                format!(
                    "sk-…{}",
                    &k.key
                        .chars()
                        .rev()
                        .take(4)
                        .collect::<String>()
                        .chars()
                        .rev()
                        .collect::<String>()
                )
            } else {
                k.name.clone()
            },
        })
        .collect();
    if keys != this.pg_key_items {
        let keep = this
            .pg_key_sel
            .read(cx)
            .selected_value()
            .cloned()
            .filter(|v| keys.iter().any(|k| &k.id == v));
        this.pg_key_items = keys.clone();
        this.pg_key_sel.update(cx, |s, cx| {
            s.set_items(SearchableVec::new(keys.clone()), window, cx);
            if let Some(v) = keep.or_else(|| keys.first().map(|k| k.id.clone())) {
                s.set_selected_value(&v, window, cx);
            }
        });
    }
}

impl AppRoot {
    pub(crate) fn render_playground(
        &mut self,
        snapshot: &GatewayStatusSnapshot,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let theme = cx.theme().clone();
        let lang = self.lang;

        // Enter pressed in the composer → the send already ran; the input
        // clear needed a Window, which subscriptions don't get.
        if self.pg_clear_input {
            self.pg_clear_input = false;
            self.pg_input
                .update(cx, |s, cx| s.set_value("", window, cx));
        }
        sync_pg_selects(self, snapshot, window, cx);

        let running = snapshot.server.running;
        let disabled_reason: Option<String> = if !running {
            Some(t(lang, "pg_start_server").to_string())
        } else if self.pg_key_items.is_empty() {
            Some(t(lang, "pg_no_key").to_string())
        } else if self.pg_model_items.is_empty() {
            Some(t(lang, "pg_no_model").to_string())
        } else {
            None
        };

        // ---- toolbar ----
        let toolbar = card(cx)
            .p_3()
            .flex()
            .items_end()
            .gap_3()
            .flex_wrap()
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        Label::new(t(lang, "pg_api"))
                            .text_xs()
                            .font_medium()
                            .text_color(theme.secondary_foreground),
                    )
                    .child(
                        // h_8 aligns the 24px segment row with the 32px
                        // medium selects beside it.
                        h_flex().h_8().items_center().child(toggle_filter(
                            "pg-api",
                            vec![
                                ("OpenAI".into(), self.pg_api_type == PgApiType::OpenAi),
                                ("Anthropic".into(), self.pg_api_type == PgApiType::Anthropic),
                                ("Responses".into(), self.pg_api_type == PgApiType::Responses),
                            ],
                            cx.processor(|this, ix, _w, cx| {
                                let api = match ix {
                                    1 => PgApiType::Anthropic,
                                    2 => PgApiType::Responses,
                                    _ => PgApiType::OpenAi,
                                };
                                this.set_pg_api_type(api, cx);
                            }),
                            cx,
                        )),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .w(px(240.))
                    .child(
                        Label::new(t(lang, "pg_model"))
                            .text_xs()
                            .font_medium()
                            .text_color(theme.secondary_foreground),
                    )
                    .child(
                        Select::new(&self.pg_model_sel)
                            .placeholder(t(lang, "pg_no_model"))
                            .menu_width(px(320.))
                            .search_placeholder(t(lang, "pg_search_model")),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .w(px(200.))
                    .child(
                        Label::new(t(lang, "pg_key"))
                            .text_xs()
                            .font_medium()
                            .text_color(theme.secondary_foreground),
                    )
                    .child(
                        Select::new(&self.pg_key_sel)
                            .placeholder(t(lang, "pg_no_key"))
                            .menu_width(px(220.)),
                    ),
            )
            .child(
                v_flex()
                    .gap_1()
                    .child(
                        Label::new(t(lang, "pg_stream"))
                            .text_xs()
                            .font_medium()
                            .text_color(theme.secondary_foreground),
                    )
                    .child(
                        h_flex()
                            // Medium selects render at h_8 (32px); center the
                            // 16px switch on that line instead of a ghost label.
                            .h_8()
                            .items_center()
                            .child(
                                gpui_kit::component::switch::Switch::new("pg-stream")
                                    .xsmall()
                                    .checked(self.pg_stream)
                                    .on_change(cx.listener(|this, v, _w, cx| {
                                        this.pg_stream = *v;
                                        cx.notify();
                                    })),
                            ),
                    ),
            )
            .child(div().flex_1())
            .child(
                Button::new("pg-clear")
                    .ghost()
                    .small()
                    .label(t(lang, "clear"))
                    .icon(IconName::Delete)
                    .disabled(self.pg_msgs.is_empty())
                    .on_click(cx.listener(|this, _, _w, cx| this.pg_clear(cx))),
            );

        // ---- messages ----
        let mut log = v_flex().id("pg-log").gap_3().p_4();
        if self.pg_msgs.is_empty() {
            log = log.child(
                v_flex()
                    .items_center()
                    .justify_center()
                    .py_8()
                    .gap_3()
                    .child(
                        Icon::new(IconName::Bot)
                            .size(px(32.))
                            .text_color(theme.muted_foreground),
                    )
                    .child(
                        div().max_w(rems(26.)).child(
                            Label::new(t(lang, "pg_empty"))
                                .text_sm()
                                .text_color(theme.muted_foreground)
                                .text_center(),
                        ),
                    ),
            );
        }
        for m in &self.pg_msgs {
            log = log.child(pg_message(m, lang, cx));
        }

        // ---- composer ----
        let composer = card(cx).p_3().child(
            v_flex()
                .gap_2()
                .when_some(disabled_reason.clone(), |d, reason| {
                    d.child(
                        Label::new(reason)
                            .text_xs()
                            .text_color(theme.warning_foreground),
                    )
                })
                .child(
                    div()
                        .w_full()
                        .rounded(theme.radius)
                        .border_1()
                        .border_color(theme.border)
                        .px_3()
                        .py_2()
                        // Page bg is darker than the card → the field reads
                        // as an actual editable surface, not a faint outline.
                        .bg(theme.background)
                        .child(
                            Textarea::new(&self.pg_input)
                                .appearance(false)
                                .bordered(false)
                                .disabled(disabled_reason.is_some()),
                        ),
                )
                .child(
                    h_flex()
                        .items_center()
                        .gap_2()
                        .child(
                            Label::new(t(lang, "pg_input_hint"))
                                .font_family(MONO)
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        )
                        .child(div().flex_1())
                        .when(self.pg_pending, |d| {
                            d.child(
                                Button::new("pg-stop")
                                    .outline()
                                    .small()
                                    .label(t(lang, "stop"))
                                    .icon(IconName::Close)
                                    .on_click(cx.listener(|this, _, _w, cx| this.pg_stop(cx))),
                            )
                        })
                        .child(
                            Button::new("pg-send")
                                .primary()
                                .small()
                                .label(t(lang, "send"))
                                .icon(IconName::ArrowRight)
                                .loading(self.pg_pending)
                                .disabled(disabled_reason.is_some())
                                .on_click(cx.listener(|this, _, _w, cx| {
                                    this.playground_send(cx);
                                })),
                        ),
                ),
        );

        v_flex()
            .flex_1()
            .min_h_0()
            .gap_3()
            .child(toolbar)
            .child(
                card(cx).flex_1().min_h(px(200.)).overflow_hidden().child(
                    div()
                        .id("pg-scroll")
                        .size_full()
                        .overflow_y_scroll()
                        .track_scroll(&self.pg_scroll)
                        // Blank clicks unfocus the composer via the app
                        // surface's track_focus — no local blur handler.
                        .child(log),
                ),
            )
            .child(composer)
            .into_any_element()
    }
}

/// One chat bubble: user = accent block; assistant = markdown card with
/// pending dots, error + retry, and a meta line for finished replies.
fn pg_message(m: &PgMsg, lang: crate::root::Lang, cx: &mut Context<AppRoot>) -> AnyElement {
    let theme = cx.theme().clone();
    match m.role {
        PgRole::User => div()
            .flex()
            .justify_end()
            .child(
                div()
                    .max_w(rems(36.))
                    .px_3()
                    .py_2()
                    .rounded(theme.radius_lg)
                    .bg(theme.accent)
                    .child(
                        Label::new(m.content.clone())
                            .text_sm()
                            .text_color(theme.accent_foreground)
                            .whitespace_normal(),
                    ),
            )
            .into_any_element(),
        PgRole::Assistant => {
            let mut body = v_flex().gap_2();
            if m.pending && m.content.is_empty() {
                body = body.child(
                    h_flex()
                        .gap_2()
                        .items_center()
                        .child(
                            Spinner::new()
                                .with_size(Size::XSmall)
                                .color(theme.muted_foreground),
                        )
                        .child(
                            Label::new(t(lang, "pg_replying"))
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                );
            } else if let Some(err) = &m.error {
                let id = m.id;
                body = body
                    .child(
                        Label::new(err.clone())
                            .font_family(MONO)
                            .text_xs()
                            .text_color(theme.danger)
                            .whitespace_normal(),
                    )
                    .child(
                        Button::new(SharedString::from(format!("pg-retry-{id}")))
                            .ghost()
                            .xsmall()
                            .label(t(lang, "retry"))
                            .icon(IconName::RotateCw)
                            .on_click(cx.listener(move |this, _, _w, cx| {
                                this.pg_retry(id, cx);
                            })),
                    );
            } else {
                body = body.child(
                    TextView::markdown(
                        SharedString::from(format!("pg-md-{}", m.id)),
                        m.content.clone(),
                    )
                    .selectable(true),
                );
                if m.pending {
                    body = body.child(
                        Spinner::new()
                            .with_size(Size::XSmall)
                            .color(theme.muted_foreground),
                    );
                }
            }
            if let Some(meta) = &m.meta {
                body = body.child(
                    Label::new(meta.clone())
                        .font_family(MONO)
                        .text_xs()
                        .text_color(theme.muted_foreground),
                );
            }
            div()
                .flex()
                .child(
                    div()
                        .max_w(rems(46.))
                        .px_3()
                        .py_2()
                        .rounded(theme.radius_lg)
                        .border_1()
                        .border_color(theme.border)
                        .bg(theme.group_box)
                        .child(body),
                )
                .into_any_element()
        }
    }
}

// ---------------------------------------------------------------------------
// Send pipeline — appends the pending placeholder, fires the request through
// the RUNNING gateway (real auth/scope/protocol path), streams events back.
// ---------------------------------------------------------------------------

impl AppRoot {
    /// One assistant-reply round: appends the pending placeholder and fires
    /// the HTTP request through the RUNNING gateway server — exercising the
    /// real auth/scope/protocol path, not the in-process registry.
    pub(crate) fn pg_send_request(&mut self, cx: &mut Context<Self>) {
        let aid = self.pg_next_msg;
        self.pg_next_msg += 1;
        self.pg_msgs.push(PgMsg {
            id: aid,
            role: PgRole::Assistant,
            content: String::new(),
            pending: true,
            error: None,
            meta: None,
        });
        self.pg_pending = true;
        self.pg_scroll.scroll_to_bottom();

        let model = self
            .pg_model_sel
            .read(cx)
            .selected_value()
            .cloned()
            .unwrap_or_default();
        let key_id = self.pg_key_sel.read(cx).selected_value().cloned();
        let api_key = key_id.and_then(|id| {
            self.service
                .config()
                .server
                .api_keys
                .into_iter()
                .find(|k| k.id == id)
                .map(|k| k.key)
        });
        let Some(api_key) = api_key.filter(|_| !model.is_empty()) else {
            self.pg_apply_event(
                aid,
                PgEvent::Failed(t(self.lang, "pg_no_key").to_string()),
                cx,
            );
            return;
        };
        let api = self.pg_api_type;
        let base = self.snapshot.server.url.trim_end_matches('/').to_string();
        let stream = self.pg_stream;
        let messages: Vec<serde_json::Value> = self
            .pg_msgs
            .iter()
            .filter(|m| m.error.is_none() && !m.pending)
            .map(|m| {
                serde_json::json!({
                    "role": match m.role { PgRole::User => "user", PgRole::Assistant => "assistant" },
                    "content": m.content,
                })
            })
            .collect();
        let (url, body) = match api {
            PgApiType::OpenAi => {
                let mut body = serde_json::json!({
                    "model": model,
                    "messages": messages,
                    "stream": stream,
                });
                if stream {
                    body["stream_options"] = serde_json::json!({"include_usage": true});
                }
                (format!("{base}/v1/chat/completions"), body)
            }
            PgApiType::Anthropic => (
                format!("{base}/v1/messages"),
                // Anthropic requires an explicit cap — a roomy default for a
                // smoke-test composer.
                serde_json::json!({
                    "model": model,
                    "max_tokens": 4096,
                    "messages": messages,
                    "stream": stream,
                }),
            ),
            PgApiType::Responses => (
                format!("{base}/v1/responses"),
                // Responses API takes `input` — the same {role, content}
                // pairs work since string content is normalized upstream.
                serde_json::json!({
                    "model": model,
                    "max_output_tokens": 4096,
                    "input": messages,
                    "stream": stream,
                }),
            ),
        };

        let cancel = tokio_util::sync::CancellationToken::new();
        self.pg_cancel = Some(cancel.clone());
        let (tx, rx) = smol::channel::unbounded::<PgEvent>();
        let started = Instant::now();
        self.service.spawn_ui(async move {
            let client = reqwest::Client::new();
            let resp = tokio::select! {
                _ = cancel.cancelled() => return,
                r = client
                    .post(&url)
                    .bearer_auth(api_key)
                    .json(&body)
                    .send() => r,
            };
            match resp {
                Err(e) => {
                    let _ = tx.try_send(PgEvent::Failed(e.to_string()));
                }
                Ok(resp) if !resp.status().is_success() => {
                    let status = resp.status();
                    let raw = resp.text().await.unwrap_or_default();
                    let msg = serde_json::from_str::<serde_json::Value>(&raw)
                        .ok()
                        .and_then(|v| {
                            v.pointer("/error/message")
                                .and_then(|m| m.as_str())
                                .map(str::to_string)
                        })
                        .unwrap_or(raw);
                    let _ = tx.try_send(PgEvent::Failed(format!("{status} — {msg}")));
                }
                Ok(resp) if !stream => {
                    let v: serde_json::Value = resp.json().await.unwrap_or_default();
                    let text = match api {
                        PgApiType::OpenAi => {
                            pg_extract_text(v.pointer("/choices/0/message/content"))
                        }
                        // Anthropic replies carry a `content` block array.
                        PgApiType::Anthropic => pg_extract_text(v.get("content")),
                        // Responses replies expose the joined text verbatim.
                        PgApiType::Responses => pg_extract_text(v.get("output_text")),
                    };
                    let meta = pg_meta(started, v.get("usage"));
                    let _ = tx.try_send(PgEvent::Full { text, meta });
                }
                Ok(resp) => {
                    use futures::StreamExt;
                    let mut s = resp.bytes_stream();
                    let mut buf = String::new();
                    let mut usage: Option<serde_json::Value> = None;
                    // Anthropic splits token counts across frames — each of
                    // `message_start` / `message_delta` may carry either
                    // count, so both are accumulated as running maxima.
                    let (mut in_tok, mut out_tok) = (0_u64, 0_u64);
                    'outer: loop {
                        let chunk = tokio::select! {
                            _ = cancel.cancelled() => break 'outer,
                            c = s.next() => c,
                        };
                        let Some(Ok(chunk)) = chunk else { break 'outer };
                        buf.push_str(&String::from_utf8_lossy(&chunk));
                        while let Some(nl) = buf.find('\n') {
                            let line = buf[..nl].trim().to_string();
                            buf.drain(..=nl);
                            let Some(data) = line.strip_prefix("data:").map(str::trim) else {
                                continue;
                            };
                            if data == "[DONE]" {
                                break 'outer;
                            }
                            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                                continue;
                            };
                            // Gateway error frame: `data: {"error":{"message":..}}`
                            // (also covers Anthropic `{"type":"error","error":{..}}`).
                            if let Some(err) = v.get("error") {
                                let msg = err
                                    .get("message")
                                    .and_then(|m| m.as_str())
                                    .map(str::to_string)
                                    .unwrap_or_else(|| err.to_string());
                                let _ = tx.try_send(PgEvent::Failed(msg));
                                return;
                            }
                            match api {
                                PgApiType::OpenAi => {
                                    if let Some(u) = v.get("usage") {
                                        usage = Some(u.clone());
                                    }
                                    if let Some(t) = v
                                        .pointer("/choices/0/delta/content")
                                        .and_then(|d| d.as_str())
                                    {
                                        let _ = tx.try_send(PgEvent::Delta(t.to_string()));
                                    }
                                }
                                PgApiType::Anthropic => {
                                    match v.get("type").and_then(|t| t.as_str()) {
                                        Some("message_start") => {
                                            in_tok = v
                                                .pointer("/message/usage/input_tokens")
                                                .and_then(|n| n.as_u64())
                                                .unwrap_or(in_tok);
                                        }
                                        Some("content_block_delta") => {
                                            if let Some(t) =
                                                v.pointer("/delta/text").and_then(|d| d.as_str())
                                            {
                                                let _ = tx.try_send(PgEvent::Delta(t.to_string()));
                                            }
                                        }
                                        // The gateway may fill input/output
                                        // counts only here (message_start
                                        // often carries zeros) — keep the
                                        // max of each.
                                        Some("message_delta") => {
                                            let u = v.get("usage");
                                            in_tok = u
                                                .and_then(|u| u.pointer("/input_tokens"))
                                                .and_then(|n| n.as_u64())
                                                .unwrap_or(in_tok)
                                                .max(in_tok);
                                            out_tok = u
                                                .and_then(|u| u.pointer("/output_tokens"))
                                                .and_then(|n| n.as_u64())
                                                .unwrap_or(out_tok)
                                                .max(out_tok);
                                        }
                                        _ => {}
                                    }
                                }
                                PgApiType::Responses => {
                                    match v.get("type").and_then(|t| t.as_str()) {
                                        Some("response.output_text.delta") => {
                                            if let Some(t) = v.get("delta").and_then(|d| d.as_str())
                                            {
                                                let _ = tx.try_send(PgEvent::Delta(t.to_string()));
                                            }
                                        }
                                        // Completed + incomplete both carry
                                        // the final usage (responses spelling:
                                        // input/output_tokens).
                                        Some("response.completed")
                                        | Some("response.incomplete") => {
                                            if let Some(u) = v.pointer("/response/usage") {
                                                usage = Some(u.clone());
                                            }
                                        }
                                        Some("response.failed") => {
                                            let msg = v
                                                .pointer("/response/error/message")
                                                .and_then(|m| m.as_str())
                                                .map(str::to_string)
                                                .unwrap_or_else(|| "request failed".into());
                                            let _ = tx.try_send(PgEvent::Failed(msg));
                                            return;
                                        }
                                        _ => {}
                                    }
                                }
                            }
                        }
                    }
                    if matches!(api, PgApiType::Anthropic) && (in_tok > 0 || out_tok > 0) {
                        usage = Some(serde_json::json!({
                            "prompt_tokens": in_tok,
                            "completion_tokens": out_tok,
                        }));
                    }
                    let _ = tx.try_send(PgEvent::Done {
                        meta: pg_meta(started, usage.as_ref()),
                    });
                }
            }
        });
        cx.spawn(async move |this, cx| {
            while let Ok(ev) = rx.recv().await {
                let done = !matches!(ev, PgEvent::Delta(_));
                let _ = this.update(cx, |this, cx| this.pg_apply_event(aid, ev, cx));
                if done {
                    return;
                }
            }
            // Channel dropped without a Done/Failed — never leave it pending.
            let _ = this.update(cx, |this, cx| {
                if this.pg_msgs.iter().any(|m| m.id == aid && m.pending) {
                    this.pg_apply_event(aid, PgEvent::Failed("connection lost".into()), cx);
                }
            });
        })
        .detach();
        cx.notify();
    }

    pub(crate) fn playground_send(&mut self, cx: &mut Context<Self>) {
        if self.pg_pending {
            return;
        }
        let text = self.pg_input.read(cx).value().trim().to_string();
        if text.is_empty() {
            return;
        }
        let id = self.pg_next_msg;
        self.pg_next_msg += 1;
        self.pg_msgs.push(PgMsg {
            id,
            role: PgRole::User,
            content: text,
            pending: false,
            error: None,
            meta: None,
        });
        // `set_value` needs a Window the Enter subscription doesn't have —
        // flag it, render clears at the top.
        self.pg_clear_input = true;
        self.pg_send_request(cx);
    }

    /// Drop the failed reply and everything after it, then resend — same as
    /// the Electron playground's `sliceBeforeMessage` retry.
    pub(crate) fn pg_retry(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.pg_pending {
            return;
        }
        if let Some(ix) = self.pg_msgs.iter().position(|m| m.id == id) {
            self.pg_msgs.truncate(ix);
        }
        self.pg_send_request(cx);
    }

    pub(crate) fn pg_stop(&mut self, cx: &mut Context<Self>) {
        if let Some(tok) = self.pg_cancel.take() {
            tok.cancel();
        }
        cx.notify();
    }

    pub(crate) fn pg_clear(&mut self, cx: &mut Context<Self>) {
        self.pg_stop(cx);
        self.pg_msgs.clear();
        cx.notify();
    }

    pub(crate) fn pg_apply_event(&mut self, aid: u64, ev: PgEvent, cx: &mut Context<Self>) {
        match ev {
            PgEvent::Delta(t) => {
                if let Some(m) = self.pg_msgs.iter_mut().find(|m| m.id == aid) {
                    m.content.push_str(&t);
                }
            }
            PgEvent::Full { text, meta } => {
                if let Some(m) = self.pg_msgs.iter_mut().find(|m| m.id == aid) {
                    m.content = if text.is_empty() {
                        t(self.lang, "pg_response_empty").to_string()
                    } else {
                        text
                    };
                    m.meta = meta;
                    m.pending = false;
                }
                self.pg_pending = false;
                self.pg_cancel = None;
            }
            PgEvent::Done { meta } => {
                if let Some(m) = self.pg_msgs.iter_mut().find(|m| m.id == aid) {
                    m.meta = meta;
                    m.pending = false;
                }
                self.pg_pending = false;
                self.pg_cancel = None;
            }
            PgEvent::Failed(err) => {
                if let Some(m) = self.pg_msgs.iter_mut().find(|m| m.id == aid) {
                    m.error = Some(err);
                    m.pending = false;
                }
                self.pg_pending = false;
                self.pg_cancel = None;
            }
        }
        self.pg_scroll.scroll_to_bottom();
        cx.notify();
    }
}

fn pg_extract_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// "1.2s · 128 in / 64 out" — latency + token usage under finished replies.
fn pg_meta(started: Instant, usage: Option<&serde_json::Value>) -> Option<String> {
    let ms = started.elapsed().as_millis();
    let secs = format!("{:.1}s", ms as f64 / 1000.);
    match usage {
        Some(u) => {
            // OpenAI spellings first; Anthropic names the same counts
            // input/output.
            let inp = u
                .pointer("/prompt_tokens")
                .or_else(|| u.pointer("/input_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let out = u
                .pointer("/completion_tokens")
                .or_else(|| u.pointer("/output_tokens"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            Some(format!(
                "{secs} · {} in / {} out",
                fmt_count(inp as i64),
                fmt_count(out as i64)
            ))
        }
        None => Some(secs),
    }
}
