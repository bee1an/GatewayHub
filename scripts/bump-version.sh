#!/bin/bash
set -euo pipefail

KIND=${1:?usage: bump-version.sh <patch|minor|major>}
cd "$(dirname "$0")/.."

CURRENT=$(sed -n 's/^version = "\([^\"]*\)"/\1/p' Cargo.toml | head -1)
[ -n "$CURRENT" ] || { echo "failed to read version from Cargo.toml" >&2; exit 1; }
IFS=. read -r MAJ MIN PAT <<<"$CURRENT"

case "$KIND" in
  patch) PAT=$((PAT + 1)) ;;
  minor) MIN=$((MIN + 1)); PAT=0 ;;
  major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
  *) echo "unknown bump kind: $KIND (want patch|minor|major)" >&2; exit 1 ;;
esac
NEXT="$MAJ.$MIN.$PAT"

# Only the workspace package owns this version line; the root package uses
# version.workspace = true and must remain untouched.
CURRENT="$CURRENT" NEXT="$NEXT" perl -pi -e \
  's|^version = "\Q$ENV{CURRENT}\E"|version = "$ENV{NEXT}"| && ++$done unless $done' Cargo.toml
grep -q "^version = \"$NEXT\"" Cargo.toml || {
  echo "failed to bump Cargo.toml" >&2
  exit 1
}

cargo update --workspace --offline --quiet
echo "version: $CURRENT -> $NEXT"
