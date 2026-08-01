#!/usr/bin/env bash
# The autoship daemon: commits land on main, releases happen. No agent session
# foregrounds a ship, watches one, or forgets one.
#
# Run by launchd (net.ramine.partyparty.autoship) every five minutes. Each pass
# is bounded, locked, and quiet when there is nothing to do:
#
#   1. Fetch the canonical repo's main into a DEDICATED clone. The canonical
#      worktree belongs to whoever is editing it; this daemon never touches it.
#   2. Wait until HEAD has been quiet for 15 minutes. Build only that settled
#      tip, Developer ID sign it, and install it locally without notarization.
#   3. At most once per day, notarize and publish the newest settled tip for
#      other standalone-beta Macs. Apple Store/TestFlight delivery is separate.
#
# The ship script derives version and build from what is published, and a ship
# no longer edits any source, so this clone stays clean and nothing needs
# pushing back. State lives outside the repo and survives reboots; the launchd
# job survives credit exhaustion, session ends, and everything else, which is
# the point.
set -euo pipefail

CANONICAL="${PP_AUTOSHIP_SOURCE:-/Users/shokunin/dev/partyparty}"
STATE_DIR="${PP_AUTOSHIP_STATE:-$HOME/Library/Application Support/partyparty-autoship}"
CLONE="$STATE_DIR/clone"
LOG="$STATE_DIR/autoship.log"
RUN_CAPPED="/Users/shokunin/dev/stack/bin/run-capped"
SHIP_CAP_SECONDS=3600
LOCAL_CAP_SECONDS=1800
MAX_FAILURES=1
QUIET_SECONDS="${PP_AUTOSHIP_QUIET_SECONDS:-900}"
PUBLIC_INTERVAL_SECONDS="${PP_AUTOSHIP_PUBLIC_INTERVAL_SECONDS:-86400}"

# launchd environments are minimal by design; pin what the toolchain needs.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >>"$LOG"; }

# The off switch: touch this file to pause autoshipping without unloading the job.
[ -e "$STATE_DIR/off" ] && exit 0

# One lane, stale-safe. macOS ships no flock, so this is a directory mutex that
# a dead owner cannot wedge: the pid inside names the owner, and a lock whose
# owner is gone is reclaimed.
LOCK_DIR="$STATE_DIR/lock.d"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  OWNER="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -n "$OWNER" ] && kill -0 "$OWNER" 2>/dev/null; then exit 0; fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || exit 0
fi
echo $$ >"$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

