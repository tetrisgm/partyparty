#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
: "${APP_STORE_PROVISIONING_PROFILE:?set APP_STORE_PROVISIONING_PROFILE to the Mac App Store profile}"
: "${PP_SIGN_ID:?set PP_SIGN_ID to the Apple Distribution signing identity}"
: "${APP_STORE_INSTALLER_ID:?set APP_STORE_INSTALLER_ID to the Mac Installer Distribution identity}"

export PARTYPARTY_APP_STORE=1
./scripts/build-app.sh

mkdir -p dist
productbuild \
  --component "$PWD/build/partyparty-app-store.app" /Applications \
  --sign "$APP_STORE_INSTALLER_ID" \
  "$PWD/dist/partyparty-app-store.pkg"

pkgutil --check-signature "$PWD/dist/partyparty-app-store.pkg"
echo "built dist/partyparty-app-store.pkg"
