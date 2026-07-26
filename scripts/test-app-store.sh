#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="${1:-$ROOT/build/partyparty-app-store.app}"
if [[ "$APP" != /* ]]; then
  APP="$ROOT/$APP"
fi
STATUS_URL="http://127.0.0.1:8000/api/status"
APP_EXEC="$APP/Contents/MacOS/partyparty"
SERVER_EXEC="$APP/Contents/Helpers/partyparty-server"

"$ROOT/scripts/verify-app-store.sh" "$APP"

authority="$(/usr/bin/codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=//p' | head -1)"
if [[ "$authority" = Apple\ Distribution:* ]]; then
  echo "Apple Distribution bundle verified; runtime launch is tested after App Store installation."
  exit 0
fi

if curl -fsS --max-time 1 "$STATUS_URL" >/dev/null 2>&1; then
  echo "Port 8000 is already in use. Quit the installed partyparty before running the Store launch test." >&2
  exit 1
fi

exact_pid() {
  /bin/ps -axo pid=,command= | /usr/bin/awk -v command="$1" '
    {
      pid = $1
      sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "")
      if ($0 == command) {
        print pid
        exit
      }
    }
  '
}

terminate_exact() {
  local command="$1" pid
  pid="$(exact_pid "$command")"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 25); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -KILL "$pid" 2>/dev/null || true
}

cleanup() {
  terminate_exact "$APP_EXEC"
  terminate_exact "$SERVER_EXEC --no-open --port 8000"
}
trap cleanup EXIT

/usr/bin/open -na "$APP"

status=""
for _ in $(seq 1 40); do
  status="$(curl -fsS --max-time 1 "$STATUS_URL" 2>/dev/null || true)"
  [ -n "$status" ] && break
  sleep 0.5
done
[ -n "$status" ] || {
  echo "Store app did not expose its local console within 20 seconds." >&2
  exit 1
}

printf '%s' "$status" | /usr/bin/python3 -c '
import json, sys
s = json.load(sys.stdin)
assert s.get("appVersion"), "missing appVersion"
assert "streamUrl" not in s, "plain HTTP guest URL must not be advertised"
'

cleanup
for _ in $(seq 1 20); do
  if ! curl -fsS --max-time 1 "$STATUS_URL" >/dev/null 2>&1; then
    echo "Store launch smoke passed."
    exit 0
  fi
  sleep 0.25
done

echo "Store app quit but its server remained on port 8000." >&2
exit 1
