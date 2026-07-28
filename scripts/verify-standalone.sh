#!/usr/bin/env bash
set -euo pipefail

APP="${1:?app path required}"
VERSION="${2:?version required}"
BUILD="${3:?build required}"
PLIST="$APP/Contents/Info.plist"

[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PLIST")" = "fm.partyparty.beta" ]
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")" = "$VERSION" ]
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")" = "$BUILD" ]
[ "$(/usr/libexec/PlistBuddy -c 'Print :SUFeedURL' "$PLIST")" = "https://partyparty.party/appcast.xml" ]
[ -d "$APP/Contents/Frameworks/Sparkle.framework" ]
codesign --verify --deep --strict --verbose=2 "$APP"
CAPTURE="$APP/Contents/Helpers/ppcapture.app"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$CAPTURE/Contents/Info.plist")" = "fm.partyparty.beta" ]
otool -L "$CAPTURE/Contents/MacOS/ppcapture" | grep -q '/ShazamKit.framework/'
capture_entitlements="$(codesign -d --entitlements :- "$CAPTURE" 2>/dev/null)"
capture_keys="$(printf '%s' "$capture_entitlements" | plutil -convert json -o - - | /usr/bin/python3 -c \
  'import json,sys; print("\n".join(sorted(json.load(sys.stdin))))')"
[ "$capture_keys" = $'com.apple.security.app-sandbox\ncom.apple.security.device.audio-input\ncom.apple.security.network.client\ncom.apple.security.temporary-exception.mach-lookup.global-name' ]
capture_mach_services="$(printf '%s' "$capture_entitlements" | plutil -convert json -o - - | /usr/bin/python3 -c \
  'import json,sys; print("\n".join(json.load(sys.stdin)["com.apple.security.temporary-exception.mach-lookup.global-name"]))')"
[ "$capture_mach_services" = "com.apple.shazamd" ]
if printf '%s' "$capture_keys" | grep -qx com.apple.security.inherit; then
  echo "ppcapture must not inherit a sandbox; ShazamKit matching will fail with error 202." >&2
  exit 1
fi
if codesign -d --entitlements :- "$APP" 2>&1 | grep -q 'com.apple.security.app-sandbox'; then
  echo "Standalone app must not use the App Sandbox entitlement." >&2
  exit 1
fi
if [ "${REQUIRE_NOTARIZED:-0}" = "1" ]; then
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
fi
