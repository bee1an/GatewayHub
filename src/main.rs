mod assets;
mod cli;
#[cfg(target_os = "macos")]
mod macos_blur;
mod root;
mod theme;

use std::sync::Arc;

use gateway_core::{ConfigStore, GatewayPaths, GatewayService};
use gpui_kit::component::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};
use gpui_kit::component::{ActiveTheme, Root, Theme};
use gpui_kit::*;
use schemars::JsonSchema;
use serde::Deserialize;
use tracing::info;
use tracing_appender::non_blocking::WorkerGuard;

use crate::root::AppRoot;

const APP_NAME: &str = "GatewayHub";

fn init_logger() -> Option<WorkerGuard> {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    if let Some(paths) = GatewayPaths::detect() {
        let logs = paths.logs_dir();
        if std::fs::create_dir_all(&logs).is_ok() {
            let writer = tracing_appender::rolling::daily(&logs, "gatewayhub-app.log");
            let (nb, guard) = tracing_appender::non_blocking(writer);
            tracing_subscriber::fmt()
                .with_env_filter(filter)
                .with_writer(nb)
                .with_ansi(false)
                .init();
            return Some(guard);
        }
    }
    tracing_subscriber::fmt().with_env_filter(filter).init();
    None
}

#[derive(Clone, Copy, PartialEq, Debug, Deserialize, JsonSchema, Action)]
pub enum MenuAction {
    Quit,
    Close,
    About,
}

/// Window shell: AppRoot plus nothing else for now. The app's dialogs are
/// AppRoot's own in-window overlay (rendered on its outermost div), so no
/// gpui-component layers are mounted here.
struct Shell {
    view: Entity<AppRoot>,
}

impl Render for Shell {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        div().size_full().child(self.view.clone())
    }
}

/// Opens (or reopens) the main window — macOS keeps the app resident when
/// the last window closes; clicking the dock icon rebuilds it via
/// `on_reopen`.
fn spawn_window(service: Arc<GatewayService>, cx: &mut App) {
    let open_task = cx.spawn(async move |cx| {
        let window_size = size(px(960.), px(700.));
        let bounds = cx.update(|cx| Bounds::centered(None, window_size, cx));
        info!(?bounds, "opening window");
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: None,
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(12.), px(14.))),
                }),
                // The content card paints opaque surfaces over virtualized
                // lists, so scroll performance is unaffected; the frost only
                // shows through the sidebar chrome outside the card.
                window_background: gpui_kit::WindowBackgroundAppearance::Blurred,
                // macOS shows the window only after the native material is
                // installed (see below), so no pre-frost frame is visible.
                show: cfg!(not(target_os = "macos")),
                window_min_size: Some(size(px(760.), px(520.))),
                app_id: Some("dev.gatewayhub.app".into()),
                ..Default::default()
            },
            |window, cx| {
                #[cfg(target_os = "macos")]
                {
                    if let Err(error) = crate::macos_blur::install_frosted_backdrop(window) {
                        tracing::warn!(%error, "native frost unavailable; using an opaque window");
                        window.set_background_appearance(
                            gpui_kit::WindowBackgroundAppearance::Opaque,
                        );
                    }
                    // The material tracks the window appearance — pin it to
                    // the resolved theme so in-app light/dark picks hold.
                    let dark = cx.theme().is_dark();
                    if let Err(error) = crate::macos_blur::set_window_appearance(window, dark) {
                        tracing::warn!(%error, "failed to pin window appearance");
                    }
                    window.on_next_frame(|window, _cx| window.activate_window());
                }
                let root_view = cx.new(|cx| AppRoot::new(service.clone(), window, cx));
                let shell = cx.new(|_| Shell { view: root_view });
                // Root paints theme.background over the whole window — clear
                // it so the frosted material shows outside the content card.
                cx.new(|cx| Root::new(shell, window, cx).bg(transparent_black()))
            },
        )?;
        Ok::<_, anyhow::Error>(())
    });
    cx.spawn(async move |cx| match open_task.await {
        Ok(()) => info!(
            "window opened; windows={}",
            cx.update(|cx| cx.windows().len())
        ),
        Err(e) => tracing::error!("open_window failed: {e:#}"),
    })
    .detach();
}

fn main() {
    if let Some(code) = cli::maybe_run() {
        std::process::exit(code);
    }
    let _log_guard = init_logger();
    info!(version = env!("CARGO_PKG_VERSION"), "gatewayhub launch");

    let service = GatewayService::detect().unwrap_or_else(|| {
        let tmp = std::env::temp_dir().join("gatewayhub-dev");
        GatewayService::new(ConfigStore::new(GatewayPaths::new(tmp)))
    });
    service.maybe_autostart();
    let service = Arc::new(service);

    let app = gpui_kit::application().with_assets(assets::Assets);
    {
        // Dock icon click with no open windows rebuilds the main window.
        let service = service.clone();
        app.on_reopen(move |cx| {
            cx.activate(true);
            if cx.windows().is_empty() {
                spawn_window(service.clone(), cx);
            }
        });
    }
    app.run(move |cx| {
        gpui_kit::init(cx);
        theme::restore_default_themes(cx);
        cx.activate(true);
        let mode = theme::theme_mode_for_appearance(cx.window_appearance());
        Theme::change(mode, None, cx);

        cx.on_action(|e: &MenuAction, cx: &mut App| match e {
            MenuAction::Quit => cx.quit(),
            MenuAction::Close => {
                // macOS stays resident after the last window closes; the
                // window is rebuilt via on_reopen.
                if let Some(window) = cx.active_window() {
                    let _ = window.update(cx, |_, window, _cx| window.remove_window());
                }
            }
            MenuAction::About => {}
        });
        cx.set_menus(vec![
            Menu {
                name: APP_NAME.into(),
                items: vec![
                    MenuItem::action(format!("About {APP_NAME}"), MenuAction::About),
                    MenuItem::separator(),
                    MenuItem::action("Close Window", MenuAction::Close),
                    MenuItem::action("Quit", MenuAction::Quit),
                ],
                disabled: false,
            },
            Menu {
                name: "Edit".into(),
                items: vec![
                    MenuItem::os_action("Undo", Undo, OsAction::Undo),
                    MenuItem::os_action("Redo", Redo, OsAction::Redo),
                    MenuItem::separator(),
                    MenuItem::os_action("Cut", Cut, OsAction::Cut),
                    MenuItem::os_action("Copy", Copy, OsAction::Copy),
                    MenuItem::os_action("Paste", Paste, OsAction::Paste),
                    MenuItem::separator(),
                    MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
                ],
                disabled: false,
            },
        ]);

        spawn_window(service.clone(), cx);
    });
}
