#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${PP_VERSION:-124.06}"
BUILD="${PP_BUILD:-208}"
APP="$ROOT/build/partyparty-beta.app"
SWIFT_BIN="$ROOT/app/.build/arm64-apple-macosx/release"
SIGN_ID="${PP_SIGN_ID:-}"
CAPTURE_ENT="$ROOT/app/partyparty-app-store-capture.entitlements"

if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -p codesigning -v 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
fi
[ -n "$SIGN_ID" ] || {
  echo "No Developer ID Application signing identity is available." >&2
  exit 1
}

make assets/ppcapture
PARTYPARTY_STANDALONE=1 swift build \
  --package-path app \
  -c release \
  -Xswiftc -DSTANDALONE

go build -tags bundle -ldflags "-X main.appVersion=$VERSION" \
  -o "$ROOT/build/partyparty-server" .

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Frameworks" "$APP/Contents/Resources"
cp "$SWIFT_BIN/partyparty" "$APP/Contents/MacOS/partyparty"
cp "$ROOT/build/partyparty-server" "$ROOT/assets/ffmpeg" "$ROOT/assets/mediamtx" "$APP/Contents/Helpers/"
mkdir -p "$APP/Contents/Helpers/ppcapture.app/Contents/MacOS"
cp "$ROOT/assets/ppcapture" "$APP/Contents/Helpers/ppcapture.app/Contents/MacOS/ppcapture"
cp "$ROOT/app/ppcapture-Info.plist" "$APP/Contents/Helpers/ppcapture.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier fm.partyparty.beta" "$APP/Contents/Helpers/ppcapture.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Helpers/ppcapture.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Contents/Helpers/ppcapture.app/Contents/Info.plist"
cp -R "$SWIFT_BIN/Sparkle.framework" "$APP/Contents/Frameworks/"
install_name_tool -add_rpath "@executable_path/../Frameworks" "$APP/Contents/MacOS/partyparty" 2>/dev/null || true
cp "$ROOT/app/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/app/PrivacyInfo.xcprivacy" "$APP/Contents/Resources/PrivacyInfo.xcprivacy"
cp "$ROOT/app/Info.plist" "$APP/Contents/Info.plist"

/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName partyparty beta" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleName partyparty beta" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier fm.partyparty.beta" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :CFBundleIconName" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :SUFeedURL string https://partyparty.party/appcast.xml" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :SUPublicEDKey string qFmaq5ijn3m2sbiadmkBVvGIjz8v9+piqE/T+YZ1/u0=" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :SUEnableAutomaticChecks bool true" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :SUAutomaticallyUpdate bool true" "$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Add :SUScheduledCheckInterval integer 3600" "$APP/Contents/Info.plist"

chmod -R u+w "$APP"
xattr -cr "$APP"
SPARKLE="$APP/Contents/Frameworks/Sparkle.framework"
for nested in \
  "$SPARKLE/Versions/B/XPCServices/Installer.xpc" \
  "$SPARKLE/Versions/B/XPCServices/Downloader.xpc" \
  "$SPARKLE/Versions/B/Autoupdate" \
  "$SPARKLE/Versions/B/Updater.app"; do
  [ ! -e "$nested" ] || codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$nested"
done
codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$SPARKLE"
for helper in mediamtx ffmpeg partyparty-server; do
  codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP/Contents/Helpers/$helper"
done
codesign --force --options runtime --timestamp --entitlements "$CAPTURE_ENT" --sign "$SIGN_ID" "$APP/Contents/Helpers/ppcapture.app"
codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP/Contents/MacOS/partyparty"
codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$APP"

"$ROOT/scripts/verify-standalone.sh" "$APP" "$VERSION" "$BUILD"
echo "built $APP"
