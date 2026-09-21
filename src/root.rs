//! Root view: translucent sidebar rail + distinct glass content pane —
//! the liquid-glass shell from the Electron layout, rebuilt on gpui-kit.
//!
//! Page bodies live in `root/pages/*` — `impl AppRoot` blocks only.
//! Shared chrome lives in `root/chrome.rs`.

mod accounts;
mod chrome;
mod i18n;
mod ops;
mod overlay;
mod overlay_motion;
mod pages;
mod persist;
mod sidebar;

pub(crate) use i18n::{Lang, t, tf};
pub(crate) use overlay::OverlayRequest;
pub(crate) use persist::*;
pub(crate) use sidebar::*;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use gateway_core::{
    ApiKeyEntry, GatewayService, GatewayStatusSnapshot, ModelMapping, ModelTarget, generate_api_key,
};

pub(crate) use chrome::{
    CHART_H, DIALOG_W_LG, DIALOG_W_MD, DIALOG_W_SM, FIELD_W_LG, FIELD_W_MD, FIELD_W_SM, ICON_XL,
    LANE_DURATION, LANE_LABEL, LANE_LEVEL, LANE_PROVIDER, LANE_STATUS, LANE_TIME, MENU_W_LG,
    MENU_W_MD, MENU_W_SM, MONO, MarqueeText, PANE_MIN_H, ROW_H, ROW_H_TALL, SCROLL_H_LG,
    SCROLL_H_MD, SCROLL_H_SM, card, card_rows, card_uniform_list, clock_time, enter, fmt_count,
    hairline, one_line, pop_in, provider_logo, row, section_header, shake, short_date,
    skeleton_rows, status_label, status_tone, toggle_chip, toggle_filter,
};

use gpui_kit::assets::IconName;
use gpui_kit::component::{
    ActiveTheme, Icon, Sizable, Size, ThemeMode,
    button::{Button, ButtonVariants},
    h_flex,
    input::{InputEvent, InputState, TextareaState},
    label::Label,
    scroll::ScrollableElement,
    searchable_list::{SearchableListItem, SearchableVec},
    select::{SelectEvent, SelectState},
    spinner::Spinner,
    tooltip::Tooltip,
    v_flex,
};
use gpui_kit::prelude::*;
use gpui_kit::*;

/// Content column width — the Electron layout centers `max-w-4xl` (896px)
/// inside the glass pane.
/// Page column width — rem so the centered column follows interface zoom
/// (the Electron layout centered `max-w-4xl` inside the glass pane).
pub(crate) const PAGE_MAX_W: Rems = rems(56.); // 896px @16
/// Provider detail pages were `max-w-5xl` in the Electron layout.
pub(crate) const DETAIL_MAX_W: Rems = rems(64.); // 1024px @16
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

/// Playground request format — which protocol the composer exercises.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum PgApiType {
    /// `POST /v1/chat/completions`
    OpenAi,
    /// `POST /v1/messages`
    Anthropic,
    /// `POST /v1/responses`
    Responses,
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

/// One editable (provider, model) target row in the mapping overlay — both
/// selects; `_provider_sub` rebuilds the model options when the provider
/// pick confirms (kept alive by storing it on the row).
pub(crate) struct MapTargetRow {
    pub provider: Entity<SelectState<SearchableVec<String>>>,
    pub model: Entity<SelectState<SearchableVec<String>>>,
    _provider_sub: Subscription,
}