state_get() { python3 -c "
import json,sys
try: print(json.load(open('$STATE_DIR/state.json')).get(sys.argv[1],''))
except Exception: print('')
" "$1"; }
state_set() { python3 -c "
import json,sys
path='$STATE_DIR/state.json'
try: state=json.load(open(path))
except Exception: state={}
state[sys.argv[1]]=sys.argv[2]
json.dump(state,open(path+'.tmp','w'))
import os; os.replace(path+'.tmp',path)
" "$1" "$2"; }

# The dedicated clone, created once.
if [ ! -d "$CLONE/.git" ]; then
  log "creating clone from $CANONICAL"
  git clone --quiet "$CANONICAL" "$CLONE"
fi

git -C "$CLONE" fetch --quiet origin
TARGET="$(git -C "$CLONE" rev-parse origin/main)"
LEGACY_SHIPPED="$(state_get shipped)"
INSTALLED="$(state_get installed)"
PUBLISHED="$(state_get published)"
if [ -z "$INSTALLED" ] && [ -n "$LEGACY_SHIPPED" ]; then
  state_set installed "$LEGACY_SHIPPED"
  INSTALLED="$LEGACY_SHIPPED"
fi
if [ -z "$PUBLISHED" ] && [ -n "$LEGACY_SHIPPED" ]; then
  state_set published "$LEGACY_SHIPPED"
  state_set lastPublicAt "$(date +%s)"
  PUBLISHED="$LEGACY_SHIPPED"
fi
if [ -z "$INSTALLED" ]; then
  # First run. What is on main right now is presumed already published (it was
  # shipped by whoever set this up); the daemon owns everything after.
  state_set installed "$TARGET"
  state_set published "$TARGET"
  state_set lastPublicAt "$(date +%s)"
  log "initialized at $TARGET"
  exit 0
fi

# Controller and documentation changes do not alter product bytes. Advance each
# lane independently so a tooling-only commit never spends a build,
# notarization, upload, or deployment.
PRODUCT_PATHS=(main.go go.mod go.sum app assets cloudflare cmd internal web)
product_changed_since() {
  local baseline="$1"
  [ -z "$baseline" ] && return 0
  git -C "$CLONE" merge-base --is-ancestor "$baseline" "$TARGET" 2>/dev/null ||
    return 0
  ! git -C "$CLONE" diff --quiet "$baseline" "$TARGET" -- "${PRODUCT_PATHS[@]}"
}
if [ "$TARGET" != "$INSTALLED" ] && ! product_changed_since "$INSTALLED"; then
  state_set installed "$TARGET"
  INSTALLED="$TARGET"
  log "advanced local marker across tooling-only source $TARGET"
fi
if [ "$TARGET" != "$PUBLISHED" ] && ! product_changed_since "$PUBLISHED"; then
  state_set published "$TARGET"
  PUBLISHED="$TARGET"
  log "advanced public marker across tooling-only source $TARGET"
fi
[ "$TARGET" = "$INSTALLED" ] && [ "$TARGET" = "$PUBLISHED" ] && exit 0

# Debounce by commit age, not polling ticks. A burst of pushes produces one
# build of the tip that survives the full quiet window.
TARGET_EPOCH="$(git -C "$CLONE" show -s --format=%ct "$TARGET")"
TARGET_AGE=$(( $(date +%s) - TARGET_EPOCH ))
if [ "$TARGET_AGE" -lt "$QUIET_SECONDS" ]; then
  log "debounce: $TARGET is ${TARGET_AGE}s old (< ${QUIET_SECONDS}s)"
  exit 0
fi

# A failed settled commit is held after one attempt until new source supersedes
# it. Re-running the same expensive deterministic build is waste, not recovery.
FAILED_SHA="$(state_get failedSha)"
FAILURES="$(state_get failures)"; FAILURES="${FAILURES:-0}"
if [ "$FAILED_SHA" = "$TARGET" ] && [ "$FAILURES" -ge "$MAX_FAILURES" ]; then
  if [ "$(state_get heldNotified)" != "$TARGET" ]; then
    state_set heldNotified "$TARGET"
    log "HOLD: $TARGET failed $FAILURES ships; waiting for a new commit"
    osascript -e 'display notification "Autoship is holding a failing commit. See autoship.log." with title "PartyParty autoship"' 2>/dev/null || true
  fi
  exit 0
fi

git -C "$CLONE" reset --quiet --hard "$TARGET"
git -C "$CLONE" clean --quiet -fdx -e app/.build -e cloudflare/node_modules -e dist

# Clone-local toolchain pieces the ship needs.
if [ ! -d "$CLONE/cloudflare/node_modules" ]; then
  log "installing cloudflare node_modules"
  (cd "$CLONE/cloudflare" && npm ci --no-audit --no-fund >>"$LOG" 2>&1)
fi

# The bundled binaries (ffmpeg, mediamtx) are deliberately not in git, so a
# fresh clone has none and the build dies at the copy step; the canonical repo
# is the local source of truth for them. Mirrored on every pass so an upgraded
# binary propagates, at local-disk cost only when something changed.
rsync -a --delete --include="ffmpeg" --include="mediamtx" --include="ppcapture" \
  --exclude="*" "$CANONICAL/assets/" "$CLONE/assets/" >>"$LOG" 2>&1

NEXT_VERSION="$(curl -fsS --max-time 20 https://partyparty.party/appcast.xml |
  grep -oE '<sparkle:shortVersionString>[0-9.]+</sparkle:shortVersionString>' |
  grep -oE '[0-9.]+' |
  tail -1)"
NEXT_BUILD="$(curl -fsS --max-time 20 https://partyparty.party/appcast.xml |
  grep -oE '<sparkle:version>[0-9]+</sparkle:version>' |
  grep -oE '[0-9]+' |
  tail -1)"
[ -n "$NEXT_VERSION" ] && [ -n "$NEXT_BUILD" ] || {
  log "cannot derive local version/build from the public appcast"
  exit 75
}
NEXT_VERSION="$(python3 - "$NEXT_VERSION" <<'PY'
import sys
parts = [int(value) for value in sys.argv[1].split(".")]
parts[-1] += 1
print(".".join(map(str, parts)))
PY
)"
NEXT_BUILD=$((NEXT_BUILD + 1))

