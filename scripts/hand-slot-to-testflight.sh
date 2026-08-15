#!/usr/bin/env bash
# Give the one install slot back to TestFlight, and prove it is empty.
#
# There is ONE PartyParty on this Mac: /Applications/PartyParty.app. A local
# build put there by scripts/build-install-app-store-local.sh is ad-hoc signed
# and carries no App Store receipt, and macOS refuses to let TestFlight replace
# an app whose signature does not match. It does not warn and it does not fail:
# it installs a SECOND copy called "PartyParty 2.app", which then fights the
# first over port 8000, the menu bar, and its own name in every permission
# dialog. That is exactly what happened on 2026-08-14.
#
# So the slot has to be emptied BEFORE pressing Install in TestFlight. This
# removes a local build and nothing else: an app carrying a receipt is
# TestFlight's own and is left alone.
set -euo pipefail

APPS="${PP_INSTALL_DIR:-/Applications}"
SLOT="$APPS/PartyParty.app"

# Any stray second copy macOS already made. Named copies are always ours to
# clear: TestFlight never intends to own one.
shopt -s nullglob
STRAYS=("$APPS"/PartyParty\ [0-9].app "$APPS"/PartyParty\ [0-9][0-9].app)
shopt -u nullglob

quit_partyparty() {
  # By PID, never by bundle id: `tell application id` has been observed to
  # LAUNCH a second instance instead of quitting the running one.
  local pids
  pids="$(pgrep -f '/PartyParty[^/]*\.app/Contents/MacOS/PartyParty' || true)"
  [ -n "$pids" ] || return 0
  echo "quitting PartyParty (pids: $(echo "$pids" | tr '\n' ' '))"
  # shellcheck disable=SC2086
  kill -TERM $pids 2>/dev/null || true
  for _ in $(seq 1 40); do
    pgrep -f '/PartyParty[^/]*\.app/Contents/MacOS/PartyParty' >/dev/null || return 0
    sleep 0.5
  done
  # shellcheck disable=SC2086
  kill -9 $(pgrep -f '/PartyParty[^/]*\.app/Contents/MacOS/PartyParty') 2>/dev/null || true
  sleep 1
}

has_receipt() { [ -f "$1/Contents/_MASReceipt/receipt" ]; }

# A receipt is the only thing that distinguishes TestFlight's copy from a local
# build, and it is the copy worth keeping: deleting it would mean downloading
# the build again. So find the keeper first, then clear everything else. When a
# numbered stray turns out to be the keeper, it is promoted into the slot rather
# than removed, which is the repair the 2026-08-14 duplicate needed.
KEEPER=""
for app in "$SLOT" ${STRAYS[@]+"${STRAYS[@]}"}; do
  [ -d "$app" ] || continue
  if has_receipt "$app"; then KEEPER="$app"; break; fi
done

removed=0
for app in "$SLOT" ${STRAYS[@]+"${STRAYS[@]}"}; do
  [ -d "$app" ] || continue
  [ "$app" = "$KEEPER" ] && continue
  quit_partyparty
  echo "removing $(has_receipt "$app" && echo 'extra TestFlight copy' || echo 'local build'): $app"
  rm -rf "$app"
  removed=$((removed + 1))
done

if [ -n "$KEEPER" ] && [ "$KEEPER" != "$SLOT" ]; then
  quit_partyparty
  echo "promoting the TestFlight copy into the slot: $KEEPER -> $SLOT"
  mv "$KEEPER" "$SLOT"
fi

# Launch Services keeps serving a deleted bundle's name to permission dialogs
# until it is told, which is how a prompt can still say "PartyParty 2".
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -kill -r -domain local -domain system -domain user >/dev/null 2>&1 || true

shopt -s nullglob
LEFT=("$APPS"/PartyParty*.app)
shopt -u nullglob
echo
echo "removed $removed copy/copies. PartyParty apps in $APPS now: ${#LEFT[@]}"
for app in ${LEFT[@]+"${LEFT[@]}"}; do
  printf '  %s  (%s build %s%s)\n' "$app" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist" 2>/dev/null)" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Contents/Info.plist" 2>/dev/null)" \
    "$(has_receipt "$app" && echo ', TestFlight' || echo ', local build')"
done
if [ "${#LEFT[@]}" -gt 1 ]; then
  echo "STILL MORE THAN ONE. Do not install from TestFlight yet." >&2
  exit 1
fi
echo
if [ "${#LEFT[@]}" -eq 1 ] && has_receipt "$SLOT"; then
  echo "One app, and it is TestFlight's own. It will update in place."
else
  echo "The slot is clear. Install from TestFlight now and it will land at $SLOT."
fi
