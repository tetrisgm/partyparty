#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
APP="${1:-$ROOT/build/partyparty-app-store.app}"
if [[ "$APP" != /* ]]; then
  APP="$ROOT/$APP"
fi
STATUS_URL="http://127.0.0.1:8000/api/status"

"$ROOT/scripts/verify-app-store.sh" "$APP"

if curl -fsS --max-time 1 "$STATUS_URL" >/dev/null 2>&1; then
  echo "Port 8000 is already in use. Quit the installed partyparty before running the Store launch test." >&2
  exit 1
fi

cleanup() {
  /usr/bin/osascript -e 'tell application id "fm.partyparty.app" to quit' >/dev/null 2>&1 || true
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
assert s.get("delivery") in {"hls", "llhls"}, "missing internal delivery state"
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
