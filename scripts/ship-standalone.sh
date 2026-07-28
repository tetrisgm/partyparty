#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${PP_VERSION:-124.02}"
BUILD="${PP_BUILD:-204}"
APP="$ROOT/build/partyparty-beta.app"
RELEASE_DIR="$ROOT/dist/standalone-$VERSION-$BUILD"
ZIP_NAME="partyparty-$VERSION-$BUILD.zip"
ZIP="$RELEASE_DIR/$ZIP_NAME"
APPCAST="$RELEASE_DIR/appcast.xml"
WRANGLER="$ROOT/cloudflare/node_modules/.bin/wrangler"
GENERATE_APPCAST="$ROOT/app/.build/artifacts/sparkle/Sparkle/bin/generate_appcast"

"$ROOT/scripts/build-standalone.sh"
rm -rf "$RELEASE_DIR"
mkdir -p "$RELEASE_DIR"

ditto -c -k --sequesterRsrc --keepParent "$APP" "$RELEASE_DIR/notary.zip"
source "$ROOT/scripts/notary-lib.sh"
notary_submit_with_retry "$RELEASE_DIR/notary.zip" "standalone-app" "$RELEASE_DIR/notary-id.txt"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
REQUIRE_NOTARIZED=1 "$ROOT/scripts/verify-standalone.sh" "$APP" "$VERSION" "$BUILD"
rm "$RELEASE_DIR/notary.zip"

ditto -c -k --sequesterRsrc --keepParent "$APP" "$ZIP"
"$GENERATE_APPCAST" \
  --download-url-prefix "https://partyparty.party/downloads/" \
  "$RELEASE_DIR"
[ -f "$APPCAST" ]
grep -q "sparkle:edSignature=" "$APPCAST"
grep -q "<sparkle:version>$BUILD</sparkle:version>" "$APPCAST"

(
  cd cloudflare
  "$WRANGLER" r2 object put "partyparty-dl/standalone/$ZIP_NAME" --file "$ZIP" --content-type application/zip --remote
  "$WRANGLER" r2 object put "partyparty-dl/standalone/partyparty-beta.zip" --file "$ZIP" --content-type application/zip --remote
  "$WRANGLER" deploy
  "$WRANGLER" r2 object put "partyparty-dl/standalone/appcast.xml" --file "$APPCAST" --content-type application/xml --remote
)

"$ROOT/scripts/verify-standalone-public.sh" "$ZIP" "$VERSION" "$BUILD"
