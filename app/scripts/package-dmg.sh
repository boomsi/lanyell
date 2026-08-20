#!/bin/bash
# Package lanyell.app into a dmg with the standard drag-to-install layout:
# the app on the left and an /Applications symlink on the right.
# Usage: package-dmg.sh <path-to-lanyell.app> <output.dmg>

set -euo pipefail

APP_PATH="$1"
OUT_DMG="$2"

if [ -z "$APP_PATH" ] || [ -z "$OUT_DMG" ]; then
  echo "usage: $0 <lanyell.app> <output.dmg>" >&2
  exit 1
fi
if [ ! -d "$APP_PATH" ]; then
  echo "app bundle not found: $APP_PATH" >&2
  exit 1
fi

STAGING=$(mktemp -d /tmp/lanyell-dmg.XXXXXX)
VOLNAME="lanyell"
trap 'rm -rf "$STAGING"' EXIT

# app + the Applications symlink that makes drag-to-install obvious
cp -R "$APP_PATH" "$STAGING/lanyell.app"
ln -s /Applications "$STAGING/Applications"

# create the dmg from the staging folder (UDZO = zlib compressed)
hdiutil create \
  -volname "$VOLNAME" \
  -srcfolder "$STAGING" \
  -ov \
  -format UDZO \
  "$OUT_DMG"

echo "created $OUT_DMG"
