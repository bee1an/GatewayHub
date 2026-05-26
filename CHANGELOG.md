# Changelog

All notable changes to GatewayHub are documented in this file.

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
