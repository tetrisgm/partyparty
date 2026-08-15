#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
SOURCE_APP="${1:-$ROOT/build/PartyParty-Beta.app}"
DEST_DIR="${PP_LOCAL_INSTALL_DIR:-$HOME/Applications}"
DEST_APP="$DEST_DIR/PartyParty Beta.app"
STAGED_APP="$DEST_DIR/.PartyParty-Beta.new.$$"
OLD_APP="$DEST_DIR/.PartyParty-Beta.old.$$"
EXECUTABLE="$DEST_APP/Contents/MacOS/PartyParty"

# The Mac has one install slot. This lane carries bundle id fm.partyparty.beta, so
# macOS files it as a separate app and it lands *beside* /Applications/PartyParty.app
# instead of replacing it. That is how a stray "PartyParty Beta.app" appeared on
# 2026-08-14: two copies fighting over port 8000 and the menu bar, and no way to tell
# from the Dock which build was which. Local iteration belongs in the one slot, via
# scripts/build-install-app-store-local.sh. Refuse rather than quietly make a second.
STORE_APP="${PP_STORE_INSTALL_DIR:-/Applications}/PartyParty.app"
if [ -d "$STORE_APP" ] && [ "${PP_ALLOW_SECOND_COPY:-0}" != "1" ]; then
  cat >&2 <<EOF
Refusing to install: $STORE_APP already occupies the single install slot.

This script installs the Sparkle standalone edition (fm.partyparty.beta), which does
not replace that app, it sits next to it. Two PartyParty copies on one Mac is the
thing this guard exists to prevent.

  To iterate locally:  scripts/build-install-app-store-local.sh
  To ship:             upload to TestFlight

If you genuinely want both copies (reproducing a standalone-only Sparkle bug, say),
re-run with PP_ALLOW_SECOND_COPY=1.
EOF
  exit 1
fi

app_pids() {
  ps -axo pid=,command= | awk -v exe="$EXECUTABLE" '
    {
      pid=$1
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "", $0)
      if ($0 == exe) print pid
    }
  '
}

app_is_running() {
  [ -n "$(app_pids)" ]
}

[ -d "$SOURCE_APP" ] || {
  echo "Standalone app not found: $SOURCE_APP" >&2
  exit 1
}
PLIST="$SOURCE_APP/Contents/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$PLIST")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$PLIST")"
"$ROOT/scripts/verify-standalone.sh" "$SOURCE_APP" "$VERSION" "$BUILD"

mkdir -p "$DEST_DIR"
rm -rf "$STAGED_APP" "$OLD_APP"
ditto "$SOURCE_APP" "$STAGED_APP"
"$ROOT/scripts/verify-standalone.sh" "$STAGED_APP" "$VERSION" "$BUILD"

was_running=0
if app_is_running; then
  was_running=1
  osascript -e 'tell application id "fm.partyparty.beta" to quit' >/dev/null 2>&1 || true
  for _ in {1..20}; do
    app_is_running || break
    sleep 0.25
  done
  if app_is_running; then
    app_pids | xargs kill 2>/dev/null || true
    sleep 1
    if app_is_running; then
      app_pids | xargs kill -9 2>/dev/null || true
    fi
  fi
fi

rollback() {
  rm -rf "$STAGED_APP"
  if [ -d "$OLD_APP" ] && [ ! -d "$DEST_APP" ]; then mv "$OLD_APP" "$DEST_APP"; fi
  [ "$was_running" = "0" ] || open -g "$DEST_APP" >/dev/null 2>&1 || true
}
trap rollback EXIT

[ ! -d "$DEST_APP" ] || mv "$DEST_APP" "$OLD_APP"
mv "$STAGED_APP" "$DEST_APP"
"$ROOT/scripts/verify-standalone.sh" "$DEST_APP" "$VERSION" "$BUILD"
rm -rf "$OLD_APP"
trap - EXIT

[ "$was_running" = "0" ] || open -g "$DEST_APP"
echo "installed $DEST_APP"
