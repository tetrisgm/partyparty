#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$SRCROOT/.." && pwd)"
HELPERS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
GO="${GO:-go}"

mkdir -p "$HELPERS"

"$GO" build -tags bundle \
  -ldflags "-X main.appVersion=$MARKETING_VERSION" \
  -o "$HELPERS/partyparty-server" "$ROOT"

for helper in ffmpeg mediamtx; do
  rm -f "$HELPERS/$helper"
  cp "$ROOT/assets/$helper" "$HELPERS/$helper"
done
rm -rf "$HELPERS/ppcapture.app"
rm -f "$HELPERS/ppcapture"
cp "$ROOT/assets/ppcapture" "$HELPERS/ppcapture"
chmod +x "$HELPERS/"*

if [ "${CODE_SIGNING_ALLOWED:-NO}" = "YES" ]; then
  identity="${EXPANDED_CODE_SIGN_IDENTITY:-}"
  [ -n "$identity" ] || {
    echo "Xcode did not provide a code-signing identity for bundled helpers." >&2
    exit 1
  }
  sign_args=(--force --options runtime --sign "$identity")
  [ -n "${PP_SIGN_KEYCHAIN:-}" ] && sign_args+=(--keychain "$PP_SIGN_KEYCHAIN")
  for helper in ffmpeg mediamtx partyparty-server ppcapture; do
    codesign "${sign_args[@]}" \
      --entitlements "$ROOT/app/partyparty-app-store-child.entitlements" \
      "$HELPERS/$helper"
  done
fi
