#!/usr/bin/env bash
# Build the tiny one-click macOS installer stub:
#   build/Install partyparty.app
#   dist/Install-partyparty.zip
#
# Local unsigned/ad-hoc build:
#   ./scripts/build-installer.sh
#
# Developer ID build, notarize, and package:
#   PP_SIGN_ID="Developer ID Application: ... (TEAMID)" ./scripts/build-installer.sh
#
# Optional publish after packaging:
#   ./scripts/build-installer.sh --publish
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
PACKAGE="$ROOT/installer-app"
APP="$ROOT/build/Install partyparty.app"
DIST="$ROOT/dist/Install-partyparty.zip"
ENT="$ROOT/installer-app/installer.entitlements"
PROFILE="${PP_NOTARY_PROFILE:-pp-notary}"
PUBLISH=0

for arg in "$@"; do
  case "$arg" in
    --publish)
      PUBLISH=1
      ;;
    *)
      echo "unknown argument: $arg" >&2
      echo "usage: $0 [--publish]" >&2
      exit 2
      ;;
  esac
done

# Prefer an explicit PP_SIGN_ID, else auto-detect a local Developer ID
# Application identity, else fall back to ad-hoc for local packaging tests.
EXPLICIT_ID="${PP_SIGN_ID:-}"
SIGN_ID="$EXPLICIT_ID"
if [ -z "$SIGN_ID" ]; then
  SIGN_ID="$(security find-identity -p codesigning -v 2>/dev/null | awk -F'"' '/Developer ID Application/{print $2; exit}')"
  [ -z "$SIGN_ID" ] && SIGN_ID="-"
fi

echo ">> Swift installer app (release)"
swift build -c release --package-path "$PACKAGE"
BIN="$(swift build -c release --package-path "$PACKAGE" --show-bin-path)"

echo ">> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN/InstallPartyparty" "$APP/Contents/MacOS/InstallPartyparty"
cp "$ROOT/installer-app/Info.plist" "$APP/Contents/Info.plist"
cp "$ROOT/app/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
chmod +x "$APP/Contents/MacOS/InstallPartyparty"

echo ">> codesigning installer ($SIGN_ID)"
if [ "$SIGN_ID" = "-" ]; then
  codesign --force --options runtime --entitlements "$ENT" --sign - "$APP"
else
  codesign --force --options runtime --timestamp --entitlements "$ENT" --sign "$SIGN_ID" "$APP"
fi
codesign --verify --strict --verbose=2 "$APP"

if [ "$SIGN_ID" = "-" ]; then
  echo ">> skipping notarization for ad-hoc signature"
else
  NOTARY_ZIP="$ROOT/build/Install-partyparty-notarize.zip"
  echo ">> zipping installer for notarization"
  rm -f "$NOTARY_ZIP"
  ditto -c -k --keepParent "$APP" "$NOTARY_ZIP"

  echo ">> submitting installer to Apple notary service (profile: $PROFILE)"
  xcrun notarytool submit "$NOTARY_ZIP" --keychain-profile "$PROFILE" --wait

  echo ">> stapling notarization ticket"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
  spctl -a -vvv -t exec "$APP"
  rm -f "$NOTARY_ZIP"
fi

echo ">> packaging download zip"
mkdir -p "$ROOT/dist"
rm -f "$DIST"
ditto -c -k --keepParent "$APP" "$DIST"
echo ">> built $DIST"

if [ "$PUBLISH" -eq 1 ]; then
  WRANGLER="$ROOT/cloudflare/node_modules/.bin/wrangler"
  [ -x "$WRANGLER" ] || { echo "missing wrangler at $WRANGLER" >&2; exit 1; }

  echo ">> publishing installer zip to R2"
  "$WRANGLER" r2 object put partyparty-dl/install-partyparty.zip \
    --file "$DIST" \
    --content-type application/zip \
    --remote
  echo ">> published: https://party.ramine.net/install-partyparty.zip"
fi

cat <<EOF

Next steps:
  1. Test the packaged app locally: open "$APP"
  2. Publish when ready: ./scripts/build-installer.sh --publish
  3. Deploy the updated site: ./scripts/deploy-site.sh

Download URL:
  https://party.ramine.net/install-partyparty.zip
EOF
