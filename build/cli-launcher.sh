#!/usr/bin/env bash
# GatewayHub CLI launcher
# Uses Electron's helper binary in ELECTRON_RUN_AS_NODE mode to avoid requiring system Node.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"

# Try to find the Electron helper for Node-mode execution
if [[ "$(uname)" == "Darwin" ]]; then
  APP_DIR="$(cd "$DIR/../.." && pwd)"
  HELPER="$APP_DIR/Contents/Frameworks/GatewayHub Helper (Renderer).app/Contents/MacOS/GatewayHub Helper (Renderer)"
  if [[ -x "$HELPER" ]]; then
    exec env ELECTRON_RUN_AS_NODE=1 "$HELPER" "$DIR/gatewayhub.js" "$@"
  fi
  # Fallback: main Electron binary
  ELECTRON="$APP_DIR/Contents/MacOS/GatewayHub"
  if [[ -x "$ELECTRON" ]]; then
    exec env ELECTRON_RUN_AS_NODE=1 "$ELECTRON" "$DIR/gatewayhub.js" "$@"
  fi
fi

# Linux / generic fallback
if command -v node &>/dev/null; then
  exec node "$DIR/gatewayhub.js" "$@"
fi

echo "error: No suitable Node.js runtime found. Install Node.js or run from within the GatewayHub app bundle." >&2
exit 1
