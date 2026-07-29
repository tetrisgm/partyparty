#!/usr/bin/env bash
# The autoship daemon: commits land on main, releases happen. No agent session
# foregrounds a ship, watches one, or forgets one.
#
# Run by launchd (net.ramine.partyparty.autoship) every two minutes. Each pass
# is bounded, locked, and quiet when there is nothing to do:
#
#   1. Fetch the canonical repo's main into a DEDICATED clone. The canonical
#      worktree belongs to whoever is editing it; this daemon never touches it.
#   2. New commit? Wait one tick (debounce, so a burst of pushes builds once),
#      then ship it with the standard ship script, wall-clock capped, stdin
#      closed.
#   3. Judge the outcome by the ship RECEIPT, not the log tail, and remember it.
#      Three failures on the same commit holds that commit (a paid build per
#      retry is money) until a new commit supersedes it.
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
MAX_FAILURES=3

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
SHIPPED="$(state_get shipped)"
if [ -z "$SHIPPED" ]; then
  # First run. What is on main right now is presumed already published (it was
  # shipped by whoever set this up); the daemon owns everything after.
  state_set shipped "$TARGET"
  log "initialized at $TARGET"
  exit 0
fi
[ "$TARGET" = "$SHIPPED" ] && exit 0

# Debounce: ship a commit only after it has survived one full tick, so a burst
# of pushes becomes one build of the final state instead of a build per push.
CANDIDATE="$(state_get candidate)"
if [ "$TARGET" != "$CANDIDATE" ]; then
  state_set candidate "$TARGET"
  log "candidate $TARGET; waiting one tick"
  exit 0
fi

# Bounded retry: a commit that failed three paid builds is held, loudly, until a
# new commit supersedes it. Retrying a deterministic failure forever is a bill.
FAILED_SHA="$(state_get failedSha)"
FAILURES="$(state_get failures)"; FAILURES="${FAILURES:-0}"
if [ "$FAILED_SHA" = "$TARGET" ] && [ "$FAILURES" -ge "$MAX_FAILURES" ]; then
  if [ "$(state_get heldNotified)" != "$TARGET" ]; then
    state_set heldNotified "$TARGET"
    log "HOLD: $TARGET failed $FAILURES ships; waiting for a new commit"
    osascript -e 'display notification "Autoship is holding a failing commit. See autoship.log." with title "partyparty autoship"' 2>/dev/null || true
  fi
  exit 0
fi

log "shipping $TARGET"
git -C "$CLONE" reset --quiet --hard "$TARGET"
git -C "$CLONE" clean --quiet -fdx -e app/.build -e cloudflare/node_modules -e dist

# Clone-local toolchain pieces the ship needs.
if [ ! -d "$CLONE/cloudflare/node_modules" ]; then
  log "installing cloudflare node_modules"
  (cd "$CLONE/cloudflare" && npm ci --no-audit --no-fund >>"$LOG" 2>&1)
fi

set +e
"$RUN_CAPPED" --seconds "$SHIP_CAP_SECONDS" --label autoship -- \
  "$CLONE/scripts/ship-standalone.sh" >>"$LOG" 2>&1 </dev/null
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

if [ "$STATUS" = "success" ]; then
  state_set shipped "$TARGET"
  state_set failedSha ""
  state_set failures 0
  log "shipped $TARGET as $DETAIL"
else
  if [ "$FAILED_SHA" = "$TARGET" ]; then FAILURES=$((FAILURES + 1)); else FAILURES=1; fi
  state_set failedSha "$TARGET"
  state_set failures "$FAILURES"
  log "ship failed (exit $SHIP_EXIT, attempt $FAILURES) for $TARGET"
fi
