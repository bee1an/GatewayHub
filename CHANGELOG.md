# Changelog

All notable changes to GatewayHub are documented in this file.

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
