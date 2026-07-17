#!/usr/bin/env bash
# Notarize the locally-built partyparty.app so macOS lets it install the
# privileged port-80 daemon (and so Gatekeeper fully accepts it).
#
# ONE-TIME setup (you do this — it needs your Apple credentials):
#   1. Create an app-specific password at appleid.apple.com
#      (Sign-In & Security -> App-Specific Passwords).
#   2. Store a reusable notarytool profile in your keychain:
#        xcrun notarytool store-credentials "pp-notary" \
#          --apple-id "ramine@ramine.net" --team-id 52WM463HR2
#      (paste the app-specific password when prompted)
#
# Then: make notarize
set -euo pipefail
cd "$(dirname "$0")/.."
APP="build/partyparty.app"
ZIP="build/partyparty-notarize.zip"
SUBMISSION_ID_FILE="build/partyparty-notarize.id"

# shellcheck source=scripts/notary-lib.sh
. "scripts/notary-lib.sh"

cleanup() {
  rm -f "$ZIP" "$SUBMISSION_ID_FILE"
}
trap cleanup EXIT

[ -d "$APP" ] || { echo "Build the app first: make app"; exit 1; }

echo ">> zipping the app for submission"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

notary_submit_with_retry "$ZIP" "app" "$SUBMISSION_ID_FILE"

echo ">> stapling the ticket to the app"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
echo ">> notarized + stapled: $APP"
spctl -a -vvv -t exec "$APP" 2>&1 | head -3 || true
