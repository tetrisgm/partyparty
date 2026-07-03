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

# Version scheme: <code-major>.<payload-increment>. The FIRST number is the code
# (native/container) version — CODE_MAJOR, which you bump BEFORE every native
# release (each native release IS a code update, so the first number moves). The
# SECOND is the running OTA content version — web/PAYLOAD_VERSION (bumped by
# publish-payload.sh, not here). So a glance says "code update" (first moved) vs
# "OTA update" (second moved). The version is derived here, and CFBundleVersion
# (Sparkle's monotonic comparison key) is auto-incremented, so no hand-editing
# of the plist per release.
CODE_MAJOR="$(tr -dc '0-9' < CODE_MAJOR)"
PAYLOAD="$(tr -dc '0-9' < web/PAYLOAD_VERSION)"
VERSION="$CODE_MAJOR.$PAYLOAD"
BUILD="$(( $(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' app/Info.plist) + 1 ))"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $VERSION" app/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD" app/Info.plist
echo ">> version v$VERSION (build $BUILD)"

[ -x "$WR" ] || { echo "wrangler missing — run: (cd cloudflare && npm install)"; exit 1; }
"$WR" whoami >/dev/null 2>&1 || { echo "Not logged in — run: (cd cloudflare && npx wrangler login)"; exit 1; }
[ -x "$SPK/generate_appcast" ] || { echo "Sparkle tools missing — run: swift build --package-path app"; exit 1; }

echo ">> [1/5] build + notarize v$VERSION"
make notarize

echo ">> [2/5] package dist/partyparty-$VERSION.zip + installer pkg"
rm -rf dist && mkdir -p dist
ditto -c -k --keepParent "$APP" "dist/partyparty-$VERSION.zip"

# THE ONE download: a signed+notarized HOME-DOMAIN .pkg. It installs to
# ~/Applications for this user only, so macOS asks for NO admin password
# (verified: `installer -target CurrentUserHomeDirectory` succeeds without
# sudo). Still no drag, and pkg-placed files skip Gatekeeper — so the entire
# first run is: download → open → (no password) → running. The only prompt left
# anywhere is the one-click audio Allow at first Go Live. ~/Applications is a
# first-class apps location (Spotlight/Launchpad/Dock), and Sparkle updates in
# place there without a password too. (The .zip below is NOT a user download —
# it's solely Sparkle's update enclosure.)
#
# Two-step: a component pkg, then a distribution pkg whose <domains> restricts
# installation to the user's home (that restriction is what drops the password).
PKGSTAGE="dist/pkg-stage"
rm -rf "$PKGSTAGE" && mkdir -p "$PKGSTAGE"
ditto "$APP" "$PKGSTAGE/partyparty.app"
# --scripts: postinstall launches the app (pkgs don't auto-launch).
pkgbuild --identifier net.ramine.partyparty --version "$VERSION" \
  --install-location /Applications --root "$PKGSTAGE" \
  --scripts "$ROOT/app/installer/scripts" "dist/pp-component.pkg"
# Custom wizard: branded Welcome + Conclusion + corner art (light/dark aware).
cat > dist/distribution.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="1">
  <title>partyparty</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <background file="background.png" alignment="bottomleft" scaling="none"/>
  <background-darkAqua file="background.png" alignment="bottomleft" scaling="none"/>
  <domains enable_anywhere="false" enable_currentUserHome="true" enable_localSystem="false"/>
  <options customize="never" require-scripts="false"/>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default"><pkg-ref id="net.ramine.partyparty"/></choice>
  <pkg-ref id="net.ramine.partyparty" version="$VERSION">pp-component.pkg</pkg-ref>
</installer-gui-script>
XML
productbuild --distribution dist/distribution.xml --resources "$ROOT/app/installer" \
  --package-path dist \
  --sign "Developer ID Installer: Ramine Darabiha (52WM463HR2)" \
  "dist/partyparty-$VERSION.pkg"
rm -rf "$PKGSTAGE" dist/pp-component.pkg dist/distribution.xml
xcrun notarytool submit "dist/partyparty-$VERSION.pkg" --keychain-profile pp-notary --wait
xcrun stapler staple "dist/partyparty-$VERSION.pkg"
spctl -a -vv -t install "dist/partyparty-$VERSION.pkg" || true

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
# One-line app-version marker so /content/subscribe can push app updates the
# instant a build lands (the Mac then triggers Sparkle). Written last, after the
# zip/appcast it points at are already up.
printf '%s' "$VERSION" > dist/app-version
"$WR" r2 object put "$BUCKET/content/app-version"     --file "dist/app-version"             --content-type text/plain --remote

echo ">> [5/5] deploy Worker + landing page"
( cd cloudflare && "$WR" deploy )

echo
echo "Released v$VERSION"
echo "  page:     https://party.ramine.net"
echo "  download: https://party.ramine.net/partyparty.zip"
echo "  feed:     https://party.ramine.net/appcast.xml"
