//! Root view: translucent sidebar rail + distinct glass content pane —
//! the liquid-glass shell from the Electron layout, rebuilt on gpui-kit.
//!
//! Page bodies live in `root/pages/*` — `impl AppRoot` blocks only.
//! Shared chrome lives in `root/chrome.rs`.

mod chrome;
mod i18n;
mod overlay_motion;
mod pages;

pub(crate) use i18n::{Lang, t, tf};

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::sync::Arc;
use std::time::{Duration, Instant};

use gateway_core::{
    ApiKeyEntry, GatewayService, GatewayStatusSnapshot, ModelMapping, generate_api_key,
};

pub(crate) use chrome::{
    MONO, card, card_rows, card_uniform_list, clock_time, enter, hairline, one_line, page_header,
    pop_in, provider_logo, row, section_header, shake, short_date, skeleton_rows, status_label,
    toggle_filter,
};

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Icon, Sizable, Size, StyledExt, Theme, ThemeMode,
    button::{Button, ButtonVariants},
    h_flex,
    input::{InputEvent, InputState, TextareaState},
    label::Label,
    searchable_list::{SearchableListItem, SearchableVec},
    select::SelectState,
    spinner::Spinner,
    tooltip::Tooltip,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

/// Content column width — the Electron layout centers `max-w-4xl` (896px)
/// inside the glass pane.
pub(crate) const PAGE_MAX_W: f32 = 896.;
/// Provider detail pages were `max-w-5xl` in the Electron layout.
pub(crate) const DETAIL_MAX_W: f32 = 1024.;
const SIDEBAR_HIDDEN_KEY: &str = "gpuiSidebarHiddenProviders";
const LANG_KEY: &str = "gpuiLang";

fn read_hidden_providers(config: &gateway_core::GatewayHubConfig) -> HashSet<String> {
    config
        .extra
        .get(SIDEBAR_HIDDEN_KEY)
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn write_hidden_providers(config: &mut gateway_core::GatewayHubConfig, hidden: &HashSet<String>) {
    let mut names = hidden.iter().cloned().collect::<Vec<_>>();
    names.sort();
    config
        .extra
        .insert(SIDEBAR_HIDDEN_KEY.into(), serde_json::json!(names));
}

fn read_lang(config: &gateway_core::GatewayHubConfig) -> Lang {
    match config
        .extra
        .get(LANG_KEY)
        .and_then(serde_json::Value::as_str)
    {
        Some("en") => Lang::En,
        Some("zh") => Lang::Zh,
        _ => Lang::System,
    }
}

fn write_lang(config: &mut gateway_core::GatewayHubConfig, lang: Lang) {
    let value = match lang {
        Lang::En => "en",
        Lang::Zh => "zh",
        Lang::System => "system",
    };
    config
        .extra
        .insert(LANG_KEY.into(), serde_json::json!(value));
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Page {
    Dashboard,
    ApiKeys,
    Mappings,
    Playground,
    Usage,
    Logs,
    Settings,
}

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
    pub cancel_label: Option<SharedString>,
    pub width: Pixels,
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
            cancel_label: None,
            width: px(400.),
            on_ok: None,
            backdrop_dismiss: true,
            opened_at: Instant::now(),
        }
    }
}

