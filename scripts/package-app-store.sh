#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
: "${APP_STORE_PROVISIONING_PROFILE:?set APP_STORE_PROVISIONING_PROFILE to the Mac App Store profile}"
: "${PP_SIGN_ID:?set PP_SIGN_ID to the Apple Distribution signing identity}"
: "${APP_STORE_INSTALLER_ID:?set APP_STORE_INSTALLER_ID to the Mac Installer Distribution identity}"

HOST_OS_VERSION="$(sw_vers -productVersion)"
HOST_OS_BUILD="$(sw_vers -buildVersion)"
if [[ "$HOST_OS_BUILD" =~ [[:alpha:]]$ ]]; then
  echo "App Store packages cannot be built on prerelease macOS: $HOST_OS_VERSION ($HOST_OS_BUILD)" >&2
  exit 1
fi

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

ARCHIVE="$PWD/build/PartyParty.xcarchive"
EXPORT_DIR="$PWD/build/app-store-export"
rm -rf "$ARCHIVE" "$EXPORT_DIR"

xcodebuild \
  -project "$PWD/app/PartyParty.xcodeproj" \
  -scheme PartyParty \
  -configuration Release \
  -destination "generic/platform=macOS" \
  -archivePath "$ARCHIVE" \
  CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGN_IDENTITY="$PP_SIGN_ID" \
  PROVISIONING_PROFILE_SPECIFIER="$PROFILE_NAME" \
  PP_SIGN_KEYCHAIN="${APP_STORE_KEYCHAIN:-}" \
  archive

ARCHIVED_APP="$ARCHIVE/Products/Applications/PartyParty.app"
REQUIRE_APP_STORE_DISTRIBUTION=1 ./scripts/verify-app-store.sh "$ARCHIVED_APP"
ARCHIVE_HOST_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :BuildMachineOSBuild' "$ARCHIVED_APP/Contents/Info.plist")"
[ "$ARCHIVE_HOST_BUILD" = "$HOST_OS_BUILD" ] || {
  echo "archive host build mismatch: expected $HOST_OS_BUILD, got $ARCHIVE_HOST_BUILD" >&2
  exit 1
}

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

# Export talks to Apple to settle provisioning. With no way to authenticate and
# no UI to prompt in, it blocks forever rather than failing: on the CI runner it
# sat silent for forty minutes after ARCHIVE SUCCEEDED and was killed by the job
# timeout, which reads like a slow build and is a hang. Handing it the App Store
# Connect API key it already has makes the call non-interactive. Locally, where
# a signed-in Xcode settles this from the session, the key is usually absent and
# the flags are simply omitted.
EXPORT_AUTH=()
# CI supplies ASC_KEY_ID/ASC_ISSUER_ID/ASC_PRIVATE_KEY_PATH; a local release.env
# supplies APP_STORE_CONNECT_*. Accept either rather than making one lane's
# naming the condition for the other lane working.
ASC_ID="${ASC_KEY_ID:-${APP_STORE_CONNECT_KEY_ID:-}}"
ASC_ISS="${ASC_ISSUER_ID:-${APP_STORE_CONNECT_ISSUER_ID:-}}"
ASC_KEY_FILE="${ASC_PRIVATE_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_ID}.p8}"
if [ -n "$ASC_ID" ] && [ -n "$ASC_ISS" ] && [ -f "$ASC_KEY_FILE" ]; then
  EXPORT_AUTH=(
    -allowProvisioningUpdates
    -authenticationKeyPath "$ASC_KEY_FILE"
    -authenticationKeyID "$ASC_ID"
    -authenticationKeyIssuerID "$ASC_ISS"
  )
  echo "export: authenticating to App Store Connect with key $ASC_ID"
else
  echo "export: no App Store Connect key available; relying on the Xcode session"
fi

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS" \
  "${EXPORT_AUTH[@]}"

EXPORTED_PKG="$(find "$EXPORT_DIR" -maxdepth 1 -type f -name '*.pkg' -print -quit)"
[ -n "$EXPORTED_PKG" ] || {
  echo "Xcode did not export a Mac App Store package." >&2
  exit 1
}
mkdir -p dist
cp "$EXPORTED_PKG" "$PWD/dist/PartyParty-app-store.pkg"

./scripts/verify-app-store-package.sh "$PWD/dist/PartyParty-app-store.pkg"

# Upload sends the build to App Store Connect, where it lands in TestFlight
# processing. It does NOT submit anything for App Store review; that remains a
# separate explicit operation. A routine package run never uploads by accident.
if [ "${APP_STORE_UPLOAD:-0}" = "1" ]; then
  command -v asc >/dev/null || {
    echo "asc is required for App Store Connect upload (brew install asc)" >&2
    exit 1
  }
  : "${APP_STORE_APP_ID:=6794880742}"
  APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ARCHIVED_APP/Contents/Info.plist")"
  APP_BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$ARCHIVED_APP/Contents/Info.plist")"
  export ASC_TELEMETRY_DISABLED=1
  export ASC_STRICT_AUTH=true
  asc builds upload \
    --app "$APP_STORE_APP_ID" \
    --pkg "$PWD/dist/PartyParty-app-store.pkg" \
    --version "$APP_VERSION" \
    --build-number "$APP_BUILD" \
    --wait \
    --checksum \
    --output json
fi

echo "built dist/PartyParty-app-store.pkg"
