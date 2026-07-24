#!/usr/bin/env bash
# Local auto-ship daemon. Whenever main has NEW product work, this builds +
# notarizes + deploys the latest via scripts/ship.sh and records the release —
# automatically, in the background, so no agent ever blocks on the long
# notarization wait. Driven by launchd (net.ramine.partyparty.autoship): fires
# on a main-ref change and on a periodic backstop. Single-flight + idempotent.
#
# Doctrine (do not weaken): the newest coherent main is ALWAYS shipped. This
# script never asks and never skips a real release — it only defers while main
# is still moving or the tree is mid-edit, then ships.
#
#   scripts/auto-ship.sh                 # ship latest if there's unreleased work
#   AUTOSHIP_SHIP_ARGS=--dry-run scripts/auto-ship.sh   # exercise the logic, publish nothing
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

# launchd hands jobs a minimal PATH — give the release toolchain what it needs.
export PATH="/Users/shokunin/.nvm/versions/node/v22.19.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/Users/shokunin/.local/bin:$PATH"

LOG="$ROOT/build/auto-ship.log"
LOCKDIR="$ROOT/build/.auto-ship.lock"
DEBOUNCE="${AUTOSHIP_DEBOUNCE:-60}"   # seconds of main-quiet before shipping
SHIP_ARGS="${AUTOSHIP_SHIP_ARGS:-}"
mkdir -p "$ROOT/build"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# --- single-flight (atomic mkdir lock; flock is absent on macOS) --------------
if ! mkdir "$LOCKDIR" 2>/dev/null; then
  # Steal a stale lock from a crashed run (>30 min old); else another ship owns it.
  if [ -d "$LOCKDIR" ] && [ -z "$(find "$LOCKDIR" -maxdepth 0 -mmin -30 2>/dev/null)" ]; then
    log "removing stale lock"; rmdir "$LOCKDIR" 2>/dev/null || true
    mkdir "$LOCKDIR" 2>/dev/null || { log "lock contended, skipping"; exit 0; }
  else
    exit 0  # a ship is already running — quiet skip
  fi
fi
trap 'rmdir "$LOCKDIR" 2>/dev/null || true' EXIT