pub struct AppRoot {
    /// Focus target for non-interactive application chrome. GPUI transfers
    /// focus to the nearest tracked surface on mouse down, so clicking page
    /// chrome naturally blurs an input without an ancestor `window.blur()`
    /// racing the input's own focus handler.
    shell_focus: FocusHandle,
    /// Separate focus target for modal chrome. The panel stops propagation to
    /// the dismissible backdrop, so it needs its own place to move focus when
    /// the user clicks beside a control inside the card.
    overlay_focus: FocusHandle,
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
    /// False until the sidebar selection pill has painted once — its first
    /// appearance snaps to the slot, later moves glide.
    pub(crate) animate_selection_pill: bool,
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
    /// "provider/accountId" → last model-refresh result line.
    pub(crate) models_refresh_results: HashMap<String, String>,
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
    /// Mapping overlay: alias field.
    pub(crate) map_alias_input: Entity<InputState>,
    /// Mapping overlay: one (provider, model) select pair per target row.
    pub(crate) map_target_rows: Vec<MapTargetRow>,
    /// Row index the mapping overlay is editing (`None` = adding a new one).
    pub(crate) map_editing: Option<usize>,
    /// Mapping overlay validation message (empty alias / no valid target).
    pub(crate) map_err: Option<SharedString>,
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
    /// Which endpoint the composer hits — persisted in config.extra.
    pub(crate) pg_api_type: PgApiType,
    pub(crate) pg_stream: bool,
    pub(crate) pg_input: Entity<TextareaState>,
    pub(crate) pg_msgs: Vec<PgMsg>,
    pub(crate) pg_next_msg: u64,
    pub(crate) pg_pending: bool,
    pub(crate) pg_cancel: Option<tokio_util::sync::CancellationToken>,
    pub(crate) pg_scroll: ScrollHandle,
    /// Page-content scroll handle — lets the shell attach a scrollbar thumb.
    pub(crate) page_scroll: ScrollHandle,
    /// Sidebar provider-list scroll handle.
    pub(crate) provider_scroll: ScrollHandle,
    /// Mapping overlay target-rows scroll handle.
    pub(crate) map_scroll: ScrollHandle,
    /// Account overlay models-wall scroll handle.
    pub(crate) models_scroll: ScrollHandle,
    /// Set when Enter fires inside the composer — `set_value` needs a Window,
    /// so the actual clear happens at the top of the next render.
    pub(crate) pg_clear_input: bool,
    /// Logs page: level segment index (0 = all), provider filter, search
    /// text, export notice.
    pub(crate) log_level: usize,
    /// Provider filter dropdown — no selection means all providers.
    pub(crate) log_provider_sel: Entity<SelectState<SearchableVec<String>>>,
    /// Last-synced provider names pushed into the filter dropdown.
    pub(crate) log_provider_items: Vec<String>,
    pub(crate) log_search: Entity<InputState>,
    pub(crate) log_notice: Option<String>,
    pub(crate) log_scroll: UniformListScrollHandle,
    // ---- CLI add-account flow (kiro/qoder) ----
    /// Provider the add-account overlay is bound to (drives detect/login).
    pub(crate) cli_provider: Option<String>,
    /// Overlay tab — 0 = CLI detect/login, 1 = paste JSON.
    pub(crate) cli_tab: usize,
    pub(crate) cli_detecting: bool,
    pub(crate) cli_detect: Option<gateway_core::cli_login::CliDetectResult>,
    /// A login subprocess is running; `cli_login_output` streams live.
    pub(crate) cli_login_active: bool,
    pub(crate) cli_login_output: String,
    /// Terminal failure text once the flow ends without an import.
    pub(crate) cli_login_err: Option<String>,
    /// Qoder "import current CLI auth" one-shot state.
    pub(crate) cli_import_busy: bool,
    pub(crate) cli_import_msg: Option<String>,
    pub(crate) cli_copy_ok: bool,
    pub(crate) cli_scroll: ScrollHandle,
    // ---- Discover add-account flow (local credential scan) ----
    /// A scan is running on the UI runtime.
    pub(crate) discover_loading: bool,
    pub(crate) discover_candidates: Vec<gateway_core::discover::ScanCandidate>,
    /// Candidate ids the user checked for import.
    pub(crate) discover_selected: HashSet<String>,
    /// An import (rescan + write) is in flight.
    pub(crate) discover_import_busy: bool,
    pub(crate) discover_scroll: ScrollHandle,
    pub(crate) usage_scroll: UniformListScrollHandle,
    /// Usage breakdown grouping — 0 = by provider, 1 = by model, 2 = by day.
    pub(crate) usage_view: usize,
    /// Usage drill-down — (dimension, key) with `dimension` sharing
    /// `usage_view`'s numbering. Set by clicking a breakdown row; the table
    /// then shows the complementary cut (entity → daily log, day → its
    /// provider/model rows).
    pub(crate) usage_drill: Option<(usize, String)>,
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
        let pg_api_type = read_pg_api_type(&config);
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
        // Provider filter for the logs page — Confirm fires on pick and on
        // cleanable-clear, and render reads selected_value(), so a plain
        // notify re-filters the list.
        let log_provider_sel = cx.new(|cx| {
            SelectState::new(SearchableVec::new(Vec::<String>::new()), None, _window, cx)
        });
        cx.subscribe(
            &log_provider_sel,
            |_this, _state, _ev: &SelectEvent<SearchableVec<String>>, cx| cx.notify(),
        )
        .detach();
        Self {
            shell_focus: cx.focus_handle(),
            overlay_focus: cx.focus_handle(),
            service,
            snapshot,
            page: Page::Dashboard,
            detail: None,
            mode_choice: None,
            collapsed: false,
            animate_selection_pill: false,
            hidden_providers,
            test_results: HashMap::new(),
            test_pending: HashSet::new(),

            accounts_cache: HashMap::new(),
            accounts_pending: HashSet::new(),
            account_states: HashMap::new(),
            checkin_pending: HashSet::new(),
            models_refresh_pending: HashSet::new(),
            checkin_results: HashMap::new(),
            models_refresh_results: HashMap::new(),
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
            map_target_rows: Vec::new(),
            map_editing: None,
            map_err: None,
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
                    .searchable(true)
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
            pg_api_type,
            pg_stream: true,
            pg_input,
            pg_msgs: Vec::new(),
            pg_next_msg: 1,
            pg_pending: false,
            pg_cancel: None,
            pg_scroll: ScrollHandle::new(),
            page_scroll: ScrollHandle::new(),
            provider_scroll: ScrollHandle::new(),
            map_scroll: ScrollHandle::new(),
            models_scroll: ScrollHandle::new(),
            pg_clear_input: false,
            log_level: 0,
            log_provider_sel,
            log_provider_items: Vec::new(),
            log_search: cx.new(|cx| InputState::new(_window, cx).placeholder(t(lang, "ph_filter"))),
            log_notice: None,
            log_scroll: UniformListScrollHandle::new(),
            cli_provider: None,
            cli_tab: 0,
            cli_detecting: false,
            cli_detect: None,
            cli_login_active: false,
            cli_login_output: String::new(),
            cli_login_err: None,
            cli_import_busy: false,
            cli_import_msg: None,
            cli_copy_ok: false,
            cli_scroll: ScrollHandle::new(),
            discover_loading: false,
            discover_candidates: Vec::new(),
            discover_selected: HashSet::new(),
            discover_import_busy: false,
            discover_scroll: ScrollHandle::new(),
            usage_scroll: UniformListScrollHandle::new(),
            usage_view: 0,
            usage_drill: None,
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
}

/// Extract text from an OpenAI message content value — string or parts array.
/// Outermost application surface. This follows Zed's GPUI input example:
/// the surrounding view is focusable, so clicking non-interactive chrome
/// transfers focus away from the current input. A focused child calls
/// `prevent_default`, which keeps the parent from stealing focus back.
fn app_surface(focus_handle: &FocusHandle) -> Div {
    div().size_full().relative().track_focus(focus_handle)
}

/// Overlay card hit boundary. It behaves like a small focusable root: blank
/// panel chrome takes focus, while focused descendants prevent that default.
/// Propagation still stops here so a panel click cannot dismiss the backdrop.
fn overlay_panel_surface(focus_handle: &FocusHandle) -> Stateful<Div> {
    let panel_focus = focus_handle.clone();
    div()
        .track_focus(focus_handle)
        .id("overlay-panel")
        .relative()
        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
            // Depending on listener order, track_focus may already have
            // performed this default action. The explicit fallback makes the
            // panel robust while still respecting a focused child.
            if !window.default_prevented() {
                panel_focus.focus(window, cx);
                window.prevent_default();
            }
            cx.stop_propagation();
        })
}

