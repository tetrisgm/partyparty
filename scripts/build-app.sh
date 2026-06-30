#!/usr/bin/env bash
# Assemble build/partyparty.app: the Swift menu-bar shell (Contents/MacOS) + the
# Go server and native helpers (Contents/Helpers), code-signed inside-out.
#
#   make app                 -> ad-hoc signed (-s -), for LOCAL testing
#   PP_SIGN_ID="Developer ID Application: ... (TEAMID)" ./scripts/build-app.sh
#                            -> Developer ID + hardened runtime + timestamp (for notarization, CI)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
GO="${GO:-go}"
SIGN_ID="${PP_SIGN_ID:--}"          # default ad-hoc
APP="$ROOT/build/partyparty.app"
ENT="$ROOT/app/partyparty.entitlements"

echo ">> Go server (-tags bundle)"
"$GO" build -tags bundle -o "$ROOT/build/partyparty-server" "$ROOT"

echo ">> Swift menu-bar app (release)"
swift build -c release --package-path "$ROOT/app"
SWIFT_BIN="$ROOT/app/.build/release/partyparty"

echo ">> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp "$SWIFT_BIN"                  "$APP/Contents/MacOS/partyparty"
cp "$ROOT/build/partyparty-server" "$APP/Contents/Helpers/partyparty-server"
cp "$ROOT/assets/ffmpeg"        "$APP/Contents/Helpers/ffmpeg"
cp "$ROOT/assets/mediamtx"      "$APP/Contents/Helpers/mediamtx"
cp "$ROOT/assets/ppcapture"     "$APP/Contents/Helpers/ppcapture"
cp "$ROOT/app/Info.plist"       "$APP/Contents/Info.plist"
[ -f "$ROOT/app/icon.icns" ] && cp "$ROOT/app/icon.icns" "$APP/Contents/Resources/icon.icns"
chmod +x "$APP/Contents/Helpers/"* "$APP/Contents/MacOS/partyparty"

codesign_one() { # $1=path  $2=entitlements (optional)
  local path="$1" ent="${2:-}"
  local args=(--force)
  if [ "$SIGN_ID" = "-" ]; then
    args+=(--sign -)                                   # ad-hoc, local only
  else
    args+=(--timestamp --options runtime --sign "$SIGN_ID")
  fi
  [ -n "$ent" ] && args+=(--entitlements "$ent")
  codesign "${args[@]}" "$path"
}

echo ">> codesigning inside-out ($SIGN_ID)"
for b in ppcapture mediamtx ffmpeg partyparty-server; do
  codesign_one "$APP/Contents/Helpers/$b"
done
codesign_one "$APP/Contents/MacOS/partyparty" "$ENT"
codesign_one "$APP" "$ENT"

echo ">> verify"
codesign --verify --strict --verbose=2 "$APP"
echo ">> built $APP"