# --- gates: only ship a clean, on-main, genuinely-new state -------------------
[ "$(git rev-parse --abbrev-ref HEAD 2>/dev/null)" = "main" ] || { log "not on main, skip"; exit 0; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { log "tree dirty, skip"; exit 0; }
if git log -1 --format=%s | grep -qE '^Record partyparty .* release$'; then
  exit 0  # HEAD is already a release — nothing new (also breaks the post-ship re-trigger loop)
fi

# --- debounce: don't ship mid-sequence; wait for main to settle ---------------
before="$(git rev-parse main)"
sleep "$DEBOUNCE"
[ "$(git rev-parse main)" = "$before" ] || { log "main still moving, deferring"; exit 0; }
[ -z "$(git status --porcelain --untracked-files=no)" ] || { log "tree became dirty, deferring"; exit 0; }

# --- worker/config-only fast path: deploy the Worker, skip the native ship ----
# A commit whose ONLY changes since the last release are under cloudflare/ (the
# Worker code + its deploy config) needs just `wrangler deploy` — never a native
# rebuild, notarization, Sparkle feed flip, or version bump, because the built
# Mac app and the OTA payload are byte-identical. Doctrine: a tooling-only commit
# must not buy an identical rebuild. Conservative: divert ONLY when EVERY changed
# file since the last release is under cloudflare/; native, web-payload, script,
# or mixed changes fall through to the full ship below, unchanged. Keyed to the
# stable HEAD sha via a gitignored receipt so the periodic backstop never
# re-deploys the same commit.
auto_mode=""
last_rel="$(git log --grep='^Record partyparty .* release$' -1 --format=%H 2>/dev/null || true)"
if [ -n "$last_rel" ]; then
  changed="$(git diff --name-only "$last_rel" HEAD 2>/dev/null || true)"
  noncf="$(printf '%s\n' "$changed" | grep -vE '^cloudflare/' || true)"
  if [ -n "$changed" ] && [ -z "$noncf" ]; then
    if printf '%s' "$SHIP_ARGS" | grep -q -- '--dry-run'; then
      log "worker-only change (dry-run) — would deploy Worker + skip native ship; nothing published"
      exit 0
    fi
    head_sha="$(git rev-parse HEAD)"
    receipt="$ROOT/build/.last-worker-deploy"
    if [ "$(cat "$receipt" 2>/dev/null || true)" = "$head_sha" ]; then
      exit 0  # this commit's Worker deploy is already done — idempotent no-op
    fi
    WR="$ROOT/cloudflare/node_modules/.bin/wrangler"
    if [ -x "$WR" ]; then
      log "worker-only change since $(git rev-parse --short "$last_rel") — deploy Worker, skip native ship ($(git rev-parse --short HEAD))"
      if ( cd "$ROOT/cloudflare" && node test/smoke.mjs ) >> "$LOG" 2>&1 \
         && ( cd "$ROOT/cloudflare" && "$WR" deploy ) >> "$LOG" 2>&1; then
        printf '%s' "$head_sha" > "$receipt"
        log "worker deploy OK for $(git rev-parse --short HEAD) — no native ship"
        exit 0
      fi
      log "worker-only deploy FAILED — will retry on the next trigger"
      exit 1
    fi
    log "wrangler missing at $WR; falling through to the full ship"
  fi

  # Web-only (optionally plus Worker files): prefer the OTA payload lane. The
  # signed payload carries web/ to installed Macs within ~15 min with NO native
  # rebuild, notarization, Sparkle flip, or app-update prompt, and
  # publish-payload.sh redeploys the Worker too. Safe by construction: content
  # that needs a newer native API also bumps ota.RuntimeVersion — a .go change,
  # which lands outside web/+cloudflare/ and therefore still takes a full ship.
  nonpayload="$(printf '%s\n' "$changed" | grep -vE '^(web|cloudflare)/' || true)"
  if [ -n "$changed" ] && [ -z "$nonpayload" ]; then
    auto_mode="--payload-only"
  fi
fi

# --- ship the latest ----------------------------------------------------------
log "shipping $(git rev-parse --short HEAD)${auto_mode:+ ($auto_mode)}: $(git log -1 --format=%s)"
scripts/ship.sh $SHIP_ARGS $auto_mode >> "$LOG" 2>&1
rc=$?
if [ "$rc" -ne 0 ]; then
  log "ship.sh FAILED (exit $rc) — resetting the version bump; will retry on next trigger"
  git checkout -- CODE_MAJOR web/PAYLOAD_VERSION app/Info.plist cloudflare/worker.js 2>/dev/null || true
  exit "$rc"
fi

# Dry-run leaves version files bumped but publishes nothing — reset + stop.
if printf '%s' "$SHIP_ARGS" | grep -q -- '--dry-run'; then
  git checkout -- CODE_MAJOR web/PAYLOAD_VERSION app/Info.plist cloudflare/worker.js 2>/dev/null || true
  log "dry-run complete (nothing published)"
  exit 0
fi

# --- record the release on main (ship.sh bumps but doesn't commit) ------------
VERSION="$(tr -dc '0-9' < CODE_MAJOR).$(tr -dc '0-9' < web/PAYLOAD_VERSION)"
git add CODE_MAJOR web/PAYLOAD_VERSION app/Info.plist cloudflare/worker.js
git commit -q -m "Record partyparty $VERSION release

Auto-shipped by the local auto-ship daemon.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
if git push origin main >> "$LOG" 2>&1; then
  log "shipped + recorded v$VERSION, pushed"
else
  log "shipped v$VERSION but push failed — will reconcile on next trigger"
fi
