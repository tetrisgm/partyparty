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
if codesign -d --entitlements :- "$APP" 2>&1 | grep -q 'com.apple.security.app-sandbox'; then
  echo "Standalone app must not use the App Sandbox entitlement." >&2
  exit 1
fi
if [ "${REQUIRE_NOTARIZED:-0}" = "1" ]; then
  xcrun stapler validate "$APP"
  spctl --assess --type execute --verbose=2 "$APP"
fi