/// One playground message — keeps per-message pending/error/meta so a failed
/// reply can be retried in place.
#[derive(Clone)]
pub(crate) struct PgMsg {
    pub id: u64,
    pub role: PgRole,
    pub content: String,
    pub pending: bool,
    pub error: Option<String>,
    /// e.g. "1.2s · 128 in / 64 out" — shown under finished replies.
    pub meta: Option<String>,
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum PgRole {
    User,
    Assistant,
}

/// API-key select row: label is what the user reads, value is the key id.
#[derive(Clone, PartialEq)]
pub(crate) struct PgKeyItem {
    pub id: String,
    pub label: String,
}

impl SearchableListItem for PgKeyItem {
    type Value = String;
    fn title(&self) -> SharedString {
        self.label.clone().into()
    }
    fn value(&self) -> &String {
        &self.id
    }
}

/// Stream events from the tokio request task into the UI.
pub(crate) enum PgEvent {
    /// Streaming text delta — appended to the pending reply.
    Delta(String),
    /// Full non-streamed reply.
    Full {
        text: String,
        meta: Option<String>,
    },
    /// Stream finished (or was stopped).
    Done {
        meta: Option<String>,
    },
    Failed(String),
}

pub struct AppRoot {
    pub(crate) service: Arc<GatewayService>,
    /// Expensive aggregate status (including logs) is refreshed on the poll
    /// cadence instead of being rebuilt for every paint/scroll frame.
    pub(crate) snapshot: Arc<GatewayStatusSnapshot>,
    pub(crate) page: Page,
    /// Provider detail view — set when a sidebar provider row is clicked.
    pub(crate) detail: Option<String>,
    /// None = follow the OS appearance.
    pub(crate) mode_choice: Option<ThemeMode>,
    /// Icon-only rail (the Electron sidebar collapsed to 72px).
    pub(crate) collapsed: bool,
    /// UI-only provider visibility. This is deliberately separate from the
    /// provider's `enabled` flag: hiding a sidebar row must never rebuild the
    /// provider registry or interrupt active requests.
    pub(crate) hidden_providers: HashSet<String>,
    /// "provider/accountId" → last test outcome line.
    pub(crate) test_results: HashMap<String, String>,
    /// In-flight account tests — each has a foreground awaiter that notifies
    /// on completion, so results land immediately instead of at the poll.
    pub(crate) test_pending: HashSet<String>,
    /// Models are per-account (model_ids in the runtime state) — see the
    /// account dialog. Provider-level list_models is intentionally unused.
    /// provider → scanned account files. `scan_accounts` hits disk, so
    /// renders read this cache; the poll refreshes the open provider.
    pub(crate) accounts_cache: HashMap<String, Vec<gateway_core::AccountFile>>,
    pub(crate) accounts_pending: HashSet<String>,
    /// provider → per-account runtime state (status, model_ids, checkin,
    /// stats) mirrored from the pools into `gatewayhub.state.json`.
    pub(crate) account_states:
        HashMap<String, HashMap<String, gateway_core::types::AccountRuntimeState>>,
    /// "provider/accountId" → in-flight check-in / model refresh ops.
    pub(crate) checkin_pending: HashSet<String>,
    pub(crate) models_refresh_pending: HashSet<String>,
    /// "provider/accountId" → last manual check-in result line.
    pub(crate) checkin_results: HashMap<String, String>,
    /// In-window overlay card (confirms, import, account detail, key gen) —
    /// layered motion per `overlay_motion` (Heimdall's confirm overlay).
    /// None = no overlay; `overlay_closing` drives the exit tween and
    /// `overlay_sample` freezes the on-screen frame it continues from.
    pub(crate) overlay: Option<OverlayRequest>,
    pub(crate) overlay_closing: Option<Instant>,
    /// Frame snapshot at dismiss time — the exit continues from these
    /// values, so closing mid-open never snaps to a schedule.
    pub(crate) overlay_sample: Option<overlay_motion::OverlayMotion>,
    /// Usage page cache — `UsageStore::read` parses a JSON file, so it runs
    /// on the UI runtime and renders consume this cache.
    pub(crate) usage_cache: Option<gateway_core::usage_store::UsageDetail>,
    pub(crate) usage_loading: bool,
    /// Server start/stop runs on the UI runtime so the shell stays live.
    pub(crate) server_pending: bool,
    /// Providers with a config change awaiting the next registry rebuild.
    pub(crate) provider_pending: HashSet<String>,
    /// Bumped on every provider flag toggle; the rebuild awaiter compares
    /// against the serial at spawn time to decide whether another run is
    /// needed to converge.
    pub(crate) reload_serial: u64,
    /// A registry rebuild is already running — toggles coalesce into a
    /// follow-up rebuild instead of piling onto the UI thread.
    pub(crate) rebuild_running: bool,
    pub(crate) exporting_logs: bool,
    /// Bumped whenever a notice is (re)set so the fade-in replays.
    pub(crate) notice_nonce: u64,
    /// Bumped on invalid input — drives the settings shake animation.
    pub(crate) shake_nonce: u64,
    /// Snippet copy button success state (reverts after a short delay).
    pub(crate) snippet_copied: bool,
    /// API-key page: name for the next generated key.
    pub(crate) key_name_input: Entity<InputState>,
    /// Mapping page inputs.
    pub(crate) map_alias_input: Entity<InputState>,
    pub(crate) map_target_input: Entity<InputState>,
    /// Newly generated key shown once so it can be copied.
    pub(crate) new_key: Option<String>,
    /// Generate-key dialog: provider allowlist + expiry days (0 = never).
    pub(crate) key_scope_all: bool,
    pub(crate) key_scopes: HashSet<String>,
    pub(crate) key_expiry_days: i64,
    /// "Copy" state on the new-key banner — reverts after a short delay.
    pub(crate) key_copied: bool,
    /// Provider detail: paste-an-account-JSON import box + last result.
    pub(crate) import_input: Entity<InputState>,
    pub(crate) import_result: Option<String>,
    /// Playground: model + prompt inputs, transcript, in-flight reply.
    // ---- playground ----
    pub(crate) pg_model_sel: Entity<SelectState<SearchableVec<String>>>,
    pub(crate) pg_key_sel: Entity<SelectState<SearchableVec<PgKeyItem>>>,
    /// Last-synced select contents — re-synced in render when they change.
    pub(crate) pg_model_items: Vec<String>,
    pub(crate) pg_key_items: Vec<PgKeyItem>,
    pub(crate) pg_stream: bool,
    pub(crate) pg_input: Entity<TextareaState>,
    pub(crate) pg_msgs: Vec<PgMsg>,
    pub(crate) pg_next_msg: u64,
    pub(crate) pg_pending: bool,
    pub(crate) pg_cancel: Option<tokio_util::sync::CancellationToken>,
    pub(crate) pg_scroll: ScrollHandle,
    /// Set when Enter fires inside the composer — `set_value` needs a Window,
    /// so the actual clear happens at the top of the next render.
    pub(crate) pg_clear_input: bool,
    /// Logs page: level segment index (0 = all), search text, export notice.
    pub(crate) log_level: usize,
    pub(crate) log_search: Entity<InputState>,
    pub(crate) log_notice: Option<String>,
    pub(crate) log_scroll: UniformListScrollHandle,
    pub(crate) usage_scroll: UniformListScrollHandle,
    pub(crate) account_scroll: HashMap<String, UniformListScrollHandle>,
    /// Settings page: editable server fields + save notice.
    pub(crate) host_input: Entity<InputState>,
    pub(crate) port_input: Entity<InputState>,
    pub(crate) proxy_input: Entity<InputState>,
    pub(crate) settings_notice: Option<String>,
    pub(crate) snippet_format: usize,
    /// UI language. `System` follows the OS locale.
    pub(crate) lang: Lang,
}

impl AppRoot {
    pub fn new(service: Arc<GatewayService>, _window: &mut Window, cx: &mut Context<Self>) -> Self {
        // Status poll — aggregate on the UI runtime, then let render cheaply
        // clone the Arc. status() clones the whole log buffer and
        // scan_accounts/usage reads hit disk, so none of it may run on the
        // main thread every five seconds.
        cx.spawn(async move |this, cx| {
            loop {
                smol::Timer::after(Duration::from_secs(5)).await;
                let Ok((service, provider, want_usage)) = this.update(cx, |root, _cx| {
                    (
                        root.service.clone(),
                        root.detail.clone(),
                        matches!(root.page, Page::Usage),
                    )
                }) else {
                    break;
                };
                let svc = service.clone();
                let handle = service.spawn_ui(async move {
                    let snapshot = svc.status();
                    let accounts = provider
                        .map(|name| (name.clone(), svc.accounts(&name), svc.account_states(&name)));
                    let usage = want_usage.then(|| {
                        svc.usage_store()
                            .read(&gateway_core::usage_store::UsageReadOptions::default())
                    });
                    (snapshot, accounts, usage)
                });
                let Ok((snapshot, accounts, usage)) = handle.await else {
                    continue;
                };
                if this
                    .update(cx, |root, cx| {
                        root.snapshot = Arc::new(snapshot);
                        if let Some((name, list, states)) = accounts {
                            root.accounts_cache.insert(name.clone(), list);
                            root.account_states.insert(name, states);
                        }
                        if let Some(detail) = usage {
                            root.usage_cache = Some(detail);
                        }
                        cx.notify();
                    })
                    .is_err()
                {
                    break;
                }
            }
        })
        .detach();
        let config = service.config();
        let server_cfg = config.server.clone();
        let hidden_providers = read_hidden_providers(&config);
        let lang = read_lang(&config);
        let snapshot = Arc::new(service.status());
        // Composer: multi-line, Enter submits (Shift+Enter = newline). The
        // subscription runs without a Window, so send only flags the clear —
        // `set_value` happens at the top of the next render.
        let pg_input = cx.new(|cx| {
            let mut state = TextareaState::new(_window, cx)
                .submit_on_enter(true)
                .placeholder(t(lang, "pg_input_ph"));
            state.set_auto_grow(1, 5, cx);
            state
        });
        cx.subscribe(&pg_input, |this, _state, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::PressEnter { .. }) {
                this.playground_send(cx);
            }
        })
        .detach();
        Self {
            service,
            snapshot,
            page: Page::Dashboard,
            detail: None,
            mode_choice: None,
            collapsed: false,
            hidden_providers,
            test_results: HashMap::new(),
            test_pending: HashSet::new(),

            accounts_cache: HashMap::new(),
            accounts_pending: HashSet::new(),
            account_states: HashMap::new(),
            checkin_pending: HashSet::new(),
            models_refresh_pending: HashSet::new(),
            checkin_results: HashMap::new(),
            overlay: None,
            overlay_closing: None,
            overlay_sample: None,
            usage_cache: None,
            usage_loading: false,
            server_pending: false,
            provider_pending: HashSet::new(),
            reload_serial: 0,
            rebuild_running: false,
            exporting_logs: false,
            notice_nonce: 0,
            shake_nonce: 0,
            snippet_copied: false,
            key_name_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder(t(lang, "ph_key_name"))),
            map_alias_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder(t(lang, "ph_alias"))),
            map_target_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder(t(lang, "ph_target"))),
            new_key: None,
            key_scope_all: true,
            key_scopes: HashSet::new(),
            key_expiry_days: 0,
            key_copied: false,
            import_input: cx
                .new(|cx| InputState::new(_window, cx).placeholder(t(lang, "ph_import"))),
            import_result: None,
            pg_model_sel: cx.new(|cx| {
                SelectState::new(SearchableVec::new(Vec::<String>::new()), None, _window, cx)
            }),
            pg_key_sel: cx.new(|cx| {
                SelectState::new(
                    SearchableVec::new(Vec::<PgKeyItem>::new()),
                    None,
                    _window,
                    cx,
                )
            }),
            pg_model_items: Vec::new(),
            pg_key_items: Vec::new(),
            pg_stream: true,
            pg_input,
            pg_msgs: Vec::new(),
            pg_next_msg: 1,
            pg_pending: false,
            pg_cancel: None,
            pg_scroll: ScrollHandle::new(),
            pg_clear_input: false,
            log_level: 0,
            log_search: cx.new(|cx| InputState::new(_window, cx).placeholder(t(lang, "ph_filter"))),
            log_notice: None,
            log_scroll: UniformListScrollHandle::new(),
            usage_scroll: UniformListScrollHandle::new(),
            account_scroll: HashMap::new(),
            host_input: cx.new(|cx| {
                InputState::new(_window, cx)
                    .placeholder("127.0.0.1")
                    .default_value(server_cfg.host)
            }),
            port_input: cx.new(|cx| {
                InputState::new(_window, cx)
                    .placeholder("9741")
                    .default_value(server_cfg.port.to_string())
            }),
            proxy_input: cx.new(|cx| {
                InputState::new(_window, cx)
                    .placeholder("http://127.0.0.1:7890 (empty = direct)")
                    .default_value(server_cfg.proxy_url)
            }),
            settings_notice: None,
            snippet_format: 0,
            lang,
        }
    }

    pub(crate) fn toggle_server(&mut self, cx: &mut Context<Self>) {
        if self.server_pending {
            return;
        }
        self.server_pending = true;
        let service = self.service.clone();
        let running = service.server_running();
        let svc = service.clone();
        let handle = service.spawn_ui(async move {
            let result = if running {
                svc.stop_server();
                Ok(())
            } else {
                svc.start_server()
            };
            (result, svc.status())
        });
        cx.spawn(async move |this, cx| {
            let outcome = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.server_pending = false;
                match outcome {
                    Ok((Ok(()), snapshot)) => this.snapshot = Arc::new(snapshot),
                    Ok((Err(e), snapshot)) => {
                        tracing::error!(error = %e, "failed to start gateway server");
                        this.snapshot = Arc::new(snapshot);
                    }
                    Err(e) => {
                        tracing::error!(error = %e, "server task join failed");
                        this.snapshot = Arc::new(this.service.status());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn add_api_key(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let name = self.key_name_input.read(cx).value().trim().to_string();
        if name.is_empty() {
            return;
        }
        // Non-"all" scope with nothing selected = unusable key; guard.
        if !self.key_scope_all && self.key_scopes.is_empty() {
            return;
        }
        let now = gateway_core::pool::now_ms();
        let key = generate_api_key();
        let mut cfg = self.service.config();
        cfg.server.api_keys.push(ApiKeyEntry {
            id: uuid::Uuid::new_v4().to_string(),
            key: key.clone(),
            name,
            created_at: now,
            last_used_at: None,
            expires_at: (self.key_expiry_days > 0).then(|| now + self.key_expiry_days * 86_400_000),
            scopes: (!self.key_scope_all).then(|| {
                let mut v: Vec<String> = self.key_scopes.iter().cloned().collect();
                v.sort();
                v
            }),
            extra: Default::default(),
        });
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.new_key = Some(key);
        self.key_scope_all = true;
        self.key_scopes.clear();
        self.key_expiry_days = 0;
        self.key_name_input.update(cx, |input, cx| {
            input.set_value("", window, cx);
        });
        self.dismiss_overlay(cx);
        cx.notify();
    }

    fn delete_api_key(&mut self, key_id: &str, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        cfg.server.api_keys.retain(|k| k.id != key_id);
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    fn add_mapping(&mut self, cx: &mut Context<Self>) {
        let alias = self.map_alias_input.read(cx).value().trim().to_string();
        let target = self.map_target_input.read(cx).value().trim().to_string();
        let Some((provider, model)) = target.split_once('/') else {
            return;
        };
        if alias.is_empty() || provider.is_empty() || model.is_empty() {
            return;
        }
        let mut cfg = self.service.config();
        cfg.model_mappings.push(ModelMapping {
            alias,
            provider: provider.to_string(),
            model: model.to_string(),
            enabled: true,
            note: None,
            extra: Default::default(),
        });
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    fn toggle_mapping(&mut self, ix: usize, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        if let Some(m) = cfg.model_mappings.get_mut(ix) {
            m.enabled = !m.enabled;
        }
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    fn delete_mapping(&mut self, ix: usize, cx: &mut Context<Self>) {
        let mut cfg = self.service.config();
        if ix < cfg.model_mappings.len() {
            cfg.model_mappings.remove(ix);
        }
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        cx.notify();
    }

    fn clear_logs(&mut self, cx: &mut Context<Self>) {
        self.service.clear_logs();
        self.log_notice = None;
        cx.notify();
    }

    fn export_logs(&mut self, cx: &mut Context<Self>) {
        if self.exporting_logs {
            return;
        }
        self.exporting_logs = true;
        let service = self.service.clone();
        let svc = service.clone();
        let handle = service.spawn_ui(async move {
            svc.export_logs()
                .map(|p| p.display().to_string())
                .map_err(|e| e.to_string())
        });
        cx.spawn(async move |this, cx| {
            let result = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.exporting_logs = false;
                let lang = this.lang;
                this.log_notice = Some(match result {
                    Ok(Ok(path)) => tf(lang, "exported", &[("path", &path)]),
                    Ok(Err(e)) => tf(lang, "export_failed", &[("e", &e)]),
                    Err(e) => tf(lang, "export_failed", &[("e", &e.to_string())]),
                });
                this.notice_nonce += 1;
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    fn save_server_config(
        &mut self,
        update: impl FnOnce(&mut gateway_core::GatewayServerConfig),
        cx: &mut Context<Self>,
    ) {
        let lang = self.lang;
        let mut cfg = self.service.config();
        update(&mut cfg.server);
        self.settings_notice = Some(match self.service.save_config(cfg) {
            Ok(()) if self.service.server_running() => t(lang, "saved_restart").into(),
            Ok(()) => t(lang, "saved").into(),
            Err(e) => tf(lang, "save_failed", &[("e", &e.to_string())]),
        });
        self.notice_nonce += 1;
        cx.notify();
    }

    fn apply_port(&mut self, cx: &mut Context<Self>) {
        let lang = self.lang;
        let port_raw = self.port_input.read(cx).value().trim().to_string();
        let Ok(port) = port_raw.parse::<u16>() else {
            self.settings_notice = Some(tf(lang, "invalid_port", &[("port", &port_raw)]));
            self.shake_nonce += 1;
            self.notice_nonce += 1;
            cx.notify();
            return;
        };
        self.save_server_config(|server| server.port = port, cx);
    }

    fn apply_proxy(&mut self, cx: &mut Context<Self>) {
        let proxy = self.proxy_input.read(cx).value().trim().to_string();
        self.save_server_config(|server| server.proxy_url = proxy, cx);
    }

    fn set_listen_on_lan(
        &mut self,
        listen_on_lan: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let host = if listen_on_lan {
            "0.0.0.0"
        } else {
            "127.0.0.1"
        };
        self.host_input
            .update(cx, |input, cx| input.set_value(host, window, cx));
        self.save_server_config(|server| server.host = host.into(), cx);
    }

    fn toggle_autostart(&mut self, cx: &mut Context<Self>) {
        let lang = self.lang;
        let mut cfg = self.service.config();
        cfg.server.auto_start = !cfg.server.auto_start;
        self.settings_notice = match self.service.save_config(cfg) {
            Ok(()) => None,
            Err(e) => {
                tracing::error!(error = %e, "save config failed");
                Some(tf(lang, "save_failed_short", &[("e", &e.to_string())]))
            }
        };
        self.notice_nonce += 1;
        cx.notify();
    }

    fn set_sidebar_provider_visible(
        &mut self,
        provider: &str,
        visible: bool,
        cx: &mut Context<Self>,
    ) {
        if visible {
            self.hidden_providers.remove(provider);
        } else {
            self.hidden_providers.insert(provider.to_string());
        }
        self.persist_sidebar_visibility();
        cx.notify();
    }

    fn show_all_sidebar_providers(&mut self, cx: &mut Context<Self>) {
        self.hidden_providers.clear();
        self.persist_sidebar_visibility();
        cx.notify();
    }

    fn persist_sidebar_visibility(&self) {
        let mut cfg = self.service.config();
        write_hidden_providers(&mut cfg, &self.hidden_providers);
        if let Err(error) = self.service.save_config(cfg) {
            tracing::error!(%error, "failed to persist sidebar visibility");
        }
    }

    fn set_language(&mut self, lang: Lang, cx: &mut Context<Self>) {
        self.lang = lang;
        let mut cfg = self.service.config();
        write_lang(&mut cfg, lang);
        if let Err(error) = self.service.save_config(cfg) {
            tracing::error!(%error, "failed to persist language");
        }
        cx.notify();
    }

    /// Provider-level enable / proxy toggles — config write + registry
    /// rebuild so the change takes effect for new requests.
    pub(crate) fn toggle_provider_flag(
        &mut self,
        provider: &str,
        flag: &'static str,
        cx: &mut Context<Self>,
    ) {
        let mut cfg = self.service.config();
        let entry = cfg
            .providers
            .entry(provider.to_string())
            .or_insert_with(|| serde_json::json!({}));
        let mut pcfg = gateway_core::ProviderConfig::from_value(entry);
        match flag {
            "enabled" => pcfg.enabled = !pcfg.enabled,
            "useProxy" => pcfg.use_proxy = Some(!pcfg.use_proxy.unwrap_or(false)),
            _ => {}
        }
        *entry = serde_json::to_value(&pcfg).unwrap_or_default();
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.provider_pending.insert(provider.to_string());
        self.reload_serial += 1;
        self.queue_registry_reload(cx);
        cx.notify();
    }

    /// Registry rebuild scans every provider's account dir and constructs
    /// adapters — keep it off the UI thread. Rapid toggles coalesce: each
    /// rebuild reads the latest config, so a queued change triggers at most
    /// one follow-up run.
    fn queue_registry_reload(&mut self, cx: &mut Context<Self>) {
        if self.rebuild_running {
            return;
        }
        self.rebuild_running = true;
        self.spawn_registry_rebuild(cx);
    }

    fn spawn_registry_rebuild(&mut self, cx: &mut Context<Self>) {
        let service = self.service.clone();
        let svc = service.clone();
        let applied = self.reload_serial;
        let handle = service.spawn_ui(async move {
            svc.reload_registry();
            svc.status()
        });
        cx.spawn(async move |this, cx| {
            let snapshot = handle.await;
            let _ = this.update(cx, |this, cx| {
                if let Ok(snapshot) = snapshot {
                    this.snapshot = Arc::new(snapshot);
                }
                if this.reload_serial == applied {
                    // No new toggles arrived during the rebuild — converged.
                    this.provider_pending.clear();
                    this.rebuild_running = false;
                } else {
                    // Toggles landed mid-rebuild — run once more.
                    this.spawn_registry_rebuild(cx);
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Rescan one provider's account dir into the cache after a mutation.
    fn refresh_accounts_cache(&mut self, provider: &str) {
        let accounts = self.service.accounts(provider);
        self.accounts_cache.insert(provider.to_string(), accounts);
    }

    fn toggle_account(&mut self, provider: &str, account_id: &str, cx: &mut Context<Self>) {
        let mut account = self
            .accounts_cache
            .get(provider)
            .and_then(|list| list.iter().find(|a| a.id == account_id))
            .cloned()
            .or_else(|| {
                self.service
                    .accounts(provider)
                    .into_iter()
                    .find(|a| a.id == account_id)
            });
        if let Some(acc) = account.as_mut() {
            acc.enabled = !acc.enabled;
            if let Err(e) = self.service.store().write_account(provider, acc) {
                tracing::error!(error = %e, "write account failed");
            } else {
                self.refresh_accounts_cache(provider);
            }
        }
        cx.notify();
    }

    fn delete_account(&mut self, provider: &str, account_id: &str, cx: &mut Context<Self>) {
        match self.service.store().delete_account(provider, account_id) {
            Ok(_) => self.refresh_accounts_cache(provider),
            Err(e) => tracing::error!(error = %e, "delete account failed"),
        }
        cx.notify();
    }

    fn import_account(&mut self, provider: &str, window: &mut Window, cx: &mut Context<Self>) {
        let lang = self.lang;
        let raw = self.import_input.read(cx).value().trim().to_string();
        if raw.is_empty() {
            return;
        }
        match serde_json::from_str::<serde_json::Value>(&raw) {
            Ok(v) if v.is_object() => {
                let mut account: gateway_core::AccountFile =
                    serde_json::from_value(v).unwrap_or_default();
                if account.id.is_empty() {
                    account.id = uuid::Uuid::new_v4().to_string();
                }
                if !raw.contains("\"enabled\"") {
                    account.enabled = true;
                }
                match self.service.store().write_account(provider, &account) {
                    Ok(path) => {
                        self.import_result = Some(tf(
                            lang,
                            "imported",
                            &[("path", &path.display().to_string())],
                        ));
                        self.refresh_accounts_cache(provider);
                        self.import_input.update(cx, |input, cx| {
                            input.set_value("", window, cx);
                        });
                        self.dismiss_overlay(cx);
                    }
                    Err(e) => {
                        self.import_result =
                            Some(tf(lang, "import_failed", &[("e", &e.to_string())]));
                    }
                }
            }
            _ => {
                self.import_result = Some(t(lang, "invalid_json").into());
            }
        }
        self.notice_nonce += 1;
        cx.notify();
    }

    /// Load a provider's account files on the UI runtime so opening a
    /// detail page never blocks on disk.
    fn load_accounts(&mut self, provider: &str, cx: &mut Context<Self>) {
        if !self.accounts_pending.insert(provider.to_string()) {
            return;
        }
        let service = self.service.clone();
        let name = provider.to_string();
        let (svc, task_name) = (service.clone(), name.clone());
        let handle = service.spawn_ui(async move { svc.accounts(&task_name) });
        cx.spawn(async move |this, cx| {
            let accounts = handle.await.unwrap_or_default();
            let _ = this.update(cx, |this, cx| {
                this.accounts_pending.remove(&name);
                this.accounts_cache.insert(name, accounts);
                cx.notify();
            });
        })
        .detach();
    }

    /// Open a provider's detail page — accounts scan on the UI runtime,
    /// runtime states read from the in-memory state mirror.
    pub(crate) fn open_detail(&mut self, provider: &str, cx: &mut Context<Self>) {
        self.detail = Some(provider.to_string());
        let states = self.service.account_states(provider);
        self.account_states.insert(provider.to_string(), states);
        if !self.accounts_cache.contains_key(provider) {
            self.load_accounts(provider, cx);
        }
    }

    pub(crate) fn test_account(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        let lang = self.lang;
        let key = format!("{provider}/{account_id}");
        if self.test_pending.contains(&key) {
            return;
        }
        let Some(adapter) = self.service.registry().provider(provider) else {
            self.test_results
                .insert(key, t(lang, "provider_not_loaded").into());
            return;
        };
        let account_id = account_id.to_string();
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.service.spawn_ui(async move {
            let result = adapter.test_account(&account_id).await;
            let _ = tx.send(result);
        });
        self.test_results
            .insert(key.clone(), t(lang, "testing").into());
        self.test_pending.insert(key.clone());
        cx.spawn(async move |this, cx| {
            let result = rx.await;
            let _ = this.update(cx, |this, cx| {
                this.test_pending.remove(&key);
                let lang = this.lang;
                match result {
                    Ok(result) => {
                        // Multi-line activity log — what the probe actually
                        // did (auth probe, metadata refresh, model count).
                        let stamp = clock_time(gateway_core::pool::now_ms() / 1000);
                        let prefix = t(
                            lang,
                            if result.ok {
                                "ok_prefix"
                            } else {
                                "fail_prefix"
                            },
                        );
                        let mut lines =
                            vec![format!("[{stamp}] {prefix}{}", result.message)];
                        if let Some(auth_type) = &result.auth_type {
                            lines.push(format!("auth_type: {auth_type}"));
                        }
                        if let Some(expires) = &result.expires_at {
                            lines.push(format!("expires_at: {expires}"));
                        }
                        if !result.models.is_empty() {
                            lines.push(
                                tf(
                                    lang,
                                    "models_n",
                                    &[("n", &result.models.len().to_string())],
                                )
                                .to_string(),
                            );
                        }
                        this.test_results.insert(key, lines.join("\n"));
                    }
                    Err(_) => {
                        this.test_results
                            .insert(key, t(lang, "request_failed").into());
                    }
                }
                cx.notify();
            });
        })
        .detach();
    }

    /// Daily check-in for one account — TraeWork/WorkBuddy adapters expose
    /// `checkin_accounts`; the result and the refreshed runtime state are
    /// stored for the account dialog + row badge.
    pub(crate) fn checkin_account(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        let key = format!("{provider}/{account_id}");
        let lang = self.lang;
        // Already claimed today — the daily check-in is idempotent, so skip
        // the upstream round-trip entirely (manual clicks used force=true,
        // which re-verified upstream on every tap and looked like a bug).
        let checked_today = self
            .account_states
            .get(provider)
            .and_then(|m| m.get(account_id))
            .and_then(|s| s.checkin.as_ref())
            .and_then(|c| c.last_day.as_deref())
            .map(|day| day == crate::root::pages::detail::cn_today())
            .unwrap_or(false);
        if checked_today {
            self.checkin_results
                .insert(key, t(lang, "checked_in_today").into());
            cx.notify();
            return;
        }
        if !self.checkin_pending.insert(key.clone()) {
            return;
        }
        let Some(adapter) = self.service.registry().provider(provider) else {
            self.checkin_pending.remove(&key);
            self.checkin_results
                .insert(key, t(lang, "provider_not_loaded").into());
            cx.notify();
            return;
        };
        let service = self.service.clone();
        let (name, aid) = (provider.to_string(), account_id.to_string());
        let svc = service.clone();
        let name2 = name.clone();
        let handle = service.spawn_ui(async move {
            let result = adapter.checkin_accounts(Some(&aid), false).await;
            (result, svc.account_states(&name2))
        });
        cx.spawn(async move |this, cx| {
            let outcome = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.checkin_pending.remove(&key);
                let lang = this.lang;
                match outcome {
                    Ok((result, states)) => {
                        this.account_states.insert(name, states);
                        let msg = match result {
                            Ok(value) => summarize_checkin(lang, &value),
                            Err(e) => e.to_string(),
                        };
                        this.checkin_results.insert(key, msg);
                    }
                    Err(e) => {
                        this.checkin_results.insert(key, e.to_string());
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Pull the account's own model list (`refreshAccountModels`) — models
    /// differ per account, so they live on the account, not the provider.
    pub(crate) fn refresh_account_models(
        &mut self,
        provider: &str,
        account_id: &str,
        cx: &mut Context<Self>,
    ) {
        let key = format!("{provider}/{account_id}");
        if !self.models_refresh_pending.insert(key.clone()) {
            return;
        }
        let Some(adapter) = self.service.registry().provider(provider) else {
            self.models_refresh_pending.remove(&key);
            return;
        };
        let service = self.service.clone();
        let svc = service.clone();
        let (name, aid) = (provider.to_string(), account_id.to_string());
        let name2 = name.clone();
        let handle = service.spawn_ui(async move {
            let _ = adapter.refresh_account_models(&aid).await;
            svc.account_states(&name2)
        });
        cx.spawn(async move |this, cx| {
            let states = handle.await;
            let _ = this.update(cx, |this, cx| {
                this.models_refresh_pending.remove(&key);
                if let Ok(states) = states {
                    this.account_states.insert(name, states);
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Flip a boolean entry in `provider.settings` (e.g. `autoCheckin`) and
    /// rebuild the registry so provider background tasks observe it.
    pub(crate) fn toggle_provider_setting(
        &mut self,
        provider: &str,
        key: &'static str,
        default: bool,
        cx: &mut Context<Self>,
    ) {
        let mut cfg = self.service.config();
        let Some(entry) = cfg.providers.get_mut(provider) else {
            return;
        };
        let mut pcfg = gateway_core::ProviderConfig::from_value(entry);
        let cur = pcfg
            .settings
            .get(key)
            .and_then(|v| v.as_bool())
            .unwrap_or(default);
        pcfg.settings
            .insert(key.to_string(), serde_json::json!(!cur));
        *entry = serde_json::to_value(&pcfg).unwrap_or_default();
        if let Err(e) = self.service.save_config(cfg) {
            tracing::error!(error = %e, "save config failed");
            return;
        }
        self.provider_pending.insert(provider.to_string());
        self.reload_serial += 1;
        self.queue_registry_reload(cx);
        cx.notify();
    }

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
                cancel_label: Some(t(lang, "cancel").into()),
                width: px(380.),
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
    fn overlay_layer(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<AnyElement> {
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
        let panel_w = req.width;

        // ---- panel content (built once; the layers below carry motion) ----
        let content_group = v_flex()
            .w(panel_w)
            .max_h(window.viewport_size().height - px(140.))
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
                            .xsmall()
                            .icon(IconName::Close)
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
                d.child(div().w_full().px_4().py_4().child((footer)(&*self, window, cx)))
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
                                    .small()
                                    .label(label)
                                    .on_click(cx.listener(|this, _, _w, cx| {
                                        this.dismiss_overlay(cx);
                                    })),
                            )
                        })
                        .when_some(req.ok_label.clone(), |d, label| {
                            d.child(
                                Button::new("overlay-ok")
                                    .danger()
                                    .small()
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
                            div()
                                .id("overlay-panel")
                                .relative()
                                .top(rem_px * m.panel_off_rem)
                                .w(panel_w)
                                // Clicks/scroll inside the card must not
                                // reach the backdrop — and blank panel
                                // chrome releases any focused input.
                                .on_mouse_down(MouseButton::Left, |_, window, cx| {
                                    window.blur(cx);
                                    cx.stop_propagation()
                                })
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
                                            .on_scroll_wheel(|_, _, cx| {
                                                cx.stop_propagation()
                                            }),
                                    )
                                }),
                        ),
                )
                .into_any_element(),
        )
    }

    /// Playground send — goes through the in-process registry (the same
    /// path the HTTP server uses) rather than HTTP, so it works whether
    /// or not the server is running.
    /// One assistant-reply round: appends the pending placeholder and fires
    /// the HTTP request through the RUNNING gateway server — exercising the
    /// real auth/scope/protocol path, not the in-process registry.
    fn pg_send_request(&mut self, cx: &mut Context<Self>) {
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
        let url = format!(
            "{}/v1/chat/completions",
            self.snapshot.server.url.trim_end_matches('/')
        );
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
        let mut body = serde_json::json!({
            "model": model,
            "messages": messages,
            "stream": stream,
        });
        if stream {
            body["stream_options"] = serde_json::json!({"include_usage": true});
        }

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
                    let text = pg_extract_text(v.pointer("/choices/0/message/content"));
                    let meta = pg_meta(started, v.get("usage"));
                    let _ = tx.try_send(PgEvent::Full { text, meta });
                }
                Ok(resp) => {
                    use futures::StreamExt;
                    let mut s = resp.bytes_stream();
                    let mut buf = String::new();
                    let mut usage: Option<serde_json::Value> = None;
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

    fn playground_send(&mut self, cx: &mut Context<Self>) {
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
    fn pg_retry(&mut self, id: u64, cx: &mut Context<Self>) {
        if self.pg_pending {
            return;
        }
        if let Some(ix) = self.pg_msgs.iter().position(|m| m.id == id) {
            self.pg_msgs.truncate(ix);
        }
        self.pg_send_request(cx);
    }

    fn pg_stop(&mut self, cx: &mut Context<Self>) {
        if let Some(tok) = self.pg_cancel.take() {
            tok.cancel();
        }
        cx.notify();
    }

    fn pg_clear(&mut self, cx: &mut Context<Self>) {
        self.pg_stop(cx);
        self.pg_msgs.clear();
        cx.notify();
    }

    fn pg_apply_event(&mut self, aid: u64, ev: PgEvent, cx: &mut Context<Self>) {
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

/// Extract text from an OpenAI message content value — string or parts array.
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
            let inp = u
                .pointer("/prompt_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let out = u
                .pointer("/completion_tokens")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            Some(format!("{secs} · {inp} in / {out} out"))
        }
        None => Some(secs),
    }
}

// ---------------------------------------------------------------------------
// sidebar geometry + nav rows
// ---------------------------------------------------------------------------

/// Sidebar widths mirror the Electron shell.
const SIDEBAR_W: f32 = 148.;
const SIDEBAR_W_COLLAPSED: f32 = 72.;
/// Fixed row height — every nav row shares this so icons and labels sit on
/// one vertical spine.
const NAV_ROW_H: f32 = 32.;
/// Leading icon lane — fixed width so labels align whether or not a row
/// carries an icon.
const ICON_LANE: f32 = 40.;
/// Nav icon size — compact but still legible in the 32px navigation row.
const NAV_ICON: f32 = 15.;

/// One sidebar row: fixed height, leading icon lane, then the label.
/// Selection is a filled background — no border, the native macOS idiom.
fn nav_row(
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
        .when(active, |d| d.bg(theme.list_active))
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
fn sidebar_section_label(text: &str, cx: &App) -> impl IntoElement {
    Label::new(text)
        .text_xs()
        .font_medium()
        .text_color(cx.theme().muted_foreground)
}

impl Render for AppRoot {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let overlay = self.overlay_layer(window, cx);
        let theme = cx.theme().clone();
        let snapshot = self.snapshot.clone();
        let running = snapshot.server.running;

        // ---- sidebar ----
        let collapsed = self.collapsed;
        let sidebar_w = if collapsed {
            SIDEBAR_W_COLLAPSED
        } else {
            SIDEBAR_W
        };

        // Primary destinations
        let lang = self.lang;
        let mut nav = v_flex().gap_0p5();
        for (page, id, icon, label_key) in [
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
            (Page::ApiKeys, "nav-apikeys", IconName::Asterisk, "nav_api_keys"),
            (
                Page::Mappings,
                "nav-mappings",
                IconName::Replace,
                "nav_mappings",
            ),
            (Page::Usage, "nav-usage", IconName::ChartPie, "nav_usage"),
        ] {
            let active = self.detail.is_none() && self.page == page;
            let glyph = Icon::new(icon)
                .size(px(NAV_ICON))
                .text_color(if active {
                    theme.foreground
                } else {
                    theme.muted_foreground
                })
                .into_any_element();
            let label: SharedString = t(lang, label_key).into();
            nav = nav.child(nav_row(id, glyph, label, active, collapsed, cx).on_click(
                cx.listener(move |this, _, _w, cx| {
                    this.page = page;
                    this.detail = None;
                    cx.notify();
                }),
            ));
        }

        // Providers section
        let mut providers_section = v_flex().gap_0p5();
        if !collapsed {
            providers_section = providers_section.child(
                div()
                    .px_3()
                    .pt_3()
                    .pb_1()
                    .child(sidebar_section_label(t(lang, "nav_providers"), cx)),
            );
        }
        // All real providers stay in the rail — a disabled one is dimmed
        // but still reachable (it must stay openable to be re-enabled).
        let visible_providers: Vec<_> = snapshot
            .providers
            .iter()
            .filter(|p| {
                p.status != "placeholder" && !self.hidden_providers.contains(&p.name)
            })
            .collect();
        for p in &visible_providers {
            let active = self.detail.as_deref() == Some(p.name.as_str());
            let name = p.name.clone();
            let dim = !p.configured || !p.enabled;
            let glyph = provider_logo(&p.provider_type, NAV_ICON, dim, cx);
            let label = p.display_name.clone().unwrap_or_else(|| p.name.clone());
            let status_color = if !p.enabled {
                theme.muted_foreground.opacity(0.5)
            } else {
                match status_label(p) {
                    "ready" => theme.success,
                    "error" => theme.danger,
                    _ => theme.muted_foreground,
                }
            };
            let row = nav_row(
                SharedString::from(format!("nav-p-{}", p.name)),
                glyph,
                label.into(),
                active,
                collapsed,
                cx,
            )
            .on_click(cx.listener(move |this, _, _w, cx| {
                this.open_detail(&name, cx);
                cx.notify();
            }));
            providers_section = providers_section.child(if collapsed {
                row
            } else {
                row.child(div().flex_1()).child(
                    div()
                        .size_1p5()
                        .flex_none()
                        .mr_1()
                        .rounded_full()
                        .bg(status_color),
                )
            });
        }

        // Settings at the bottom of nav
        let settings_active = self.detail.is_none() && self.page == Page::Settings;
        let settings_row = nav_row(
            "nav-settings",
            Icon::new(IconName::Settings)
                .size(px(NAV_ICON))
                .text_color(if settings_active {
                    theme.foreground
                } else {
                    theme.muted_foreground
                })
                .into_any_element(),
            t(lang, "nav_settings").into(),
            settings_active,
            collapsed,
            cx,
        )
        .on_click(cx.listener(|this, _, _w, cx| {
            this.page = Page::Settings;
            this.detail = None;
            cx.notify();
        }));

        // Footer: gateway state + theme + language + collapse.  These are the
        // persistent shell actions from the Electron sidebar.
        let dark = theme.mode.is_dark();
        let server_pending = self.server_pending;
        let footer = h_flex()
            .items_center()
            .gap_0p5()
            .px_1()
            .py_1p5()
            .border_t_1()
            .border_color(theme.sidebar_border)
            .when(collapsed, |d| d.justify_center())
            .when(!collapsed, |d| {
                d.child(
                    div()
                        .id("rail-server")
                        .h_7()
                        .px_2()
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .rounded(theme.radius)
                        .hover(|d| d.bg(theme.sidebar_accent))
                        .on_click(cx.listener(|this, _, _w, cx| this.toggle_server(cx)))
                        .child(if server_pending {
                            Spinner::new()
                                .with_size(Size::XSmall)
                                .color(theme.muted_foreground)
                                .into_any_element()
                        } else {
                            div()
                                .size_1p5()
                                .rounded_full()
                                .bg(if running {
                                    theme.success
                                } else {
                                    theme.danger
                                })
                                .into_any_element()
                        })
                        .child(
                            Label::new(t(lang, if running { "running" } else { "stopped" }))
                                .text_xs()
                                .text_color(theme.muted_foreground),
                        ),
                )
                .child(div().flex_1())
            })
            .child(
                Button::new("rail-lang")
                    .ghost()
                    .xsmall()
                    .icon(IconName::Globe)
                    .tooltip(t(lang, "language"))
                    .on_click(cx.listener(|this, _, _w, cx| {
                        this.set_language(this.lang.next(), cx);
                    })),
            )
            .child(
                // Icon swap — scale + rotate into place on each mode flip.
                div()
                    .id("rail-theme")
                    .size_7()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(theme.radius)
                    .cursor_pointer()
                    .hover(|d| d.bg(theme.sidebar_accent))
                    .tooltip({
                        let tip: SharedString = t(
                            lang,
                            if dark {
                                "switch_to_light"
                            } else {
                                "switch_to_dark"
                            },
                        )
                        .into();
                        move |window, cx| Tooltip::new(tip.clone()).build(window, cx)
                    })
                    .on_click(cx.listener(|this, _, _w, cx| {
                        let next = if cx.theme().mode.is_dark() {
                            ThemeMode::Light
                        } else {
                            ThemeMode::Dark
                        };
                        this.mode_choice = Some(next);
                        Theme::change(next, None, cx);
                        cx.notify();
                    }))
                    .child(
                        Icon::new(if dark { IconName::Sun } else { IconName::Moon })
                            .size(px(NAV_ICON))
                            .text_color(theme.muted_foreground)
                            .with_animation(
                                SharedString::from(format!("rail-theme-{dark}")),
                                Animation::new(Duration::from_millis(240))
                                    .with_easing(ease_out_quint()),
                                |icon, d| {
                                    icon.transform(
                                        Transformation::scale(size(0.4 + 0.6 * d, 0.4 + 0.6 * d))
                                            .with_rotation(percentage((1. - d) * 0.3)),
                                    )
                                    .opacity(d)
                                },
                            ),
                    ),
            )
            .child(
                Button::new("rail-collapse")
                    .ghost()
                    .xsmall()
                    .icon(if collapsed {
                        IconName::PanelLeftOpen
                    } else {
                        IconName::PanelLeftClose
                    })
                    .tooltip(if collapsed {
                        t(lang, "expand_sidebar")
                    } else {
                        t(lang, "collapse_sidebar")
                    })
                    .on_click(cx.listener(|this, _, _w, cx| {
                        this.collapsed = !this.collapsed;
                        cx.notify();
                    })),
            );

        // Width tween on collapse/expand — the transitions-dev "card
        // resize". The animator owns `w` for the duration; the resting state
        // lands on `sidebar_w`.
        let sidebar = v_flex()
            .w(px(sidebar_w))
            .flex_none()
            .h_full()
            .min_h_0()
            .overflow_hidden()
            .with_animation(
                SharedString::from(format!("rail-w-{collapsed}")),
                Animation::new(Duration::from_millis(180)).with_easing(ease_out_quint()),
                move |el, d| {
                    let (from, to) = if collapsed {
                        (SIDEBAR_W, SIDEBAR_W_COLLAPSED)
                    } else {
                        (SIDEBAR_W_COLLAPSED, SIDEBAR_W)
                    };
                    el.w(px(from + (to - from) * d))
                },
            )
            // Only clear the native controls. The former brand header is gone,
            // so navigation can begin immediately below the traffic lights.
            .child(div().h(px(20.)).flex_none())
            .child(div().px_1().py_1p5().child(nav))
            .child(hairline(cx).mx_3().my_1())
            .child(
                v_flex()
                    .id("provider-list")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .px_1()
                    .child(providers_section),
            )
            .child(hairline(cx).mx_3().my_1())
            .child(div().px_1().py_1().child(settings_row))
            .child(footer);

        let (body, max_w) = if let Some(provider) = self.detail.clone() {
            (
                self.render_provider_detail(&provider, snapshot.as_ref(), cx),
                DETAIL_MAX_W,
            )
        } else {
            (
                match self.page {
                    Page::Dashboard => self.render_dashboard(snapshot.as_ref(), cx),
                    Page::ApiKeys => self.render_api_keys(snapshot.as_ref(), cx),
                    Page::Mappings => self.render_mappings(snapshot.as_ref(), cx),
                    Page::Playground => self.render_playground(snapshot.as_ref(), window, cx),
                    Page::Usage => self.render_usage(snapshot.as_ref(), cx),
                    Page::Logs => self.render_logs(snapshot.as_ref(), cx),
                    Page::Settings => self.render_settings(snapshot.as_ref(), cx),
                },
                PAGE_MAX_W,
            )
        };

        let enabled_count = snapshot
            .providers
            .iter()
            .filter(|provider| provider.enabled && provider.status != "placeholder")
            .count();
        let ready_count = snapshot
            .providers
            .iter()
            .filter(|provider| {
                provider.enabled && provider.status != "placeholder" && provider.status == "ready"
            })
            .count();
        let error_count = snapshot
            .logs
            .iter()
            .filter(|entry| entry.level == gateway_core::LogLevel::Error)
            .count();
        let status_strip = h_flex()
            .h_10()
            .flex_none()
            .items_center()
            .gap_4()
            .px_5()
            .border_b_1()
            .border_color(theme.border)
            .child(
                h_flex()
                    .items_center()
                    .gap_1p5()
                    .child(div().size_1p5().rounded_full().bg(if running {
                        theme.success
                    } else {
                        theme.muted_foreground
                    }))
                    .child(
                        Label::new(t(
                            lang,
                            if running {
                                "running_caps"
                            } else {
                                "stopped_caps"
                            },
                        ))
                        .font_family(MONO)
                        .text_xs()
                        .font_semibold()
                        .text_color(if running {
                            theme.primary
                        } else {
                            theme.muted_foreground
                        })
                        .when(!running, |l| l.font_semibold()),
                    ),
            )
            .child(
                Label::new(snapshot.server.url.clone())
                    .font_family(MONO)
                    .text_xs()
                    .text_color(theme.muted_foreground),
            )
            .child(div().flex_1())
            .child(
                Label::new(format!("{ready_count}/{enabled_count}"))
                    .font_family(MONO)
                    .text_xs()
                    .text_color(theme.muted_foreground),
            )
            .child(
                Label::new(tf(lang, "n_err", &[("n", &error_count.to_string())]))
                    .font_family(MONO)
                    .text_xs()
                    .text_color(if error_count > 0 {
                        theme.danger
                    } else {
                        theme.muted_foreground
                    }),
            )
            .child(
                Label::new(tf(lang, "version", &[("ver", env!("CARGO_PKG_VERSION"))]))
                    .font_family(MONO)
                    .text_xs()
                    .text_color(theme.muted_foreground),
            );

        // ---- shell: Electron geometry, rendered with opaque surfaces so
        // virtualized lists retain smooth scrolling. ----
        // The overlay mounts on the outermost wrapper (relative + size_full)
        // so its absolute positioning covers the whole window and nothing is
        // clipped by the content column's overflow-hidden.
        div()
            .size_full()
            .relative()
            // Clicking inert chrome releases input focus — the Zed-style
            // "background click unfocuses" contract. Inputs and Select
            // triggers stop propagation on their own mousedown, so this
            // only sees clicks that landed on non-focusable surface.
            .on_mouse_down(MouseButton::Left, |_, window, cx| {
                window.blur(cx);
            })
            .child(
                h_flex()
                    .items_stretch()
                    .size_full()
                    .bg(theme.sidebar)
                    .p_3()
                    .px_1()
                    .gap_3()
                    .child(sidebar)
                    .child(
                        v_flex()
                            .flex_1()
                            .h_full()
                            .min_w_0()
                            .rounded(theme.radius_lg)
                            .border_1()
                            .border_color(theme.window_border)
                            .bg(theme.background)
                            .overflow_hidden()
                            .child(status_strip)
                            .child({
                                // Pages with virtualized lists manage their own scroll;
                                // the wrapper must not also scroll (nested scroll fights).
                                let fills_height = matches!(self.page, Page::Logs | Page::Usage);
                                // Fade + slight rise on every page switch — keyed by
                                // destination so the animation replays per navigation.
                                let page_key: SharedString = match &self.detail {
                                    Some(name) => format!("enter-detail-{name}").into(),
                                    None => format!("enter-page-{}", self.page as usize).into(),
                                };
                                div()
                                    .id("page-scroll")
                                    .flex_1()
                                    .min_h_0()
                                    .when(fills_height, |d| d.overflow_hidden())
                                    .when(!fills_height, |d| d.overflow_y_scroll())
                                    .child(enter(
                                        div()
                                            .mx_auto()
                                            .w_full()
                                            .max_w(px(max_w))
                                            .px_6()
                                            .pb_5()
                                            .when(fills_height, |d| d.h_full())
                                            .child(body),
                                        page_key,
                                    ))
                            }),
                    ),
            )
            .children(overlay)
    }
}

/// Compact one-line summary for a `checkin_accounts` result — prefers the
/// first per-account entry, falls back to the aggregate counts.
fn summarize_checkin(lang: Lang, value: &serde_json::Value) -> String {
    if let Some(first) = value
        .get("results")
        .and_then(|v| v.as_array())
        .and_then(|r| r.first())
    {
        if first.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
            return match first.get("credits").and_then(|v| v.as_f64()) {
                Some(c) => tf(lang, "checkin_credits", &[("credits", &format!("{c:.0}"))]),
                None => t(lang, "checked_in_today").into(),
            };
        }
        let err = first.get("error").and_then(|v| v.as_str()).unwrap_or("?");
        return tf(lang, "checkin_failed", &[("e", err)]);
    }
    let claimed = value.get("claimed").and_then(|v| v.as_u64()).unwrap_or(0);
    let failed = value.get("failed").and_then(|v| v.as_u64()).unwrap_or(0);
    tf(
        lang,
        "checkin_summary",
        &[("c", &claimed.to_string()), ("f", &failed.to_string())],
    )
}

#[cfg(test)]
mod tests {
    use super::{read_hidden_providers, write_hidden_providers};
    use std::collections::HashSet;

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
}
