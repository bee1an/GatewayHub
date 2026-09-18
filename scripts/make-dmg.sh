#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ $# -ne 4 ]]; then
  echo "usage: $0 OUTPUT.dmg APP_BUNDLE ICON.icns STAGE_DIR" >&2
  exit 2
fi

OUT="$1"
APP="$2"
ICON="$3"
STAGE="$4"

command -v create-dmg >/dev/null || {
  echo "create-dmg is required; install it with: brew install create-dmg" >&2
  exit 1
}

rm -rf "$STAGE" "$OUT"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"

python3 scripts/gen-dmg-background.py --out target/dmg/background.tiff

# Layout pairs with gen-dmg-background.py: 540x380 window, 100px icons,
# GatewayHub.app at (140,195), Applications drop-link at (400,195).
create-dmg \
  --volname "GatewayHub" \
  --volicon "$ICON" \
  --background target/dmg/background.tiff \
  --window-pos 200 120 \
  --window-size 540 380 \
  --icon-size 100 \
  --icon "GatewayHub.app" 140 195 \
  --hide-extension "GatewayHub.app" \
  --app-drop-link 400 195 \
  --no-internet-enable \
  --format ULFO \
  --overwrite \
  "$OUT" "$STAGE"

echo "dmg written to $OUT"
