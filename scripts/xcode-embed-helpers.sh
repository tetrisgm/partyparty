#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$SRCROOT/.." && pwd)"
HELPERS="$TARGET_BUILD_DIR/$CONTENTS_FOLDER_PATH/Helpers"
GO="${GO:-go}"

mkdir -p "$HELPERS"

# A Debug build is a desk build, not a release. Stamping it with the commit it
# was built from means "what version is running on my Mac" always has one
# honest answer - a dev install once wore a TestFlight build's exact number and
# the owner had no way to tell them apart. Release keeps the bare marketing
# version the store lane verifies.
VERSION="$MARKETING_VERSION"
if [ "${CONFIGURATION:-}" = "Debug" ]; then
  short="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  dirty=""
  [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] || dirty="+dirty"
  VERSION="$MARKETING_VERSION-dev.$short$dirty"
fi

"$GO" build -tags bundle \
  -ldflags "-X main.appVersion=$VERSION" \
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
  for helper in ffmpeg mediamtx partyparty-server; do
    codesign "${sign_args[@]}" \
      --entitlements "$ROOT/app/PartyParty-app-store-child.entitlements" \
      "$HELPERS/$helper"
  done
  # ppcapture carries its own sandbox profile: ShazamKit needs the
  # com.apple.shazamd mach-lookup exception plus network.client, which the
  # inherit-only child file cannot express. The product rename silently
  # re-signed it with the child file and recognition failed with error 202 on
  # every attempt from 2026-07-31 until 2026-08-05; verify-app-store.sh now
  # asserts the exception so this cannot regress quietly again.
  codesign "${sign_args[@]}" \
    --entitlements "$ROOT/app/PartyParty-app-store-capture.entitlements" \
    "$HELPERS/ppcapture"
fi