NOW="$(date +%s)"
LAST_PUBLIC_AT="$(state_get lastPublicAt)"; LAST_PUBLIC_AT="${LAST_PUBLIC_AT:-0}"
PUBLIC_ATTEMPT_SHA="$(state_get publicAttemptSha)"
PUBLIC_ATTEMPT_AT="$(state_get publicAttemptAt)"; PUBLIC_ATTEMPT_AT="${PUBLIC_ATTEMPT_AT:-0}"
PUBLIC_DUE=0
if [ "$TARGET" != "$PUBLISHED" ] && [ $((NOW - LAST_PUBLIC_AT)) -ge "$PUBLIC_INTERVAL_SECONDS" ]; then
  if [ "$PUBLIC_ATTEMPT_SHA" != "$TARGET" ] || [ $((NOW - PUBLIC_ATTEMPT_AT)) -ge "$PUBLIC_INTERVAL_SECONDS" ]; then
    PUBLIC_DUE=1
  fi
fi

if [ "$PUBLIC_DUE" = "0" ] && [ "$TARGET" = "$INSTALLED" ]; then exit 0; fi

set +e
if [ "$PUBLIC_DUE" = "1" ]; then
  log "public ship $TARGET as $NEXT_VERSION $NEXT_BUILD"
  state_set publicAttemptSha "$TARGET"
  state_set publicAttemptAt "$NOW"
  "$RUN_CAPPED" --seconds "$SHIP_CAP_SECONDS" --label autoship-public -- \
    env PP_VERSION="$NEXT_VERSION" PP_BUILD="$NEXT_BUILD" \
    "$CLONE/scripts/ship-standalone.sh" >>"$LOG" 2>&1 </dev/null
else
  log "local install $TARGET as $NEXT_VERSION $NEXT_BUILD"
  "$RUN_CAPPED" --seconds "$LOCAL_CAP_SECONDS" --label autoship-local -- \
    env PP_VERSION="$NEXT_VERSION" PP_BUILD="$NEXT_BUILD" \
    "$CLONE/scripts/build-install-standalone-local.sh" >>"$LOG" 2>&1 </dev/null
fi
SHIP_EXIT=$?
set -e

# Keep only the newest few release payloads in the clone; receipts stay.
ls -1dt "$CLONE"/dist/standalone-* 2>/dev/null | tail -n +4 | xargs rm -rf 2>/dev/null || true

# The receipt is the outcome. Logs are for humans; this file is the state.
RECEIPT="$CLONE/dist/receipts/latest.json"
VERDICT="$(python3 -c "
import json,sys
try:
    r=json.load(open('$RECEIPT'))
    print('success' if r.get('status')=='success' and r.get('commit')=='$TARGET' else 'failed')
    print(r.get('version',''),r.get('build',''))
except Exception:
    print('failed'); print('','')
" )"
STATUS="$(printf '%s' "$VERDICT" | sed -n 1p)"
DETAIL="$(printf '%s' "$VERDICT" | sed -n 2p)"

if [ "$PUBLIC_DUE" = "1" ] && [ "$STATUS" = "success" ]; then
  state_set published "$TARGET"
  state_set shipped "$TARGET"
  state_set lastPublicAt "$(date +%s)"
  state_set failedSha ""
  state_set failures 0
  if "$CLONE/scripts/install-standalone-local.sh" "$CLONE/build/PartyParty-Beta.app" >>"$LOG" 2>&1; then
    state_set installed "$TARGET"
  else
    log "public ship succeeded but local install failed for $TARGET"
  fi
  log "shipped $TARGET as $DETAIL"
elif [ "$PUBLIC_DUE" = "0" ] && [ "$SHIP_EXIT" = "0" ]; then
  state_set installed "$TARGET"
  state_set failedSha ""
  state_set failures 0
  log "installed $TARGET locally as $NEXT_VERSION $NEXT_BUILD"
else
  if [ "$FAILED_SHA" = "$TARGET" ]; then FAILURES=$((FAILURES + 1)); else FAILURES=1; fi
  state_set failedSha "$TARGET"
  state_set failures "$FAILURES"
  log "ship failed (exit $SHIP_EXIT, attempt $FAILURES) for $TARGET"
fi
