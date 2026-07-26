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
APP_STORE="${PARTYPARTY_APP_STORE:-0}"
if [ "$APP_STORE" = "1" ]; then
  # SwiftPM rewrites/removes Package.resolved when the Store manifest excludes
  # Sparkle. Preserve the direct lane's pinned dependency across this build.
  RESOLVED="$ROOT/app/Package.resolved"
  if [ -f "$RESOLVED" ]; then
    RESOLVED_BACKUP="$(mktemp)"
    cp "$RESOLVED" "$RESOLVED_BACKUP"
    trap 'cp "$RESOLVED_BACKUP" "$RESOLVED"; rm -f "$RESOLVED_BACKUP"' EXIT
  fi
  APP="$ROOT/build/partyparty-app-store.app"
  ENT="$ROOT/app/partyparty-app-store.entitlements"
  CHILD_ENT="$ROOT/app/partyparty-app-store-child.entitlements"
  SWIFT_ARGS=(-c release --package-path "$ROOT/app" --scratch-path "$ROOT/app/.build-app-store" -Xswiftc -DAPP_STORE)
else
  APP="$ROOT/build/partyparty.app"
  ENT="$ROOT/app/partyparty.entitlements"
  CHILD_ENT=""
  SWIFT_ARGS=(-c release --package-path "$ROOT/app")
fi

# Stable signing keeps the audio-capture permission grant across rebuilds. Prefer an
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
"$GO" build -tags bundle -ldflags "-X main.appVersion=$APP_VERSION -X main.appStoreBuild=$APP_STORE" -o "$ROOT/build/partyparty-server" "$ROOT"

echo ">> Swift menu-bar app (release)"
PARTYPARTY_APP_STORE="$APP_STORE" swift build "${SWIFT_ARGS[@]}"
BIN="$(PARTYPARTY_APP_STORE="$APP_STORE" swift build "${SWIFT_ARGS[@]}" --show-bin-path)"

echo ">> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources" "$APP/Contents/Frameworks"
cp "$BIN/partyparty"               "$APP/Contents/MacOS/partyparty"
cp "$ROOT/build/partyparty-server" "$APP/Contents/Helpers/partyparty-server"
cp "$ROOT/assets/ffmpeg"           "$APP/Contents/Helpers/ffmpeg"
cp "$ROOT/assets/mediamtx"         "$APP/Contents/Helpers/mediamtx"
cp "$ROOT/assets/ppcapture"        "$APP/Contents/Helpers/ppcapture"
cp "$ROOT/app/Info.plist"          "$APP/Contents/Info.plist"
cp "$ROOT/app/AppIcon.icns"        "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/app/PrivacyInfo.xcprivacy" "$APP/Contents/Resources/PrivacyInfo.xcprivacy"
if [ "$APP_STORE" = "1" ]; then
  /usr/libexec/PlistBuddy -c 'Delete :SUAutomaticallyUpdate' "$APP/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Delete :SUEnableAutomaticChecks' "$APP/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Delete :SUFeedURL' "$APP/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Delete :SUPublicEDKey' "$APP/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c 'Delete :SUScheduledCheckInterval' "$APP/Contents/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${APP_STORE_BUNDLE_ID:-fm.partyparty.app}" "$APP/Contents/Info.plist"
  if [ -n "${APP_STORE_PROVISIONING_PROFILE:-}" ]; then
    cp "$APP_STORE_PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
  fi
else
  mkdir -p "$APP/Contents/Library/LaunchDaemons"
# BOTH privileged helpers are GONE. pp-port443 (clean links) went first; pp-port80
# followed after it was found to permanently break loopback — it created a macOS
# network service on lo0 for Internet Sharing, which survived app uninstall and
# left Macs unable to reach 127.0.0.1 (white-screen console). partyparty no longer
# creates networks; it uses the Wi-Fi that is already there. Only these plist stubs
# stay so LegacyHelperCleanup can resolve and UNREGISTER any daemon still
# registered on an install that skipped versions. No helper binaries are bundled;
# a later release can drop the stubs once every install has cycled through.
cp "$ROOT/app/net.ramine.partyparty.port80.plist"  "$APP/Contents/Library/LaunchDaemons/net.ramine.partyparty.port80.plist"
cp "$ROOT/app/net.ramine.partyparty.port443.plist" "$APP/Contents/Library/LaunchDaemons/net.ramine.partyparty.port443.plist"
fi

# Sparkle framework (auto-update) — embed + make it discoverable via rpath.
if [ "$APP_STORE" != "1" ] && [ -d "$BIN/Sparkle.framework" ]; then
  cp -R "$BIN/Sparkle.framework" "$APP/Contents/Frameworks/Sparkle.framework"
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/partyparty" 2>/dev/null || true
fi
chmod +x "$APP/Contents/Helpers/"* "$APP/Contents/MacOS/partyparty"

codesign_one() { # $1=path  $2=entitlements (optional)
  local path="$1" ent="${2:-}"
  local args=(--force)
  if [ "$SIGN_ID" = "-" ]; then
    args+=(--sign -)
  elif [ "$APP_STORE" = "1" ]; then
    # App Store distribution is sandboxed and signed by Apple after review;
    # hardened-runtime/notarization flags belong only to direct distribution.
    args+=(--sign "$SIGN_ID")
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
# Store helpers inherit the parent sandbox. Direct builds keep the established
# capture entitlement only on ppcapture.
if [ "$APP_STORE" = "1" ]; then
  for b in mediamtx ffmpeg partyparty-server ppcapture; do
    codesign_one "$APP/Contents/Helpers/$b" "$CHILD_ENT"
  done
else
  for b in mediamtx ffmpeg partyparty-server; do
    codesign_one "$APP/Contents/Helpers/$b"
  done
  codesign_one "$APP/Contents/Helpers/ppcapture" "$ENT"
fi
codesign_one "$APP/Contents/MacOS/partyparty" "$ENT"
codesign_one "$APP" "$ENT"

echo ">> verify"
codesign --verify --strict --verbose=2 "$APP"
if [ "$APP_STORE" = "1" ]; then
  codesign -d --entitlements :- "$APP" 2>&1 | grep -q 'com.apple.security.app-sandbox'
  [ ! -d "$APP/Contents/Frameworks/Sparkle.framework" ]
  "$ROOT/scripts/verify-app-store.sh" "$APP"
fi
echo ">> built $APP"
