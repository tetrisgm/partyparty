#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
APP="${1:-$PWD/build/partyparty.app}"
EXPECTED_BUNDLE_ID="${APP_STORE_BUNDLE_ID:-fm.partyparty.app}"

fail() {
  echo "App Store verification failed: $*" >&2
  exit 1
}

[ -d "$APP/Contents" ] || fail "app bundle not found at $APP"
[ "$(basename "$APP")" = "partyparty.app" ] ||
  fail "App Store payload must use the canonical bundle name partyparty.app"
/usr/bin/codesign --verify --strict --verbose=2 "$APP"

INFO="$APP/Contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO")" = "$EXPECTED_BUNDLE_ID" ] ||
  fail "unexpected bundle identifier"
[ "$(/usr/libexec/PlistBuddy -c 'Print :LSApplicationCategoryType' "$INFO")" = "public.app-category.music" ] ||
  fail "App Store category is not Music"
[ "$(/usr/libexec/PlistBuddy -c 'Print :NSHumanReadableCopyright' "$INFO")" = "PartyParty" ] ||
  fail "copyright must use the PartyParty publisher name"
[ "$(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$INFO")" = "false" ] ||
  fail "export-compliance declaration is missing"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+$ ]] || fail "invalid version $VERSION"
[[ "$BUILD" =~ ^[0-9]+$ ]] || fail "invalid build $BUILD"

for key in SUAutomaticallyUpdate SUEnableAutomaticChecks SUFeedURL SUPublicEDKey SUScheduledCheckInterval; do
  if /usr/libexec/PlistBuddy -c "Print :$key" "$INFO" >/dev/null 2>&1; then
    fail "Store Info.plist contains Sparkle key $key"
  fi
done

[ ! -e "$APP/Contents/Frameworks/Sparkle.framework" ] || fail "Sparkle is bundled"
[ ! -e "$APP/Contents/Library/LaunchDaemons" ] || fail "LaunchDaemons are bundled"
[ ! -e "$APP/Contents/Library/PrivilegedHelperTools" ] || fail "privileged helpers are bundled"
[ -f "$APP/Contents/Resources/Assets.car" ] || fail "compiled asset catalog is missing"
for key in BuildMachineOSBuild DTPlatformBuild DTPlatformName DTPlatformVersion DTSDKBuild DTSDKName DTXcode DTXcodeBuild; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$INFO" >/dev/null 2>&1 ||
    fail "Xcode build metadata is missing: $key"
done
unreadable="$(find "$APP" ! -perm -o+r -print -quit)"
[ -z "$unreadable" ] || fail "bundle item is not world-readable: $unreadable"
quarantine_xattr="$(xattr -lr "$APP" 2>/dev/null | grep -E 'com\\.apple\\.quarantine:' | head -1 || true)"
[ -z "$quarantine_xattr" ] || fail "bundle contains a quarantine attribute: $quarantine_xattr"

PRIVACY="$APP/Contents/Resources/PrivacyInfo.xcprivacy"
[ -f "$PRIVACY" ] || fail "PrivacyInfo.xcprivacy is missing"
/usr/bin/plutil -lint "$PRIVACY" >/dev/null
[ "$(/usr/bin/plutil -extract NSPrivacyTracking raw -o - "$PRIVACY")" = "false" ] ||
  fail "privacy manifest enables tracking"

expected_helpers=$'ffmpeg\nmediamtx\npartyparty-server\nppcapture.app'
actual_helpers="$(find "$APP/Contents/Helpers" -mindepth 1 -maxdepth 1 -print | sed 's#.*/##' | sort)"
[ "$actual_helpers" = "$expected_helpers" ] || fail "unexpected helper set: $actual_helpers"

entitlements() {
  /usr/bin/codesign -d --entitlements :- "$1" 2>/dev/null
}

entitlement_value() {
  entitlements "$1" | /usr/bin/plutil -convert json -o - - | /usr/bin/python3 -c \
    'import json,sys; data=json.load(sys.stdin); value=data[sys.argv[1]] if sys.argv[1] in data else sys.exit(1); print(str(value).lower() if isinstance(value, bool) else value)' "$2"
}

[ "$(entitlement_value "$APP" com.apple.security.app-sandbox)" = "true" ] || fail "app sandbox is missing"
[ "$(entitlement_value "$APP" com.apple.security.network.client)" = "true" ] || fail "network client entitlement is missing"
[ "$(entitlement_value "$APP" com.apple.security.network.server)" = "true" ] || fail "network server entitlement is missing"
[ "$(entitlement_value "$APP" com.apple.security.device.audio-input)" = "true" ] || fail "audio input entitlement is missing"
[ "$(entitlement_value "$APP" com.apple.security.files.user-selected.read-only)" = "true" ] ||
  fail "user-selected read-only file entitlement is missing"
if entitlement_value "$APP" com.apple.security.inherit >/dev/null 2>&1; then
  fail "main app must not inherit a sandbox"
fi

for helper in ffmpeg mediamtx partyparty-server; do
  path="$APP/Contents/Helpers/$helper"
  [ "$(entitlement_value "$path" com.apple.security.app-sandbox)" = "true" ] ||
    fail "$helper is not sandboxed"
  [ "$(entitlement_value "$path" com.apple.security.inherit)" = "true" ] ||
    fail "$helper does not inherit the app sandbox"
  keys="$(entitlements "$path" | /usr/bin/plutil -convert json -o - - | /usr/bin/python3 -c \
    'import json,sys; print("\n".join(sorted(json.load(sys.stdin))))')"
  [ "$keys" = $'com.apple.security.app-sandbox\ncom.apple.security.inherit' ] ||
    fail "$helper has unexpected entitlements: $keys"
