#!/usr/bin/env bash
# Cut a release from your Mac and publish it to partyparty.party.
#
# Does everything: build + Developer-ID sign + notarize + staple, package the
# versioned zip, sign the Sparkle appcast, push versioned downloads + "latest"
# aliases to R2, deploy the Worker + landing page, then flip update feeds.
#
# No GitHub/CI secrets required — uses your local Developer ID cert, the
# `pp-notary` notarytool profile, and the Sparkle key in your login keychain.
# (The CI equivalent is .github/workflows/release.yml, triggered by a git tag.)
#
# Lower-level implementation detail. Always invoke through:
#   scripts/ship.sh
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="build/partyparty.app"
BUCKET="partyparty-dl"
WR="$ROOT/cloudflare/node_modules/.bin/wrangler"
SPK="$ROOT/app/.build/artifacts/sparkle/Sparkle/bin"

# shellcheck source=scripts/notary-lib.sh
. "$ROOT/scripts/notary-lib.sh"

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

echo ">> [1/8] build + sign v$VERSION"
make app

echo ">> [2/8] package installer pkg from the signed app"
rm -rf dist && mkdir -p dist

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

echo ">> [3/8] notarize app + installer pkg in parallel"
NOTARY_TMP="$(mktemp -d "${TMPDIR:-/tmp}/partyparty-release-notary.XXXXXX")"
cleanup_notary_tmp() {
  rm -rf "$NOTARY_TMP"
}
trap cleanup_notary_tmp EXIT

ditto -c -k --keepParent "$APP" "$NOTARY_TMP/partyparty-app.zip"
notary_submit_with_retry \
  "$NOTARY_TMP/partyparty-app.zip" app "$NOTARY_TMP/app.id" \
  > "$NOTARY_TMP/app.log" 2>&1 &
APP_NOTARY_PID=$!
notary_submit_with_retry \
  "dist/partyparty-$VERSION.pkg" pkg "$NOTARY_TMP/pkg.id" \
  > "$NOTARY_TMP/pkg.log" 2>&1 &
PKG_NOTARY_PID=$!

APP_NOTARY_RC=0
PKG_NOTARY_RC=0
# Do not let errexit skip the second wait: both child statuses must be reaped
# and either failure must stop the release before stapling or publishing.
wait "$APP_NOTARY_PID" || APP_NOTARY_RC=$?
wait "$PKG_NOTARY_PID" || PKG_NOTARY_RC=$?

echo ">> app notarization output"
cat "$NOTARY_TMP/app.log"
echo ">> pkg notarization output"
cat "$NOTARY_TMP/pkg.log"

if [ "$APP_NOTARY_RC" -ne 0 ] || [ "$PKG_NOTARY_RC" -ne 0 ]; then
  echo ">> notarization failed (app=$APP_NOTARY_RC, pkg=$PKG_NOTARY_RC)" >&2
  exit 1
fi

echo ">> stapling + validating the app and installer pkg"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
xcrun stapler staple "dist/partyparty-$VERSION.pkg"
xcrun stapler validate "dist/partyparty-$VERSION.pkg"
spctl -a -vvv -t exec "$APP" 2>&1 | head -3 || true
spctl -a -vv -t install "dist/partyparty-$VERSION.pkg" || true

echo ">> [4/8] package the stapled app + sign the Sparkle appcast"
ditto -c -k --keepParent "$APP" "dist/partyparty-$VERSION.zip"

# Key source: SPARKLE_ED_KEY_FILE if set, else the login keychain (prompts once,
# click "Always Allow"). Enclosure URLs point at partyparty.party.
if [ -n "${SPARKLE_ED_KEY_FILE:-}" ]; then
  "$SPK/generate_appcast" --ed-key-file "$SPARKLE_ED_KEY_FILE" --download-url-prefix "https://partyparty.party/" dist
else
  "$SPK/generate_appcast" --download-url-prefix "https://partyparty.party/" dist
fi

echo ">> [5/8] verify app bundle + appcast metadata"
"$ROOT/scripts/verify-release-artifacts.py" \
  --version "$VERSION" \
  --build "$BUILD" \
  --app "$APP" \
  --zip "dist/partyparty-$VERSION.zip" \
  --appcast "dist/appcast.xml" \
  --base-url "https://partyparty.party" \
  --require-newer-than-installed

echo ">> [6/8] upload release artifacts to R2"
cp "dist/partyparty-$VERSION.zip" dist/partyparty.zip   # stable 'latest' aliases
cp "dist/partyparty-$VERSION.pkg" dist/partyparty.pkg
"$WR" r2 object put "$BUCKET/partyparty-$VERSION.zip" --file "dist/partyparty-$VERSION.zip" --content-type application/zip --remote
"$WR" r2 object put "$BUCKET/partyparty-$VERSION.pkg" --file "dist/partyparty-$VERSION.pkg" --content-type application/octet-stream --remote
"$WR" r2 object put "$BUCKET/partyparty.zip"          --file "dist/partyparty.zip"          --content-type application/zip --remote
"$WR" r2 object put "$BUCKET/partyparty.pkg"          --file "dist/partyparty.pkg"          --content-type application/octet-stream --remote

echo ">> [7/8] deploy Worker + landing page"
( cd cloudflare && "$WR" deploy )

echo ">> [8/8] flip appcast + app-update marker"
# Sparkle's appcast is an update feed, so it flips only after the versioned
# artifacts, stable public downloads, and Worker route are already live.
"$WR" r2 object put "$BUCKET/appcast.xml"             --file "dist/appcast.xml"             --content-type application/xml --remote
# One-line app-version marker so /content/subscribe can push app updates the
# instant a build lands (the Mac then triggers Sparkle). Written last, after the
# zip/appcast and Worker deployment it points at are already up.
printf '%s' "$VERSION" > dist/app-version
"$WR" r2 object put "$BUCKET/content/app-version"     --file "dist/app-version"             --content-type text/plain --remote

echo ">> verify public appcast + download metadata"
"$ROOT/scripts/verify-release-artifacts.py" \
  --version "$VERSION" \
  --build "$BUILD" \
  --app "$APP" \
  --zip "dist/partyparty-$VERSION.zip" \
  --appcast "dist/appcast.xml" \
  --base-url "https://partyparty.party" \
  --require-newer-than-installed \
  --public

echo
echo "Released v$VERSION"
echo "  page:     https://partyparty.party"
echo "  download: https://partyparty.party/partyparty.zip"
echo "  feed:     https://partyparty.party/appcast.xml"
