#!/usr/bin/env bash
# Build, verify, install, and launch the sandboxed Store edition for local testing.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
DERIVED="$ROOT/build/xcode-app-store-dev"
BUILT_APP="$DERIVED/Build/Products/Debug/PartyParty.app"
# One install slot: TestFlight and the App Store install to /Applications/PartyParty.app,
# so putting the dev build there means each lane replaces the other instead of
# accumulating copies that fight over port 8000 and the menu bar.
DEST_DIR="${PP_LOCAL_STORE_INSTALL_DIR:-/Applications}"
DEST_APP="$DEST_DIR/PartyParty.app"
STAGED_DIR="$DERIVED/.install-staging.$$"
STAGED_APP="$STAGED_DIR/PartyParty.app"
OLD_APP="$DEST_DIR/.PartyParty.old.$$"
LEGACY_DIR="$HOME/Applications/PartyParty Store Development"

if [ "${PP_REUSE_BUILD:-0}" != "1" ]; then
  make assets/ppcapture
  xcodebuild \
    -project "$ROOT/app/PartyParty.xcodeproj" \
    -scheme PartyParty \
    -configuration Debug \
    -destination "platform=macOS,arch=arm64" \
    -derivedDataPath "$DERIVED" \
    -allowProvisioningUpdates \
    clean build
fi

[ -d "$BUILT_APP" ] || {
  echo "Store development build not found: $BUILT_APP" >&2
  exit 1
}

# Both editions own the same local server ports, so only one can run at a time,
# and the launch test below needs port 8000 free. Quit is asynchronous and the
# server tears down mediamtx/ffmpeg children, which can take well over five
# seconds; wait generously and fail plainly rather than letting the launch test
# trip over a port that is still draining.
osascript -e 'tell application id "fm.partyparty.beta" to quit' >/dev/null 2>&1 || true
osascript -e 'tell application id "fm.partyparty.app" to quit' >/dev/null 2>&1 || true
for _ in $(seq 1 120); do
  curl -fsS --max-time 1 http://127.0.0.1:8000/api/status >/dev/null 2>&1 || break
  sleep 0.25
done
if curl -fsS --max-time 1 http://127.0.0.1:8000/api/status >/dev/null 2>&1; then
  echo "Port 8000 is still in use 30s after asking PartyParty to quit." >&2
  exit 1
fi

"$ROOT/scripts/test-app-store.sh" "$BUILT_APP"

mkdir -p "$DEST_DIR"
rm -rf "$STAGED_DIR" "$OLD_APP"
mkdir -p "$STAGED_DIR"
ditto "$BUILT_APP" "$STAGED_APP"
"$ROOT/scripts/verify-app-store.sh" "$STAGED_APP"

rollback() {
  rm -rf "$STAGED_DIR"
  if [ -d "$OLD_APP" ] && [ ! -d "$DEST_APP" ]; then
    mv "$OLD_APP" "$DEST_APP"
  fi
}
trap rollback EXIT

[ ! -d "$DEST_APP" ] || mv "$DEST_APP" "$OLD_APP"
mv "$STAGED_APP" "$DEST_APP"
rm -rf "$STAGED_DIR"
"$ROOT/scripts/verify-app-store.sh" "$DEST_APP"
rm -rf "$OLD_APP"
trap - EXIT

# Retire the pre-one-slot install location so two copies never coexist.
[ ! -d "$LEGACY_DIR" ] || rm -rf "$LEGACY_DIR"

open -g "$DEST_APP"
echo "installed and launched $DEST_APP"
cat <<'EOF'

This build is ad-hoc signed and carries no App Store receipt. macOS will NOT
let TestFlight replace it: the signatures differ, so TestFlight installs a
SECOND copy beside it called "PartyParty 2.app". That happened on 2026-08-14
and is not a maybe, it is what always happens.

  Before installing anything from TestFlight, run:  scripts/hand-slot-to-testflight.sh
EOF
