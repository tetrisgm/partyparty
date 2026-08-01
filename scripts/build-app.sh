#!/usr/bin/env bash
# Assemble the sandboxed Mac App Store application bundle.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="$ROOT/build/PartyParty.app"
ENT="$ROOT/app/PartyParty-app-store.entitlements"
CHILD_ENT="$ROOT/app/PartyParty-app-store-child.entitlements"
SIGN_ID="${PP_SIGN_ID:--}"
SIGN_KEYCHAIN="${PP_KEYCHAIN:-}"

echo ">> Xcode app and bundled helpers (release)"
make assets/ppcapture
XCODE_BUILD="$ROOT/build/xcode-app-store"
xcodebuild \
  -project "$ROOT/app/PartyParty.xcodeproj" \
  -scheme PartyParty \
  -configuration Release \
  -sdk macosx \
  -derivedDataPath "$XCODE_BUILD" \
  CODE_SIGNING_ALLOWED=NO \
  build
XCODE_APP="$XCODE_BUILD/Build/Products/Release/PartyParty.app"

echo ">> assembling $APP"
rm -rf "$APP"
cp -R "$XCODE_APP" "$APP"

if [ -n "${APP_STORE_PROVISIONING_PROFILE:-}" ]; then
  cp "$APP_STORE_PROVISIONING_PROFILE" "$APP/Contents/embedded.provisionprofile"
  chmod 644 "$APP/Contents/embedded.provisionprofile"
fi
chmod +x "$APP/Contents/Helpers/"* "$APP/Contents/MacOS/PartyParty"
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
codesign_one "$APP/Contents/MacOS/PartyParty" "$ENT"
codesign_one "$APP" "$ENT"

echo ">> verify"
codesign --verify --strict --verbose=2 "$APP"
"$ROOT/scripts/verify-app-store.sh" "$APP"
echo ">> built $APP"
