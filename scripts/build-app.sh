#!/usr/bin/env bash
# Assemble the sandboxed Mac App Store application bundle.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
GO="${GO:-go}"
APP="$ROOT/build/partyparty-app-store.app"
ENT="$ROOT/app/partyparty-app-store.entitlements"
CHILD_ENT="$ROOT/app/partyparty-app-store-child.entitlements"
SIGN_ID="${PP_SIGN_ID:--}"
SIGN_KEYCHAIN="${PP_KEYCHAIN:-}"

echo ">> Go server (-tags bundle)"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$ROOT/app/Info.plist")"
"$GO" build -tags bundle \
  -ldflags "-X main.appVersion=$APP_VERSION" \
  -o "$ROOT/build/partyparty-server" "$ROOT"

echo ">> Swift app (release)"
swift build -c release --package-path "$ROOT/app" \
  --scratch-path "$ROOT/app/.build-app-store" -Xswiftc -DAPP_STORE
BIN="$(swift build -c release --package-path "$ROOT/app" \
  --scratch-path "$ROOT/app/.build-app-store" -Xswiftc -DAPP_STORE --show-bin-path)"

echo ">> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Helpers" "$APP/Contents/Resources"
cp "$BIN/partyparty" "$APP/Contents/MacOS/partyparty"
cp "$ROOT/build/partyparty-server" "$APP/Contents/Helpers/partyparty-server"
cp "$ROOT/assets/ffmpeg" "$APP/Contents/Helpers/ffmpeg"
cp "$ROOT/assets/mediamtx" "$APP/Contents/Helpers/mediamtx"
cp "$ROOT/assets/ppcapture" "$APP/Contents/Helpers/ppcapture"
cp "$ROOT/app/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/app/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
cp "$ROOT/app/PrivacyInfo.xcprivacy" "$APP/Contents/Resources/PrivacyInfo.xcprivacy"

ACTOOL_INFO="$(mktemp)"
xcrun actool "$ROOT/app/AppAssets.xcassets" \
  --compile "$APP/Contents/Resources" \
  --platform macosx \
  --minimum-deployment-target "$(/usr/libexec/PlistBuddy -c 'Print :LSMinimumSystemVersion' "$APP/Contents/Info.plist")" \
  --app-icon AppIcon \
  --product-type com.apple.product-type.application \
  --output-partial-info-plist "$ACTOOL_INFO"
rm -f "$ACTOOL_INFO"

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
