#!/usr/bin/env bash
# Assemble the sandboxed Mac App Store application bundle.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
GO="${GO:-go}"
APP="$ROOT/build/partyparty.app"
ENT="$ROOT/app/partyparty-app-store.entitlements"
CHILD_ENT="$ROOT/app/partyparty-app-store-child.entitlements"
SIGN_ID="${PP_SIGN_ID:--}"
SIGN_KEYCHAIN="${PP_KEYCHAIN:-}"

echo ">> Go server (-tags bundle)"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/app/Info.plist")"
"$GO" build -tags bundle \
  -ldflags "-X main.appVersion=$APP_VERSION" \
  -o "$ROOT/build/partyparty-server" "$ROOT"

echo ">> Xcode app (release)"
XCODE_BUILD="$ROOT/build/xcode-app-store"
xcodebuild \
  -project "$ROOT/app/partyparty.xcodeproj" \
  -scheme partyparty \
  -configuration Release \
  -sdk macosx \
  -derivedDataPath "$XCODE_BUILD" \
  CODE_SIGNING_ALLOWED=NO \
  build
XCODE_APP="$XCODE_BUILD/Build/Products/Release/partyparty.app"

echo ">> assembling $APP"
rm -rf "$APP"
cp -R "$XCODE_APP" "$APP"
mkdir -p "$APP/Contents/Helpers"
cp "$ROOT/build/partyparty-server" "$APP/Contents/Helpers/partyparty-server"
cp "$ROOT/assets/ffmpeg" "$APP/Contents/Helpers/ffmpeg"
cp "$ROOT/assets/mediamtx" "$APP/Contents/Helpers/mediamtx"
cp "$ROOT/assets/ppcapture" "$APP/Contents/Helpers/ppcapture"

if [ -n "${APP_STORE_PROVISIONING_PROFILE:-}" ]; then
  cp "$APP_STORE_PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
  chmod 644 "$APP/Contents/embedded.provisionprofile"
fi
chmod +x "$APP/Contents/Helpers/"* "$APP/Contents/MacOS/partyparty"
chmod -R u+w "$APP"
xattr -cr "$APP"

codesign_one() {
  local path="$1" ent="${2:-}"
  local args=(--force --sign "$SIGN_ID")
  [ -n "$SIGN_KEYCHAIN" ] && args+=(--keychain "$SIGN_KEYCHAIN")
  [ -n "$ent" ] && args+=(--entitlements "$ent")
  codesign "${args[@]}" "$path"
}

echo ">> codesigning inside-out ($SIGN_ID)"
for helper in mediamtx ffmpeg partyparty-server ppcapture; do
  codesign_one "$APP/Contents/Helpers/$helper" "$CHILD_ENT"
done
codesign_one "$APP/Contents/MacOS/partyparty" "$ENT"
codesign_one "$APP" "$ENT"

echo ">> verify"
codesign --verify --strict --verbose=2 "$APP"
"$ROOT/scripts/verify-app-store.sh" "$APP"
echo ">> built $APP"
