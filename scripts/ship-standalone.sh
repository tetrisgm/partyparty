#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
VERSION="${PP_VERSION:-124.14}"

# The build number is what Sparkle compares, so it must only ever go up. It used
# to default to a hardcoded constant, which meant any ship that did not happen to
# pass PP_BUILD published a build number lower than the one already installed.
# Sparkle then correctly refused to offer the update, the ship reported success,
# and auto-update was silently dead. That shipped as 125.2 build 216 against an
# installed 218.
#
# Derived from the record of what has actually been published: the Worker's
# download map accumulates every registered build and is committed, and the live
# appcast is what installs are comparing against right now. Highest of the two,
# plus one.
derive_build() {
  local from_map from_feed
  from_map=$(grep -oE 'partyparty-[0-9.]+-([0-9]+)\.zip' "$ROOT/cloudflare/worker.js" 2>/dev/null |
    sed -E 's/.*-([0-9]+)\.zip/\1/' | sort -n | tail -1)
  from_feed=$(curl -fsS --max-time 20 https://partyparty.party/appcast.xml 2>/dev/null |
    grep -oE '<sparkle:version>[0-9]+</sparkle:version>' |
    sed -E 's/[^0-9]//g' | sort -n | tail -1)
  local highest=0
  for candidate in "$from_map" "$from_feed"; do
    if [ -n "$candidate" ] && [ "$candidate" -gt "$highest" ] 2>/dev/null; then highest=$candidate; fi
  done
  if [ "$highest" -le 0 ]; then
    echo "Cannot determine the last published build; refusing to guess." >&2
    return 1
  fi
  echo $((highest + 1))
}
BUILD="${PP_BUILD:-$(derive_build)}"
[ -n "$BUILD" ] || exit 1
echo "shipping version $VERSION build $BUILD"
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

# Exported, not merely set: build-standalone.sh stamps the bundle from its own
# PP_VERSION and PP_BUILD, so a build number this script derived but kept to
# itself leaves the bundle stamped with the child's fallback instead. That
# mismatch is caught by verify-standalone.sh below, but the right place to agree
# on the number is here, once, before anything is built.
export PP_VERSION="$VERSION" PP_BUILD="$BUILD"
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

# Refuse to flip the feed to a build that installs would reject. Every other gate
# here checks the release is well formed, and a regressing build number is well
# formed in every way while being undeliverable, so it passed all of them. This
# is the only check that asks the question that matters: will an installed Mac
# actually take this update.
PUBLISHED_BUILD=$(curl -fsS --max-time 20 https://partyparty.party/appcast.xml 2>/dev/null |
  grep -oE '<sparkle:version>[0-9]+</sparkle:version>' | sed -E 's/[^0-9]//g' | sort -n | tail -1)
if [ -n "$PUBLISHED_BUILD" ] && [ "$BUILD" -le "$PUBLISHED_BUILD" ]; then
  echo "Refusing to publish build $BUILD over published build $PUBLISHED_BUILD." >&2
  echo "Sparkle compares build numbers, so this release would never be offered." >&2
  exit 1
fi

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
