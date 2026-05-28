# Changelog

All notable changes to GatewayHub are documented in this file.

## 0.1.5 - 2026-05-28

Added port configuration support and fixed CI compatibility.

- Changed default listen port from 8000 to 9741 to avoid conflicts with common development servers
- Added port configuration in Settings UI — changes take effect immediately with automatic server restart
- Added `setPort` IPC/service method with validation (1–65535)
- CLI `--port` default updated to 9741
- Added streaming read timeout support: `streamingReadTimeoutSeconds` parameter for per-chunk idle timeout after the first token arrives
- Fixed log viewer expanding multiple rows simultaneously when logs shared the same requestId
- Fixed log viewer layout corruption when new logs arrived while a row was expanded
- Fixed CI: upgraded Node.js from 20 to 22 in release workflow for undici 8.x compatibility

## 0.1.4 - 2026-05-27

Hardened the gateway server against network-layer attacks and added full tool-use support for the Codex provider.

- Added HTTP security hardening: timing-safe API key comparison, DNS rebinding protection via Host header validation, request body size limits (8 MiB), and slowloris mitigation with explicit socket timeouts
- Added centralized secret redaction for logs and IPC — tokens, JWTs, and OAuth codes are automatically stripped before anything hits disk or crosses process boundaries
- Added full tool-use (function calling) support for Codex: tool definitions, tool_choice, function_call/function_call_output round-trips are now correctly converted between Chat Completions and Responses API formats
- Improved Kiro auth with proxy support (undici ProxyAgent), atomic credential writes, and deduplicated concurrent token refresh
- Added model mapping edit-in-place dialog (previously only add/delete were supported)
- Added React ErrorBoundary so renderer crashes show a recovery UI instead of a blank window
- Improved graceful shutdown: idle connections are closed immediately, long-lived streaming connections are force-closed after a 5s timeout

## 0.1.3 - 2026-05-26

Stabilized the macOS Homebrew in-app upgrade flow. The upgrade now opens a progress window that streams `brew upgrade --cask gatewayhub` output live, then lets the user choose when to relaunch.

- Run `brew upgrade --cask gatewayhub` directly in the main process and stream stdout/stderr into the progress window in real time
- Added a `success` phase with "Restart now" / "Later" so the app no longer auto-quits halfway through the install; "Restart now" uses Electron's `app.relaunch() + app.quit()` so the new bundle actually replaces the running process
- Buffer progress events in main until the renderer signals it has registered listeners (`upgrade:ready`), so the install/log lines never get dropped on slow window creation
- Refresh the local Homebrew tap (`brew update --quiet` before `brew fetch`) so the in-app upgrade no longer reports "already installed" against a stale cask cache
- Fixed the upgrade window's terminal-output container so it has a fixed height and scrolls when log output overflows
- Added a persistent updater log at `~/Library/Logs/GatewayHub/updater.log` covering feed selection, brew detection, fetch output, phase transitions, IPC traffic, and quit timing
- Added a local-feed override (`dev-update-url.txt` in userData) that points electron-updater at a generic provider URL for offline testing

## 0.1.3-beta.11 - 2026-05-26

Test build to validate the `app.relaunch()` fix from 0.1.3-beta.10.

- No code changes

## 0.1.3-beta.10 - 2026-05-26

Fixed "Restart now" not actually relaunching after a successful upgrade.

- The previous build used `spawn('open', '/Applications/GatewayHub.app')` followed by `app.quit()`. Because the current GatewayHub instance was still running, `open` only foregrounded the existing process instead of launching a new one; the subsequent `app.quit()` then killed the only instance, leaving the user with no app at all
- Switched to Electron's `app.relaunch() + app.quit()`. `relaunch` registers an atExit hook that spawns `process.execPath` after the current process actually exits, and brew has already replaced the binary at that path with the new version

## 0.1.3-beta.9 - 2026-05-26

Test build to validate the in-app brew upgrade flow against a previously installed 0.1.3-beta.7+ build.

- No code changes

## 0.1.3-beta.8 - 2026-05-26

