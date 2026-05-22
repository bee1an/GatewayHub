# Changelog

All notable changes to GatewayHub are documented in this file.

## 0.0.6-beta.2 - 2026-05-23

Fixed update modal links navigating the entire window when clicked.

- Fixed clicking links inside release notes loading the URL into the app window — links now open in the system browser as expected

## 0.0.6-beta.1 - 2026-05-22

Fixed auto-update not actually replacing the app on macOS, plus icon and styling fixes in the update modal.

- Added ad-hoc code signing for macOS (`identity: '-'`) so `quitAndInstall` can replace the app — the previous unsigned build was rejected by Squirrel.Mac during the update step
- Fixed missing icons in update modal (`i-ph:xxx` corrected to `i-ph-xxx` to match the resolver used elsewhere)
- Fixed transparent backgrounds rendering as solid green by replacing `bg-emerald/10` and `bg-emerald/15` with `color-mix` expressions
- Removed auto-generated "Full Changelog" lines from existing GitHub Releases

## 0.0.5 - 2026-05-22

Fixed version number not displaying in packaged builds.

- Fixed app version not showing in settings and update modal by fetching version from main process via IPC
- Fixed tsgo type-check error for `@radix-ui/react-tabs` module resolution

## 0.0.4 - 2026-05-22

Fixed auto-update not applying after download, and release notes now render properly.

- Fixed update not installing on restart by enabling `autoInstallOnAppQuit` and forcing quit-and-install with correct parameters
- Fixed release notes displaying raw HTML tags in the update modal

## 0.0.3 - 2026-05-22

Improved update modal UX, added about section to settings, and cleaned up Kiro converter internals.

- Redesigned update modal with version comparison card, release notes display, and GitHub Releases link
- Added about section to settings page showing current version and GitHub repository link
- Allowed closing the update modal during download (background download continues)
- Extracted empty content placeholders to constants in Kiro message converter

## 0.0.2 - 2026-05-22

Fixes auto-update event delivery so progress and status reach every open window.

- Fixed updater initializing twice on repeated calls and registering duplicate event listeners
- Fixed update events being captured by a single window so all live windows now receive update-available, download-progress, update-downloaded, and error notifications
