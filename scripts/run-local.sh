#!/usr/bin/env bash
# Build the work-in-progress app and run it, without installing anything.
#
# /Applications/PartyParty.app belongs to TestFlight and to nothing else. A
# local build put there is ad-hoc signed with no App Store receipt, and macOS
# will not let TestFlight overwrite an app whose signature does not match: it
# installs a SECOND copy called "PartyParty 2.app" instead, silently, which then
# fights the first over ports 8000 and 8443 and over its own name in every
# permission dialog. That happened on 2026-08-14 and cost a live app its slot.
#
# So the work-in-progress build never enters /Applications. It is built to
# build/PartyParty.app and launched from there. One app is installed on this
# Mac, always TestFlight's, and nothing can contest it. This replaces
# scripts/build-install-app-store-local.sh, which existed to put dev builds in
# the slot and was the cause rather than the cure.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="$ROOT/build/PartyParty.app"

# By PID, never `tell application id`: that has been observed to LAUNCH a second
# instance rather than quit the running one. Both the installed app and a
# previous run out of build/ answer here, and only one can hold port 8000.
running_pids() {
  pgrep -f '/PartyParty\.app/Contents/MacOS/PartyParty' || true
}

pids="$(running_pids)"
if [ -n "$pids" ]; then
  echo ">> quitting PartyParty (pids: $(echo "$pids" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 60); do
    [ -n "$(running_pids)" ] || break
    sleep 0.5
  done
  if [ -n "$(running_pids)" ]; then
    # shellcheck disable=SC2086
    kill -9 $(running_pids) 2>/dev/null || true
    sleep 1
  fi
fi

# The server tears down mediamtx and ffmpeg children on the way out, which can
# take a while. Launching into a port that is still draining fails confusingly.
for _ in $(seq 1 120); do
  curl -fsS --max-time 1 http://127.0.0.1:8000/api/status >/dev/null 2>&1 || break
  sleep 0.25
done
if curl -fsS --max-time 1 http://127.0.0.1:8000/api/status >/dev/null 2>&1; then
  echo "Port 8000 is still in use 30s after asking PartyParty to quit." >&2
  exit 1
fi

"$ROOT/scripts/build-app.sh"
"$ROOT/scripts/test-app-store.sh" "$APP"

open -g "$APP"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
BUILD="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$APP/Contents/Info.plist")"
echo
echo "running $APP ($VERSION build $BUILD)"
if [ -d /Applications/PartyParty.app ]; then
  echo "installed app left untouched: /Applications/PartyParty.app ($(
    /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' /Applications/PartyParty.app/Contents/Info.plist 2>/dev/null) build $(
    /usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' /Applications/PartyParty.app/Contents/Info.plist 2>/dev/null))"
fi
echo "nothing was installed, so TestFlight can still update the slot in place."
