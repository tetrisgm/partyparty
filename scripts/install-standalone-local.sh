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
