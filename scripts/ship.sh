#!/usr/bin/env bash
# One-command partyparty ship entry point. This is the owner-facing command:
# choose the next product version, verify, publish versioned artifacts first,
# then let the lower-level release scripts flip app/update feeds last.
#
# Usage:
#   scripts/ship.sh                       # full native app release, bumps X in X.Y
#   scripts/ship.sh 29.52                 # explicit full native app release
#   scripts/ship.sh --payload-only        # OTA web payload release, bumps Y in X.Y
#   scripts/ship.sh 28.53 --payload-only  # explicit OTA web payload release
#   scripts/ship.sh --dry-run             # verify/plan only, publish nothing
#   scripts/ship.sh --allow-dirty
#   scripts/ship.sh --skip-tests
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

MODE="app"
VERSION=""
ALLOW_DIRTY=0
SKIP_TESTS=0
DRY_RUN=0

usage() {
  sed -n '1,12p' "$0" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --app|--full) MODE="app" ;;
    --payload-only|--ota-only) MODE="payload" ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run|--no-publish) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    -*)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
    *)
      if [ -n "$VERSION" ]; then
        echo "Only one version may be supplied." >&2
        exit 1
      fi
      VERSION="$1"
      ;;
  esac
  shift
done

read_num() {
  local file="$1"
  tr -dc '0-9' < "$file"
}

CURRENT_CODE="$(read_num CODE_MAJOR)"
CURRENT_PAYLOAD="$(read_num web/PAYLOAD_VERSION)"
[ -n "$CURRENT_CODE" ] || { echo "CODE_MAJOR is empty/non-numeric" >&2; exit 1; }
[ -n "$CURRENT_PAYLOAD" ] || { echo "web/PAYLOAD_VERSION is empty/non-numeric" >&2; exit 1; }

if [ -z "$VERSION" ]; then
  if [ "$MODE" = "payload" ]; then
    VERSION="$CURRENT_CODE.$((CURRENT_PAYLOAD + 1))"
  else
    # Collision-proof: the next code is max(source, published) + 1. A ship that
    # published a higher version but failed before committing the source bump (or
    # had it reset) must not recompute a version that isn't newer than what's
    # already public — that deadlocks the "newer than installed/published" gate.
    PUB_CODE="$(curl -s --max-time 8 https://partyparty.party/api/version 2>/dev/null | grep -oE '"version":"[0-9]+' | grep -oE '[0-9]+$' | head -1)"
    BASE_CODE="$CURRENT_CODE"
    if [ -n "$PUB_CODE" ] && [ "$PUB_CODE" -gt "$BASE_CODE" ] 2>/dev/null; then BASE_CODE="$PUB_CODE"; fi
    VERSION="$((BASE_CODE + 1)).$CURRENT_PAYLOAD"
  fi
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "Version must be two numeric components, e.g. 29.52; got: $VERSION" >&2
  exit 1
fi

IFS=. read -r NEXT_CODE NEXT_PAYLOAD <<< "$VERSION"
if [ "$MODE" = "payload" ] && [ "$NEXT_CODE" != "$CURRENT_CODE" ]; then
  echo "Payload-only ships cannot change the code component ($CURRENT_CODE -> $NEXT_CODE)." >&2
  echo "Use scripts/ship.sh $VERSION for a full app release." >&2
  exit 1
fi

if [ "$ALLOW_DIRTY" != "1" ] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  dirty="$(git status --porcelain --untracked-files=no)"
  if [ -n "$dirty" ]; then
    echo "Refusing to ship with dirty tracked files. Commit or pass --allow-dirty." >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
fi

set_version_files() {
  printf '%s\n' "$NEXT_CODE" > CODE_MAJOR
  printf '%s\n' "$NEXT_PAYLOAD" > web/PAYLOAD_VERSION
  python3 - "$VERSION" <<'PY'
import datetime
import re
import sys
from pathlib import Path

version = sys.argv[1]
p = Path("cloudflare/worker.js")
s = p.read_text()
s2, n = re.subn(r'const APP_VERSION = "[^"]+";', f'const APP_VERSION = "{version}";', s, count=1)
if n != 1:
    raise SystemExit("cloudflare/worker.js APP_VERSION constant not found")
s3, n = re.subn(r'const APP_VERSION_DATE = "[^"]+";',
                f'const APP_VERSION_DATE = "{datetime.date.today().isoformat()}";', s2, count=1)
if n != 1:
    raise SystemExit("cloudflare/worker.js APP_VERSION_DATE constant not found")
p.write_text(s3)
PY
}

verify_go() {
  go build ./...
  go vet ./...
  local gofmt_out
  gofmt_out="$(gofmt -l .)"
  if [ -n "$gofmt_out" ]; then
    echo "$gofmt_out" >&2
    echo "gofmt -l . printed files; run gofmt before shipping." >&2
    exit 1
  fi
  go test ./...
}

verify_worker() {
  ( cd cloudflare && node test/smoke.mjs )
}

verify_stream_contract() {
  node scripts/test-stream-contract.mjs
  node scripts/test-session-log-analyzer.mjs
}

verify_swift() {
  node scripts/test-menu-bar-contract.mjs
  ( cd app && swift build )
}

echo ">> ship partyparty $VERSION ($MODE)"

if [ "$DRY_RUN" != "1" ]; then
  set_version_files
fi

if [ "$SKIP_TESTS" != "1" ]; then
  echo ">> verify Go"
  verify_go
  echo ">> verify Worker"
  verify_worker
  echo ">> verify streaming contract"
  verify_stream_contract
  if [ "$MODE" = "app" ]; then
    echo ">> verify Swift"
    verify_swift
  fi
fi

if [ "$DRY_RUN" = "1" ]; then
  echo ">> dry-run: would set CODE_MAJOR=$NEXT_CODE, web/PAYLOAD_VERSION=$NEXT_PAYLOAD, and Worker APP_VERSION=$VERSION"
  if [ "$MODE" = "payload" ]; then
    echo ">> dry-run: would publish signed OTA payload via scripts/publish-payload.sh"
  else
    echo ">> dry-run: would publish native app via scripts/release.sh"
  fi
  echo
  echo "Dry-run complete; nothing built for release and nothing published."
  exit 0
fi

if [ "$MODE" = "payload" ]; then
  echo ">> publish OTA payload $VERSION"
  "$ROOT/scripts/publish-payload.sh"
else
  echo ">> publish native app $VERSION"
  "$ROOT/scripts/release.sh"
fi

echo
echo "Shipped partyparty $VERSION"