done

[ "$(entitlement_value "$APP/Contents/Helpers/ppcapture.app" com.apple.security.app-sandbox)" = "true" ] ||
  fail "ppcapture is not directly sandboxed"
# The helper is its own bundle and must say so. This check used to assert the
# OPPOSITE, that the helper's identifier equals the parent's, which is the
# exact defect that made every TestFlight install 500 server-side. A package
# with two bundles claiming one identity is malformed no matter how many
# signature checks it passes.
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Helpers/ppcapture.app/Contents/Info.plist")" = "fm.partyparty.capture" ] ||
  fail "ppcapture does not use the Shazam-enabled app identifier"
[ "$(entitlement_value "$APP/Contents/Helpers/ppcapture.app" com.apple.security.network.client)" = "true" ] ||
  fail "ppcapture has no network client access for ShazamKit"
[ "$(entitlement_value "$APP/Contents/Helpers/ppcapture.app" com.apple.security.device.audio-input)" = "true" ] ||
  fail "ppcapture has no audio input access"
if entitlement_value "$APP/Contents/Helpers/ppcapture.app" com.apple.security.inherit >/dev/null 2>&1; then
  fail "ppcapture must not inherit the app sandbox because ShazamKit error 202 results"
fi
capture_keys="$(entitlements "$APP/Contents/Helpers/ppcapture.app" | /usr/bin/plutil -convert json -o - - | /usr/bin/python3 -c \
  'import json,sys; print("\n".join(sorted(json.load(sys.stdin))))')"
capture_expected=$'com.apple.security.app-sandbox\ncom.apple.security.device.audio-input\ncom.apple.security.network.client\ncom.apple.security.temporary-exception.mach-lookup.global-name'
if [ "${REQUIRE_APP_STORE_DISTRIBUTION:-0}" = "1" ]; then
  capture_expected=$'com.apple.application-identifier\ncom.apple.developer.team-identifier\ncom.apple.security.app-sandbox\ncom.apple.security.device.audio-input\ncom.apple.security.network.client\ncom.apple.security.temporary-exception.mach-lookup.global-name'
  capture_app_id="$(entitlement_value "$APP/Contents/Helpers/ppcapture.app" com.apple.application-identifier)"
  [[ "$capture_app_id" = *".$EXPECTED_BUNDLE_ID" ]] ||
    fail "ppcapture application identifier is $capture_app_id"
fi
[ "$capture_keys" = "$capture_expected" ] || fail "ppcapture has unexpected entitlements: $capture_keys"
capture_mach_services="$(entitlements "$APP/Contents/Helpers/ppcapture.app" | /usr/bin/plutil -convert json -o - - | /usr/bin/python3 -c \
  'import json,sys; print("\n".join(json.load(sys.stdin)["com.apple.security.temporary-exception.mach-lookup.global-name"]))')"
[ "$capture_mach_services" = "com.apple.shazamd" ] ||
  fail "ppcapture has an unexpected temporary Mach service exception: $capture_mach_services"

otool -L "$APP/Contents/Helpers/ppcapture.app/Contents/MacOS/ppcapture" | grep -q '/ShazamKit.framework/'

if [ -f "$APP/Contents/embedded.provisionprofile" ]; then
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  /usr/bin/security cms -D -i "$APP/Contents/embedded.provisionprofile" > "$work/profile.plist"
  app_id="$(/usr/libexec/PlistBuddy -c 'Print :Entitlements:com.apple.application-identifier' "$work/profile.plist")"
  [[ "$app_id" = *".$EXPECTED_BUNDLE_ID" ]] || fail "profile application identifier is $app_id"
  signed_app_id="$(entitlement_value "$APP" com.apple.application-identifier)"
  [ "$signed_app_id" = "$app_id" ] ||
    fail "signed application identifier $signed_app_id does not match profile $app_id"
elif [ "${REQUIRE_APP_STORE_DISTRIBUTION:-0}" = "1" ]; then
  fail "distribution build has no provisioning profile"
fi

if [ "${REQUIRE_APP_STORE_DISTRIBUTION:-0}" = "1" ]; then
  authority="$(/usr/bin/codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
  [[ "$authority" = Apple\ Distribution:* ]] || fail "app is not signed with Apple Distribution"
fi

echo "App Store bundle verified: $VERSION build $BUILD ($EXPECTED_BUNDLE_ID)"

# Nested bundles carry no provisioning profile: profiles bind an application
# identifier, nested code has its own, and Apple's install pipeline is the
# thing that noticed when this was wrong.
if [ -e "$APP/Contents/Helpers/ppcapture.app/Contents/embedded.provisionprofile" ]; then
  echo "ppcapture.app embeds a provisioning profile; it must not." >&2
  exit 1
fi

# The bundled ffmpeg must be the LGPL build. The GPL one is a licensing defect
# in every distribution lane, and the App Store terms make it a guaranteed
# problem there.
if strings -a "$APP/Contents/Helpers/ffmpeg" 2>/dev/null | grep -q -- "--enable-gpl"; then
  echo "bundled ffmpeg is a GPL build; ship the LGPL build from scripts/build-ffmpeg-lgpl.sh" >&2
  exit 1
fi