Test build to validate the new in-app upgrade UX shipped in 0.1.3-beta.7.

- No code changes; published so users on 0.1.3-beta.7 can trigger an in-app upgrade and verify the live brew log streaming and the manual "Restart now / Later" choice on the success phase

## 0.1.3-beta.7 - 2026-05-26

Reworked the brew upgrade flow so the app stays open through the whole install and the user decides when to restart, instead of the app auto-quitting halfway.

- Run `brew upgrade --cask gatewayhub` directly in the main process and stream stdout/stderr into the progress window in real time
- Add a `success` phase that shows a green confirmation card with two buttons: "Restart now" relaunches into the new bundle via `open /Applications/GatewayHub.app`; "Later" closes the window and the new version takes effect on the next manual restart
- Drop the detached shell, the `[gh-marker]` protocol, the `tail -F` log streamer, and the early `app.quit()` — they were workarounds for the older "quit then upgrade" model and are no longer needed
- Update brew hint and progress copy to reflect the new "install, then restart at your convenience" UX

## 0.1.3-beta.6 - 2026-05-26

Use an absolute path when relaunching after a brew upgrade so LaunchServices can't pick a stale dev build with the same bundle id.

- Replace `open -a GatewayHub` in the detached installer with `open /Applications/GatewayHub.app`; if a developer leaves a `dist/mac-arm64/GatewayHub.app` from `pnpm run build:mac` around, macOS would otherwise sometimes relaunch that older copy after upgrade

## 0.1.3-beta.5 - 2026-05-26

Test build to validate the in-app realtime upgrade log streaming added in 0.1.3-beta.4.

- No code changes; published so users on 0.1.3-beta.4 can trigger the in-app upgrade flow and verify the progress window now shows live brew upgrade output (Updating Homebrew, Backing App, Removing App, Moving App, Purging files)

## 0.1.3-beta.4 - 2026-05-26

Streamed the actual `brew upgrade` output into the in-app progress window so users can see backing up, removing, and replacing the application bundle in real time.

- Tail `brew-upgrade.log` from the main process and forward each line to the progress window during the install phase
- Use a `[gh-marker]` protocol so the script signals "ready-to-replace" / "success" / "failed: ..." back to main; the app only quits once brew is about to touch the .app bundle
- Truncate `brew-upgrade.log` at the start of each upgrade run so tailing only shows the current attempt
- `upgrade:cancel` also kills the tail child to avoid leaks

## 0.1.3-beta.3 - 2026-05-26

Test build to validate the brew upgrade flow end-to-end against a previously installed beta.

- No code changes; published so users on 0.1.3-beta.2 can confirm the in-app brew update + fetch path lands them on a newer build instead of "already installed"

## 0.1.3-beta.2 - 2026-05-26

Fixed the brew upgrade reporting "already installed" because the local tap cache was never refreshed during the in-app flow.

- Run `brew update --quiet` before `brew fetch` so the tap reflects the latest cask version (the previous `HOMEBREW_NO_AUTO_UPDATE=1` env froze the tap cache and made every upgrade a no-op)
- Detached installer now records before/after versions, runs `brew update` again, and surfaces a notification if `brew upgrade` claims "already installed"
- Both update and fetch steps stream their stdout/stderr into the in-app upgrade window, so users see why an upgrade was skipped

## 0.1.3-beta.1 - 2026-05-26

Fixed the macOS Homebrew upgrade flow that closed the app without showing a progress window, and added structured updater logs for diagnostics.

- Fixed brew upgrade race where the progress window was destroyed before it could render: main now buffers progress events until the renderer signals it has registered listeners (`upgrade:ready`)
- Decoupled `app.quit` from the install timer: the app waits for the renderer to acknowledge it has painted the install phase (`upgrade:installRendered`, double-`requestAnimationFrame`) before quitting, with a dev/prod-aware timeout fallback
- Raised the minimum visible time for the upgrade window from 800 ms to 1500 ms and re-anchored it to the renderer-ready timestamp so brew cache hits no longer skip the UI
- Added a persistent updater log at `~/Library/Logs/GatewayHub/updater.log` covering feed selection, brew detection, fetch stdout/stderr, phase transitions, IPC traffic, and quit timing
- Added a local-feed override: dropping `dev-update-url.txt` into the userData directory points electron-updater at a generic provider URL for offline testing

