# Changelog

All notable changes to GatewayHub are documented in this file.

## 0.0.2 - 2026-05-22

Fixes auto-update event delivery so progress and status reach every open window.

- Fixed updater initializing twice on repeated calls and registering duplicate event listeners
- Fixed update events being captured by a single window so all live windows now receive update-available, download-progress, update-downloaded, and error notifications
