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
# ppcapture ships as a real bundle under ITS OWN identity,
# fm.partyparty.capture ("PartyParty Audio Capture"). A helper with its own
# sandbox profile needs a bundle identity for TCC - but it must NEVER borrow
# the app's bundle id: two registered apps sharing fm.partyparty.app is what
# made LaunchServices mint the "PartyParty 2" ghost and made TestFlight's
# launch validation refuse build 251 outright ("provisioning profile is
# invalid"). Its proper name, nothing else.
rm -rf "$HELPERS/ppcapture.app"
rm -f "$HELPERS/ppcapture"
mkdir -p "$HELPERS/ppcapture.app/Contents/MacOS"
cp "$ROOT/assets/ppcapture" "$HELPERS/ppcapture.app/Contents/MacOS/ppcapture"
cp "$ROOT/app/ppcapture-Info.plist" "$HELPERS/ppcapture.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $MARKETING_VERSION" "$HELPERS/ppcapture.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $CURRENT_PROJECT_VERSION" "$HELPERS/ppcapture.app/Contents/Info.plist"
chmod +x "$HELPERS/ppcapture.app/Contents/MacOS/ppcapture"
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
  # ppcapture INHERITS the app sandbox like every other helper. An own-profile
  # sandboxed child cannot be posix_spawn'd from a sandboxed parent: it dies in
  # _libsecinit_appsandbox with SIGTRAP before main() - six identical crashes,
  # one per Go Live, on TestFlight 251-253 (2026-08-05), with no TCC request
  # ever reaching tccd. Under inherit, the audio tap's TCC identity is the app
  # itself ("PartyParty", whose Info.plist carries the usage strings), and the
  # app's own entitlements (audio-input, network.client, shazamd mach-lookup)
  # flow to the child through the inherited profile. The bundle keeps its own
  # name and bundle id purely for LaunchServices hygiene - sharing the app's id
  # is what minted the "PartyParty 2" ghost.
  codesign "${sign_args[@]}" \
    --entitlements "$ROOT/app/PartyParty-app-store-child.entitlements" \
    "$HELPERS/ppcapture.app"
fi
