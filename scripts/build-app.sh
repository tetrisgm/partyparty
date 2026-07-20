#!/usr/bin/env bash
# Assemble build/partyparty.app: the Swift menu-bar shell (Contents/MacOS) + the
# Go server and native helpers (Contents/Helpers) + Sparkle.framework
# (Contents/Frameworks), code-signed inside-out.
#
#   make app                 -> ad-hoc signed (-s -), for LOCAL testing
#   PP_SIGN_ID="Developer ID Application: ... (TEAMID)" ./scripts/build-app.sh
#                            -> Developer ID + hardened runtime + timestamp (notarization, CI)
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
GO="${GO:-go}"
APP="$ROOT/build/partyparty.app"
ENT="$ROOT/app/partyparty.entitlements"

# Stable signing keeps the TCC (Screen Recording) grant across rebuilds. Prefer an
# explicit PP_SIGN_ID (CI), else auto-detect a local Developer ID Application
# identity, else fall back to ad-hoc (which re-prompts for permission each build).
EXPLICIT_ID="${PP_SIGN_ID:-}"
SIGN_ID="$EXPLICIT_ID"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -p codesigning -v 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  [ -z "$SIGN_ID" ] && SIGN_ID="-"
fi

echo ">> Go server (-tags bundle)"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/app/Info.plist" 2>/dev/null || echo dev)"
"$GO" build -tags bundle -ldflags "-X main.appVersion=$APP_VERSION" -o "$ROOT/build/partyparty-server" "$ROOT"
"$GO" build -o "$ROOT/build/pp-port80" "$ROOT/cmd/pp-port80"
"$GO" build -o "$ROOT/build/pp-port443" "$ROOT/cmd/pp-port443"

echo ">> Swift menu-bar app (release)"
swift build -c release --package-path "$ROOT/app"
BIN="$(swift build -c release --package-path "$ROOT/app" --show-bin-path)"

echo ">> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources" "$APP/Contents/Frameworks" "$APP/Contents/Library/LaunchDaemons"
cp "$BIN/partyparty"               "$APP/Contents/MacOS/partyparty"
cp "$ROOT/build/partyparty-server" "$APP/Contents/Helpers/partyparty-server"
cp "$ROOT/build/pp-port80"         "$APP/Contents/Helpers/pp-port80"
cp "$ROOT/build/pp-port443"        "$APP/Contents/Helpers/pp-port443"
cp "$ROOT/assets/ffmpeg"           "$APP/Contents/Helpers/ffmpeg"
cp "$ROOT/assets/mediamtx"         "$APP/Contents/Helpers/mediamtx"
cp "$ROOT/assets/ppcapture"        "$APP/Contents/Helpers/ppcapture"
cp "$ROOT/app/Info.plist"          "$APP/Contents/Info.plist"
cp "$ROOT/app/AppIcon.icns"        "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/app/net.ramine.partyparty.port80.plist" "$APP/Contents/Library/LaunchDaemons/net.ramine.partyparty.port80.plist"
cp "$ROOT/app/net.ramine.partyparty.port443.plist" "$APP/Contents/Library/LaunchDaemons/net.ramine.partyparty.port443.plist"

# Sparkle framework (auto-update) — embed + make it discoverable via rpath.
if [ -d "$BIN/Sparkle.framework" ]; then
  cp -R "$BIN/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/partyparty" 2>/dev/null || true
fi
chmod +x "$APP/Contents/Helpers/"* "$APP/Contents/MacOS/partyparty"

codesign_one() { # $1=path  $2=entitlements (optional)
  local path="$1" ent="${2:-}"
  local args=(--force)
  if [ "$SIGN_ID" = "-" ]; then
    args+=(--sign -)
  else
    # Hardened runtime + secure timestamp — both required for notarization.
    args+=(--options runtime --timestamp --sign "$SIGN_ID")
  fi
  [ -n "$ent" ] && args+=(--entitlements "$ent")
  codesign "${args[@]}" "$path"
}

echo ">> codesigning inside-out ($SIGN_ID)"
SPK="$APP/Contents/Frameworks/Sparkle.framework"
if [ -d "$SPK" ]; then
  if [ "$SIGN_ID" = "-" ]; then
    codesign --force --deep --sign - "$SPK"     # ad-hoc: deep is fine for local dev
  else
    # Developer ID: Sparkle's nested helpers first, then the framework.
    V="$SPK/Versions/B"
    for n in "XPCServices/Installer.xpc" "XPCServices/Downloader.xpc" "Autoupdate" "Updater.app"; do
      [ -e "$V/$n" ] && codesign_one "$V/$n"
    done
    codesign_one "$SPK"
  fi
fi
# ppcapture creates the Core Audio tap, so IT needs the audio-input
# entitlement (hardened runtime denies audio otherwise). The rest don't.
for b in mediamtx ffmpeg partyparty-server pp-port80 pp-port443; do
  codesign_one "$APP/Contents/Helpers/$b"
done
codesign_one "$APP/Contents/Helpers/ppcapture" "$ENT"
codesign_one "$APP/Contents/MacOS/partyparty" "$ENT"
codesign_one "$APP" "$ENT"

echo ">> verify"
codesign --verify --strict --verbose=2 "$APP"
echo ">> built $APP"
