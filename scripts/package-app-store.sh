#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
: "${APP_STORE_PROVISIONING_PROFILE:?set APP_STORE_PROVISIONING_PROFILE to the Mac App Store profile}"
: "${PP_SIGN_ID:?set PP_SIGN_ID to the Apple Distribution signing identity}"
: "${APP_STORE_INSTALLER_ID:?set APP_STORE_INSTALLER_ID to the Mac Installer Distribution identity}"
[ -f "$APP_STORE_PROVISIONING_PROFILE" ] || {
  echo "provisioning profile not found: $APP_STORE_PROVISIONING_PROFILE" >&2
  exit 1
}

make assets/ppcapture
PROFILE_PLIST="$(mktemp)"
EXPORT_OPTIONS="$(mktemp)"
trap 'rm -f "$PROFILE_PLIST" "$EXPORT_OPTIONS"' EXIT
security cms -D -i "$APP_STORE_PROVISIONING_PROFILE" > "$PROFILE_PLIST"
PROFILE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :Name' "$PROFILE_PLIST")"
PROFILE_UUID="$(/usr/libexec/PlistBuddy -c 'Print :UUID' "$PROFILE_PLIST")"
TEAM_ID="$(/usr/libexec/PlistBuddy -c 'Print :TeamIdentifier:0' "$PROFILE_PLIST")"
[ "$TEAM_ID" = "52WM463HR2" ] || {
  echo "unexpected provisioning profile team: $TEAM_ID" >&2
  exit 1
}

PROFILE_DIR="$HOME/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILE_DIR"
INSTALLED_PROFILE="$PROFILE_DIR/$PROFILE_UUID.provisionprofile"
if [ "$APP_STORE_PROVISIONING_PROFILE" != "$INSTALLED_PROFILE" ]; then
  install -m 644 "$APP_STORE_PROVISIONING_PROFILE" "$INSTALLED_PROFILE"
fi

ARCHIVE="$PWD/build/partyparty.xcarchive"
EXPORT_DIR="$PWD/build/app-store-export"
rm -rf "$ARCHIVE" "$EXPORT_DIR"

xcodebuild \
  -project "$PWD/app/partyparty.xcodeproj" \
  -scheme partyparty \
  -configuration Release \
  -destination "generic/platform=macOS" \
  -archivePath "$ARCHIVE" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_IDENTITY="$PP_SIGN_ID" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
  PP_SIGN_KEYCHAIN="${APP_STORE_KEYCHAIN:-}" \
  archive

ARCHIVED_APP="$ARCHIVE/Products/Applications/partyparty.app"
REQUIRE_APP_STORE_DISTRIBUTION=1 ./scripts/verify-app-store.sh "$ARCHIVED_APP"

/usr/bin/plutil -create xml1 "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :method string app-store-connect" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :destination string export" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :distributionBundleIdentifier string fm.partyparty.app" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :manageAppVersionAndBuildNumber bool false" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :signingStyle string manual" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :signingCertificate string $PP_SIGN_ID" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :installerSigningCertificate string $APP_STORE_INSTALLER_ID" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :teamID string $TEAM_ID" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :provisioningProfiles dict" "$EXPORT_OPTIONS"
/usr/libexec/PlistBuddy -c "Add :provisioningProfiles:fm.partyparty.app string $PROFILE_NAME" "$EXPORT_OPTIONS"

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS"

EXPORTED_PKG="$(find "$EXPORT_DIR" -maxdepth 1 -type f -name '*.pkg' -print -quit)"
[ -n "$EXPORTED_PKG" ] || {
  echo "Xcode did not export a Mac App Store package." >&2
  exit 1
}
mkdir -p dist
cp "$EXPORTED_PKG" "$PWD/dist/partyparty-app-store.pkg"

./scripts/verify-app-store-package.sh "$PWD/dist/partyparty-app-store.pkg"

if [ "${APP_STORE_VALIDATE:-0}" = "1" ]; then
  : "${APP_STORE_CONNECT_KEY_ID:?set APP_STORE_CONNECT_KEY_ID for validation}"
  : "${APP_STORE_CONNECT_ISSUER_ID:?set APP_STORE_CONNECT_ISSUER_ID for validation}"
  xcrun altool --validate-app \
    -f "$PWD/dist/partyparty-app-store.pkg" \
    -t macos \
    --apiKey "$APP_STORE_CONNECT_KEY_ID" \
    --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"
fi

# Upload sends the build to App Store Connect, where it lands in TestFlight
# processing. It does NOT submit anything for App Store review; that remains a
# deliberate human step in the ASC UI. Guarded separately from validation so a
# routine package run never uploads by accident.
if [ "${APP_STORE_UPLOAD:-0}" = "1" ]; then
  : "${APP_STORE_CONNECT_KEY_ID:?set APP_STORE_CONNECT_KEY_ID for upload}"
  : "${APP_STORE_CONNECT_ISSUER_ID:?set APP_STORE_CONNECT_ISSUER_ID for upload}"
  xcrun altool --upload-app \
    -f "$PWD/dist/partyparty-app-store.pkg" \
    -t macos \
    --apiKey "$APP_STORE_CONNECT_KEY_ID" \
    --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"
fi

echo "built dist/partyparty-app-store.pkg"
