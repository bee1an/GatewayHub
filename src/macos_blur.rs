//! A system-owned frosted window material underneath the GPUI drawing view.
//!
//! GPUI's `BlurredView` strips native material layers to obtain a colorless
//! blur. Keep AppKit's standard material intact instead: its tint and blur
//! must adapt together to OS appearance and accessibility settings.
//! Ported from Heimdall's `helpers/macos_blur.rs`.

use anyhow::{Context as _, Result, ensure};
use gpui_kit::{Window, WindowBackgroundAppearance};
use objc2::{MainThreadMarker, MainThreadOnly};
use objc2_app_kit::{
    NSAppearance, NSAppearanceCustomization, NSAppearanceNameAqua, NSAppearanceNameDarkAqua,
    NSAutoresizingMaskOptions, NSUserInterfaceItemIdentification, NSView,
    NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState, NSVisualEffectView,
    NSWindowOrderingMode,
};
use objc2_foundation::ns_string;
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

/// Installs once per native window; AppKit owns the view's lifetime and resize.
/// Call on the main thread before showing the first frame. On failure, the
/// caller must choose an opaque background rather than leave clear glass.
pub fn install_frosted_backdrop(window: &Window) -> Result<()> {
    let main_thread =
        MainThreadMarker::new().context("frosted backdrop requires the main thread")?;
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| anyhow::anyhow!("missing native window handle: {error}"))?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        anyhow::bail!("frosted backdrop requires an AppKit window");
    };
    // SAFETY: HasWindowHandle borrows GPUI's live NSView. Access stays on the
    // main thread, within that borrow, and the pointer is never retained.
    let native_view = unsafe { &*handle.ns_view.as_ptr().cast::<NSView>() };
    let content = native_view
        .window()
        .and_then(|window| window.contentView())
        .context("GPUI view is not attached to a native content view")?;
    ensure!(
        content.subviews().iter().any(|view| &*view == native_view),
        "unexpected GPUI view hierarchy"
    );

    let identifier = ns_string!("gatewayhub.frosted-backdrop");
    for child in content.subviews() {
        if child.identifier().as_deref() == Some(identifier) {
            ensure!(
                child.downcast_ref::<NSVisualEffectView>().is_some(),
                "backdrop identifier is already in use"
            );
            return Ok(());
        }
    }

    let backdrop =
        NSVisualEffectView::initWithFrame(NSVisualEffectView::alloc(main_thread), content.bounds());
    backdrop.setIdentifier(Some(identifier));
    backdrop.setMaterial(NSVisualEffectMaterial::UnderWindowBackground);
    backdrop.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    // Keep the background frosted even when the user activates another app.
    // AppKit still applies system Reduce Transparency accessibility behavior.
    backdrop.setState(NSVisualEffectState::Active);
    backdrop.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );

    // Remove GPUI's layer-stripping blur view before inserting the native one.
    // Two behind-window materials can otherwise compete for the same backdrop.
    window.set_background_appearance(WindowBackgroundAppearance::Transparent);
    content.addSubview_positioned_relativeTo(
        &backdrop,
        NSWindowOrderingMode::Below,
        Some(native_view),
    );
    tracing::debug!(
        material = ?backdrop.material(),
        blending = ?backdrop.blendingMode(),
        frame = ?backdrop.frame(),
        "installed native frosted backdrop"
    );
    Ok(())
}

/// Pins the window's effective appearance to the app's theme mode. Without
/// this the frosted material (and traffic-light chrome) tracks the *system*
/// appearance, so an in-app light/dark switch leaves the material stale.
/// Pinning keeps the material consistent with the displayed theme; the app
/// has no runtime system-appearance tracking, so both stay put together.
pub fn set_window_appearance(window: &Window, dark: bool) -> Result<()> {
    let handle = HasWindowHandle::window_handle(window)
        .map_err(|error| anyhow::anyhow!("missing native window handle: {error}"))?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        anyhow::bail!("appearance requires an AppKit window");
    };
    // SAFETY: same borrow discipline as install_frosted_backdrop — main
    // thread, within the handle borrow, pointer never retained.
    let native_view = unsafe { &*handle.ns_view.as_ptr().cast::<NSView>() };
    let ns_window = native_view
        .window()
        .context("GPUI view is not attached to a native window")?;
    // SAFETY: AppKit's appearance-name externs are immutable, process-wide
    // constants — reading them on the main thread cannot alias or race.
    let name = unsafe {
        if dark {
            NSAppearanceNameDarkAqua
        } else {
            NSAppearanceNameAqua
        }
    };
    ns_window.setAppearance(NSAppearance::appearanceNamed(name).as_deref());
    Ok(())
}
