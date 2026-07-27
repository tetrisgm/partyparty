#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
APP="${1:-$PWD/build/partyparty-app-store.app}"
EXPECTED_BUNDLE_ID="${APP_STORE_BUNDLE_ID:-fm.partyparty.app}"

fail() {
  echo "App Store verification failed: $*" >&2
  exit 1
}

[ -d "$APP/Contents" ] || fail "app bundle not found at $APP"
/usr/bin/codesign --verify --strict --verbose=2 "$APP"

INFO="$APP/Contents/Info.plist"
[ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO")" = "$EXPECTED_BUNDLE_ID" ] ||
  fail "unexpected bundle identifier"
[ "$(/usr/libexec/PlistBuddy -c 'Print :LSApplicationCategoryType' "$INFO")" = "public.app-category.music" ] ||
  fail "App Store category is not Music"
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
forbidden_xattr="$(xattr -lr "$APP" 2>/dev/null | grep -E 'com\\.apple\\.(quarantine|provenance|macl):' | head -1 || true)"
[ -z "$forbidden_xattr" ] || fail "bundle contains forbidden extended attribute: $forbidden_xattr"

PRIVACY="$APP/Contents/Resources/PrivacyInfo.xcprivacy"
[ -f "$PRIVACY" ] || fail "PrivacyInfo.xcprivacy is missing"
/usr/bin/plutil -lint "$PRIVACY" >/dev/null
[ "$(/usr/bin/plutil -extract NSPrivacyTracking raw -o - "$PRIVACY")" = "false" ] ||
  fail "privacy manifest enables tracking"

expected_helpers=$'ffmpeg\nmediamtx\npartyparty-server\nppcapture'
actual_helpers="$(find "$APP/Contents/Helpers" -mindepth 1 -maxdepth 1 -type f -print | sed 's#.*/##' | sort)"
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
if entitlement_value "$APP" com.apple.security.inherit >/dev/null 2>&1; then
  fail "main app must not inherit a sandbox"
fi

for helper in ffmpeg mediamtx partyparty-server ppcapture; do
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
