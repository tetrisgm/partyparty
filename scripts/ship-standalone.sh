#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${PP_VERSION:-124.14}"
BUILD="${PP_BUILD:-216}"
APP="$ROOT/build/partyparty-beta.app"
RELEASE_DIR="$ROOT/dist/standalone-$VERSION-$BUILD"
ZIP_NAME="partyparty-$VERSION-$BUILD.zip"
ZIP="$RELEASE_DIR/$ZIP_NAME"
APPCAST="$RELEASE_DIR/appcast.xml"
WRANGLER="$ROOT/cloudflare/node_modules/.bin/wrangler"
GENERATE_APPCAST="$ROOT/app/.build/artifacts/sparkle/Sparkle/bin/generate_appcast"

if curl -fsI "https://partyparty.party/downloads/$ZIP_NAME" >/dev/null 2>&1; then
  echo "Refusing to reuse published standalone version $VERSION build $BUILD." >&2
  exit 1
fi

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

  # Register this build with the Worker BEFORE deploying it, and before the
  # appcast is published below.
  #
  # The Worker serves downloads from an explicit per-version map, so an appcast
  # advertising a version the map does not know sends every updating Mac to a
  # 404. That is what 125.0 shipped: zip uploaded, appcast pointing at it, and
  # Sparkle reporting "update error" because the path did not exist. Registering
  # is part of shipping, not a step someone remembers.
  #
  # Absolute path deliberately: this runs inside a subshell that has already cd'd
  # into cloudflare, and a relative path silently resolved to the wrong file.
  python3 - "$ROOT/cloudflare/worker.js" "$VERSION" "$BUILD" <<'REGISTER'
import re, sys, pathlib
from datetime import date

target, version, build = sys.argv[1], sys.argv[2], sys.argv[3]
path = pathlib.Path(target)
src = path.read_text()
name = f"partyparty-{version}-{build}.zip"
if f'"/downloads/{name}"' not in src:
    entry = (f'  "/downloads/{name}": {{ key: "standalone/{name}", '
             f'type: "application/zip", cache: "public, max-age=31536000, immutable", '
             f'download: "{name}" }},\n')
    anchor = "var STANDALONE_FILES = {\n"
    at = src.index(anchor) + len(anchor)
    src = src[:at] + entry + src[at:]
src = re.sub(r'var APP_VERSION = "[^"]*";', f'var APP_VERSION = "{version}";', src, count=1)
src = re.sub(r'var APP_VERSION_DATE = "[^"]*";',
             f'var APP_VERSION_DATE = "{date.today().isoformat()}";', src, count=1)
path.write_text(src)
print(f"worker: registered {name}, APP_VERSION={version}")
REGISTER
  node test/smoke.mjs >/dev/null

  "$WRANGLER" deploy
  "$WRANGLER" r2 object put "partyparty-dl/standalone/appcast.xml" --file "$APPCAST" --content-type application/xml --remote
)

"$ROOT/scripts/verify-standalone-public.sh" "$ZIP" "$VERSION" "$BUILD"
