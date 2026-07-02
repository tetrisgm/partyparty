#!/usr/bin/env bash
# Cut a release from your Mac and publish it to party.ramine.net.
#
# Does everything: build + Developer-ID sign + notarize + staple, package the
# versioned zip, sign the Sparkle appcast, and push the versioned zip + a
# "latest" alias + appcast.xml to R2, then deploy the Worker + landing page.
#
# No GitHub/CI secrets required — uses your local Developer ID cert, the
# `pp-notary` notarytool profile, and the Sparkle key in your login keychain.
# (The CI equivalent is .github/workflows/release.yml, triggered by a git tag.)
#
# Usage:
#   1. bump CFBundleShortVersionString (+ CFBundleVersion) in app/Info.plist
#   2. make release
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="build/partyparty.app"
BUCKET="partyparty-dl"
WR="$ROOT/cloudflare/node_modules/.bin/wrangler"
SPK="$ROOT/app/.build/artifacts/sparkle/Sparkle/bin"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' app/Info.plist)"

[ -x "$WR" ] || { echo "wrangler missing — run: (cd cloudflare && npm install)"; exit 1; }
"$WR" whoami >/dev/null 2>&1 || { echo "Not logged in — run: (cd cloudflare && npx wrangler login)"; exit 1; }
[ -x "$SPK/generate_appcast" ] || { echo "Sparkle tools missing — run: swift build --package-path app"; exit 1; }

echo ">> [1/5] build + notarize v$VERSION"
make notarize

echo ">> [2/5] package dist/partyparty-$VERSION.zip + installer pkg"
rm -rf dist && mkdir -p dist
ditto -c -k --keepParent "$APP" "dist/partyparty-$VERSION.zip"

# THE ONE download: a signed+notarized .pkg. Installer-placed files are NOT
# quarantined, so first launch has zero Gatekeeper dialogs, it lands directly
# in /Applications (no drag, no move prompt, no "running from Downloads"), and
# the only permission is the one-click audio prompt on first Go Live — never a
# Privacy-settings visit. (The .zip below is NOT a user download — it's solely
# Sparkle's in-place update enclosure.)
productbuild --component "$APP" /Applications \
  --sign "Developer ID Installer: Ramine Darabiha (52WM463HR2)" \
  "dist/partyparty-$VERSION.pkg"
xcrun notarytool submit "dist/partyparty-$VERSION.pkg" --keychain-profile pp-notary --wait
xcrun stapler staple "dist/partyparty-$VERSION.pkg"
spctl -a -vv -t install "dist/partyparty-$VERSION.pkg"

echo ">> [3/5] sign the Sparkle appcast (zip enclosure — Sparkle updates in place)"
# Key source: SPARKLE_ED_KEY_FILE if set, else the login keychain (prompts once,
# click "Always Allow"). Enclosure URLs point at party.ramine.net.
if [ -n "${SPARKLE_ED_KEY_FILE:-}" ]; then
  "$SPK/generate_appcast" --ed-key-file "$SPARKLE_ED_KEY_FILE" --download-url-prefix "https://party.ramine.net/" dist
else
  "$SPK/generate_appcast" --download-url-prefix "https://party.ramine.net/" dist
fi

echo ">> [4/5] upload to R2"
cp "dist/partyparty-$VERSION.zip" dist/partyparty.zip   # stable 'latest' aliases
cp "dist/partyparty-$VERSION.pkg" dist/partyparty.pkg
"$WR" r2 object put "$BUCKET/partyparty-$VERSION.zip" --file "dist/partyparty-$VERSION.zip" --content-type application/zip --remote
"$WR" r2 object put "$BUCKET/partyparty.zip"          --file "dist/partyparty.zip"          --content-type application/zip --remote
"$WR" r2 object put "$BUCKET/partyparty-$VERSION.pkg" --file "dist/partyparty-$VERSION.pkg" --content-type application/octet-stream --remote
"$WR" r2 object put "$BUCKET/partyparty.pkg"          --file "dist/partyparty.pkg"          --content-type application/octet-stream --remote
"$WR" r2 object put "$BUCKET/appcast.xml"             --file "dist/appcast.xml"             --content-type application/xml --remote

echo ">> [5/5] deploy Worker + landing page"
( cd cloudflare && "$WR" deploy )

echo
echo "Released v$VERSION"
echo "  page:     https://party.ramine.net"
echo "  download: https://party.ramine.net/partyparty.zip"
echo "  feed:     https://party.ramine.net/appcast.xml"