impl Focusable for AppRoot {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.shell_focus.clone()
    }
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

        // Selection slot — the pill mounts inside the zone holding it.
        let pill_animate = self.animate_selection_pill;
        let sel_nav_ix = if self.detail.is_none() {
            NAV_ITEMS.iter().position(|(p, ..)| *p == self.page)
        } else {
            None
        };
        // All real providers stay in the rail — a disabled one is dimmed
        // but still reachable (it must stay openable to be re-enabled).
        // Coming-soon providers never enter the rail at all.
        let visible_providers: Vec<_> = snapshot
            .providers
            .iter()
            .filter(|p| {
                Self::provider_live(&p.name)
                    && p.status != "placeholder"
                    && !self.hidden_providers.contains(&p.name)
            })
            .collect();
        let sel_provider_ix = self
            .detail
            .as_deref()
            .and_then(|name| visible_providers.iter().position(|p| p.name == name));
        if sel_nav_ix.is_some() || sel_provider_ix.is_some() {
            self.animate_selection_pill = true;
        }

        // Primary destinations
        let lang = self.lang;
        let mut nav = v_flex().gap_0p5().relative();
        if let Some(ix) = sel_nav_ix {
            nav = nav.child(nav_sel_pill(
                rems(NAV_PITCH.0 * ix as f32),
                pill_animate,
                collapsed,
                cx,
            ));
        }
        for (page, id, icon, label_key) in NAV_ITEMS {
            let active = self.detail.is_none() && self.page == page;
            let glyph = Icon::new(icon)
                .size(rems(NAV_ICON / 16.))
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
        // Provider rows get their own relative wrapper so the pill's
        // slot Y is content-space — it scrolls with the rows.
        let mut provider_rows = v_flex().gap_0p5().relative();
        if let Some(ix) = sel_provider_ix {
            provider_rows = provider_rows.child(nav_sel_pill(
                rems(NAV_PITCH.0 * ix as f32),
                pill_animate,
                collapsed,
                cx,
            ));
        }
        for p in &visible_providers {
            let active = self.detail.as_deref() == Some(p.name.as_str());
            let name = p.name.clone();
            let dim = !p.configured || !p.enabled;
            let glyph = provider_logo(&p.provider_type, NAV_ICON, dim, cx);
            let label = p.display_name.clone().unwrap_or_else(|| p.name.clone());
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
            provider_rows = provider_rows.child(row);
        }
        providers_section = providers_section.child(provider_rows);

        // Footer: gateway state + collapse — the shell's status bar. The
        // server pill anchors one end, the collapse button the other; the
        // collapsed rail stacks them vertically instead of dropping the
        // server state. All controls share one 24px hit area.
        let server_pending = self.server_pending;
        let server_tip: SharedString = t(lang, if running { "running" } else { "stopped" }).into();
        let server_indicator = {
            let theme = theme.clone();
            move || {
                if server_pending {
                    Spinner::new()
                        .with_size(Size::XSmall)
                        .color(theme.muted_foreground)
                        .into_any_element()
                } else {
                    div()
                        .size_1p5()
                        .rounded_full()
                        .bg(if running { theme.success } else { theme.danger })
                        .into_any_element()
                }
            }
        };
        // A stopped gateway means nothing works — the pill stays loud.
        let server_bg = if running {
            theme.success.opacity(0.10)
        } else {
            theme.danger.opacity(0.10)
        };
        let server_control = if collapsed {
            div()
                .id("rail-server")
                .size_6()
                .flex()
                .items_center()
                .justify_center()
                .rounded(theme.radius)
                .cursor_pointer()
                .bg(server_bg)
                .hover(|d| d.bg(theme.sidebar_accent))
                .tooltip(move |window, cx| Tooltip::new(server_tip.clone()).build(window, cx))
                .on_click(cx.listener(|this, _, _w, cx| this.toggle_server(cx)))
                .child(server_indicator())
        } else {
            div()
                .id("rail-server")
                .h_6()
                .px_2()
                .flex()
                .items_center()
                .gap_1p5()
                .rounded(theme.radius)
                .cursor_pointer()
                .bg(server_bg)
                .hover(|d| d.bg(theme.sidebar_accent))
                .on_click(cx.listener(|this, _, _w, cx| this.toggle_server(cx)))
                .child(server_indicator())
                .child(
                    Label::new(t(lang, if running { "running" } else { "stopped" }))
                        .text_xs()
                        .text_color(theme.muted_foreground),
                )
        };
        let collapse_button = Button::new("rail-collapse")
            .ghost()
            .small()
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
            }));
        let footer = if collapsed {
            v_flex()
                .items_center()
                .gap_1()
                .px_1()
                .py_1p5()
                .border_t_1()
                .border_color(theme.sidebar_border)
                .child(server_control)
                .child(collapse_button)
        } else {
            h_flex()
                .items_center()
                .gap_0p5()
                .px_1()
                .py_1p5()
                .border_t_1()
                .border_color(theme.sidebar_border)
                .child(server_control)
                .child(div().flex_1())
                .child(collapse_button)
        };

        // Width tween on collapse/expand — the transitions-dev "card
        // resize". The animator owns `w` for the duration; the resting state
        // lands on `sidebar_w`.
        let sidebar = v_flex()
            .w(sidebar_w)
            .flex_none()
            .h_full()
            .min_h_0()
            .overflow_hidden()
            .with_animation(
                SharedString::from(format!("rail-w-{collapsed}")),
                Animation::new(Duration::from_millis(180)).with_easing(ease_out_quint()),
                move |el, d| {
                    let (from, to) = if collapsed {
                        (SIDEBAR_W.0, SIDEBAR_W_COLLAPSED.0)
                    } else {
                        (SIDEBAR_W_COLLAPSED.0, SIDEBAR_W.0)
                    };
                    el.w(rems(from + (to - from) * d))
                },
            )
            // Only clear the native controls. The former brand header is gone,
            // so navigation can begin immediately below the traffic lights.
            .child(div().h(px(20.)).flex_none())
            .child(div().px_1().py_1p5().child(nav))
            .child(hairline(cx).mx_3().my_1())
            .child(
                // The scrollbar overlays the scroll container's parent —
                // mounting it on the scrolling element itself would put the
                // absolute layer inside the scrolled content.
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(
                        v_flex()
                            .id("provider-list")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.provider_scroll)
                            .px_1()
                            .child(providers_section),
                    )
                    .vertical_scrollbar(&self.provider_scroll),
            )
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
                    Page::Logs => self.render_logs(snapshot.as_ref(), window, cx),
                    Page::Settings => self.render_settings(snapshot.as_ref(), cx),
                },
                PAGE_MAX_W,
            )
        };

        // ---- shell: Electron geometry, rendered with opaque surfaces so
        // virtualized lists retain smooth scrolling. ----
        // The overlay mounts on the outermost wrapper (relative + size_full)
        // so its absolute positioning covers the whole window and nothing is
        // clipped by the content column's overflow-hidden.
        app_surface(&self.shell_focus)
            .child(
                h_flex()
                    .items_stretch()
                    .size_full()
                    // No fill — the native frosted backdrop shows through the
                    // sidebar chrome; the content card stays opaque.
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
                            .child({
                                // Pages with virtualized lists manage their own scroll;
                                // the wrapper must not also scroll (nested scroll fights).
                                let fills_height = matches!(self.page, Page::Logs | Page::Usage);
                                let page_scroll = self.page_scroll.clone();
                                // Fade + slight rise on every page switch — keyed by
                                // destination so the animation replays per navigation.
                                let page_key: SharedString = match &self.detail {
                                    Some(name) => format!("enter-detail-{name}").into(),
                                    None => format!("enter-page-{}", self.page as usize).into(),
                                };
                                // Scrollbar mounts on the scroll container's
                                // parent (relative + clip) — not inside the
                                // scrolled content.
                                if fills_height {
                                    div()
                                        .id("page-scroll")
                                        .flex_1()
                                        .min_h_0()
                                        .overflow_hidden()
                                        .child(enter(
                                            div()
                                                .mx_auto()
                                                .w_full()
                                                .max_w(max_w)
                                                .px_6()
                                                .pt_6()
                                                .pb_5()
                                                .h_full()
                                                .child(body),
                                            page_key,
                                        ))
                                        .into_any_element()
                                } else {
                                    div()
                                        .flex_1()
                                        .min_h_0()
                                        .relative()
                                        .overflow_hidden()
                                        .child(
                                            div()
                                                .id("page-scroll")
                                                .size_full()
                                                .overflow_y_scroll()
                                                .track_scroll(&page_scroll)
                                                .child(enter(
                                                    div()
                                                        .mx_auto()
                                                        .w_full()
                                                        .max_w(max_w)
                                                        .px_6()
                                                        .pt_6()
                                                        .pb_5()
                                                        .child(body),
                                                    page_key,
                                                )),
                                        )
                                        .vertical_scrollbar(&page_scroll)
                                        .into_any_element()
                                }
                            }),
                    ),
            )
            .children(overlay)
    }
}

#[cfg(test)]
mod tests;