## 0.1.2 - 2026-05-26

Added inline model-mapping editing, dynamic Codex model fetching, and improved error feedback with animations.

- Added inline cell editing for model mappings with delete confirmation dialog
- Fetched Codex models dynamically from the ChatGPT backend instead of using a hardcoded list
- Added friendly error toast when gateway server fails to start or stop, with i18n support
- Displayed account email instead of account ID in the logs page for readability
- Added friendly error message when the gateway server fails to bind its listen port
- Added number pop-in, card hover lift, and icon swap animations for smoother UI transitions

## 0.1.1 - 2026-05-25

Reworked the Homebrew auto-update flow and added Codex rate-limit visibility plus broader auth-import support.

- Replaced the Terminal-based brew upgrade flow with an in-app progress window that streams brew output live; the app downloads the new version, then quits and relaunches automatically
- Added macOS notification + Releases page fallback when the upgrade fails, with the inline error visible in the progress window; brew upgrade logs land at `~/.config/gatewayhub/Logs/brew-upgrade.log`
- Added Codex 5h primary / weekly secondary rate-limit bars to the account expanded view, with peak percentage shown in the row header
- Accepted codexdock-exported `accounts[].credentials` JSON when adding Codex accounts (in addition to the standard `~/.codex/auth.json` format), with friendlier error messages for malformed input
- Synced the global VPN proxy setting from Kiro to Codex at runtime, so Codex respects the proxy configured in Settings
- Used Codex account email as the primary label when available
- Filtered Usage tab by gateway provider so per-gateway views only show their own usage

## 0.1.0 - 2026-05-24

Added Codex (ChatGPT OAuth) as a new provider with full account-pool, login, and usage support.

- Added new Codex provider with PKCE browser/device login flows, token refresh, and account-pool failover
- Added Codex SSE transformers that translate upstream events into both OpenAI and Anthropic response formats
- Added "Add Codex account" dialog with browser, device, JSON file picker, and `~/.codex/auth.json` auto-discover tabs
- Added gpt-5 family pricing entries (codex / nano / pro / 5.1 variants) so usage tracking works out of the box
- Improved gateway detail page so tabs, cards, and usage stay visible even before any account is added
- Migrated config v2 → v3, auto-enabling codex on existing installs

## 0.0.6 - 2026-05-24

Added per-gateway usage tracking with credit-based pricing for Kiro.

- Added per-gateway Usage sub-tab and removed the global /usage route
- Added credit-based pricing alongside token-based pricing; Kiro now reports real upstream credits ($0.02/credit) instead of estimated tokens
- Improved Kiro per-account breakdown chart to use account email labels
- Persisted usage to `~/.config/gatewayhub/usage.json` with daily aggregation
- Hidden token count and cache-hit-rate UI in credit mode where the estimates were misleading

## 0.0.6-beta.3 - 2026-05-23

Switched macOS auto-update to a Homebrew-based flow and stopped CI from auto-injecting Full Changelog into release notes.

- Replaced electron-updater install logic with Homebrew upgrade — Squirrel.Mac requires a real signing identity to replace the app, which is impossible without an Apple Developer certificate
- Detects whether the app is installed via `brew install --cask gatewayhub`; if so, the update modal triggers `brew upgrade --cask gatewayhub` in Terminal and restarts automatically
- Falls back to opening the GitHub Release page when the app was installed manually
- Removed download progress, restart-now flow, and related IPC events from the update modal — they were never reliably working on unsigned macOS builds
- Disabled `generate_release_notes` in the release workflow so the changelog body matches `CHANGELOG.md` exactly without GitHub-appended Full Changelog links
- Added `bee1an/homebrew-gatewayhub` tap and CI sync job that updates the cask after each stable release

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
