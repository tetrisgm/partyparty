#!/usr/bin/env bash
# Publish party.ramine.net: the landing page (site/index.html) + the current
# notarized app download, to Cloudflare (one Worker serving static assets +
# streaming the big .app zip from an R2 bucket).
#
# ONE-TIME auth (you do this once — no secret ever reaches me):
#   cd cloudflare && npm install && npx wrangler login
#
# Then, any time you want to push the site or a fresh build:
#   make notarize      # build + notarize the .app (needed for a real download)
#   make deploy-site
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="build/partyparty.app"
ZIP="build/partyparty.zip"
BUCKET="partyparty-dl"
WR="$ROOT/cloudflare/node_modules/.bin/wrangler"

[ -x "$WR" ] || { echo "wrangler missing — run: (cd cloudflare && npm install)"; exit 1; }
"$WR" whoami >/dev/null 2>&1 || { echo "Not logged in — run: (cd cloudflare && npx wrangler login)"; exit 1; }

if [ ! -d "$APP" ]; then
  echo "No app bundle at $APP. Build it first: make notarize (or make app)"; exit 1
fi

# Warn (don't block) if the build isn't notarized — un-notarized apps trip
# Gatekeeper on the downloader's Mac ("can't be opened").
if ! xcrun stapler validate "$APP" >/dev/null 2>&1; then
  echo "WARNING: $APP is not notarized/stapled. Guests will hit Gatekeeper."
  echo "         Run 'make notarize' first for a distributable build."
fi

echo ">> packaging $ZIP"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
echo "   $(du -h "$ZIP" | cut -f1)"

echo ">> ensuring R2 bucket '$BUCKET'"
"$WR" r2 bucket create "$BUCKET" 2>/dev/null || true

echo ">> uploading partyparty.zip to R2"
"$WR" r2 object put "$BUCKET/partyparty.zip" --file "$ZIP" --content-type application/zip --remote

# Upload the Sparkle appcast if a signed one has been generated (see RELEASING.md).
if [ -f dist/appcast.xml ]; then
  echo ">> uploading appcast.xml to R2"
  "$WR" r2 object put "$BUCKET/appcast.xml" --file dist/appcast.xml --content-type application/xml --remote
fi

echo ">> deploying Worker + landing page"
( cd cloudflare && "$WR" deploy )

echo
echo "Done. https://party.ramine.net  ·  https://party.ramine.net/partyparty.zip"
