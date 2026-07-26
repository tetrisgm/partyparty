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

export PARTYPARTY_APP_STORE=1
export REQUIRE_APP_STORE_DISTRIBUTION=1
if [ -n "${APP_STORE_KEYCHAIN:-}" ]; then
  export PP_KEYCHAIN="$APP_STORE_KEYCHAIN"
fi
./scripts/build-app.sh
./scripts/verify-app-store.sh "$PWD/build/partyparty-app-store.app"

mkdir -p dist
productbuild_args=(
  --component "$PWD/build/partyparty-app-store.app" /Applications
  --sign "$APP_STORE_INSTALLER_ID"
)
[ -n "${APP_STORE_KEYCHAIN:-}" ] && productbuild_args+=(--keychain "$APP_STORE_KEYCHAIN")
productbuild "${productbuild_args[@]}" "$PWD/dist/partyparty-app-store.pkg"

pkgutil --check-signature "$PWD/dist/partyparty-app-store.pkg"

if [ "${APP_STORE_VALIDATE:-0}" = "1" ]; then
  : "${APP_STORE_CONNECT_KEY_ID:?set APP_STORE_CONNECT_KEY_ID for validation}"
  : "${APP_STORE_CONNECT_ISSUER_ID:?set APP_STORE_CONNECT_ISSUER_ID for validation}"
  xcrun altool --validate-app \
    -f "$PWD/dist/partyparty-app-store.pkg" \
    -t macos \
    --apiKey "$APP_STORE_CONNECT_KEY_ID" \
    --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"
fi

echo "built dist/partyparty-app-store.pkg"
