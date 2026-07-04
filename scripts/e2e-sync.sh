#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"

TEST_ID="${E2E_INSTALL_ID:-e2e5eed00001}"
TEST_SECRET="${E2E_INSTALL_SECRET:-e2e-local-secret-not-prod}"
TEST_INSTALL_SLUG="${E2E_INSTALL_SLUG:-e2e-install-local}"
TEST_EVENT_SLUG="${E2E_EVENT_SLUG:-e2e-sync-local}"
PORT="${E2E_SYNC_PORT:-8787}"
BASE_URL="http://127.0.0.1:${PORT}"

WRANGLER="${ROOT}/cloudflare/node_modules/.bin/wrangler"
if [[ ! -x "$WRANGLER" ]]; then
  WRANGLER="$(command -v wrangler || true)"
fi
if [[ -z "$WRANGLER" || ! -x "$WRANGLER" ]]; then
  echo "FAIL: wrangler missing. Run: (cd cloudflare && npm install)"
  exit 1
fi

TMP="$(mktemp -d "${TMPDIR:-/tmp}/partyparty-e2e-sync.XXXXXX")"
EVENT_BASE="${TMP}/events"
PERSIST="${TMP}/wrangler-state"
WRANGLER_LOG="${TMP}/wrangler.log"
BROKER_JSON="${TMP}/broker.json"
BROKER_SLUG="${TMP}/broker-slug.txt"
EVENT_HTML="${TMP}/event.html"
WRANGLER_PID=""

cleanup() {
  status=$?
  if [[ -n "$WRANGLER_PID" ]] && kill -0 "$WRANGLER_PID" 2>/dev/null; then
    kill "$WRANGLER_PID" 2>/dev/null || true
    wait "$WRANGLER_PID" 2>/dev/null || true
  fi
  if [[ $status -ne 0 ]]; then
    echo
    echo "FAIL: e2e sync harness failed at exit status ${status}"
    if [[ -f "$WRANGLER_LOG" ]]; then
      echo "--- wrangler log tail ---"
      tail -120 "$WRANGLER_LOG" || true
      echo "--- end wrangler log tail ---"
    fi
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

step() {
  echo
  echo ">> $*"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

step "using isolated temp root: ${TMP}"
echo "   local worker: ${BASE_URL}"
echo "   test id: ${TEST_ID}"
echo "   test secret: ${TEST_SECRET}"
echo "   test install slug: ${TEST_INSTALL_SLUG}"
echo "   test event slug: ${TEST_EVENT_SLUG}"

step "starting local Wrangler worker"
(
  cd "${ROOT}/cloudflare"
  "$WRANGLER" dev \
    --local \
    --port "$PORT" \
    --persist-to "$PERSIST" \
    --show-interactive-dev-session=false \
    --log-level warn \
    --var "BROKER_BASE:127.0.0.1:${PORT}" \
    --var "CF_ZONE_ID:e2e-local-zone" \
    --var "CF_DNS_TOKEN:e2e-local-token"
) >"$WRANGLER_LOG" 2>&1 &
WRANGLER_PID=$!

for _ in $(seq 1 120); do
  if curl -fsS "${BASE_URL}/api/broker/ping" >/dev/null 2>&1; then
    echo "   worker is responding"
    break
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "FAIL: wrangler exited before it responded"
    exit 1
  fi
  sleep 0.5
done
curl -fsS "${BASE_URL}/api/broker/ping" >/dev/null

step "applying D1 schema to isolated local D1"
"$WRANGLER" d1 execute partyparty-events \
  --config "${ROOT}/cloudflare/wrangler.jsonc" \
  --local \
  --persist-to "$PERSIST" \
  --file "${ROOT}/cloudflare/schema.sql"

if [[ -d "${ROOT}/cloudflare/migrations" ]]; then
  if grep -q "ALTER TABLE posts ADD COLUMN author_user_id" "${ROOT}/cloudflare/schema.sql"; then
    echo "   schema.sql already includes current migrations; skipping cloudflare/migrations/*.sql duplicate ALTERs"
  else
    for migration in "${ROOT}"/cloudflare/migrations/*.sql; do
      [[ -e "$migration" ]] || continue
      echo "   applying $(basename "$migration")"
      "$WRANGLER" d1 execute partyparty-events \
        --config "${ROOT}/cloudflare/wrangler.jsonc" \
        --local \
        --persist-to "$PERSIST" \
        --file "$migration"
    done
  fi
fi

step "seeding local R2 broker credentials"
printf '{"secret":"%s","slug":"%s","created":0}\n' "$(json_escape "$TEST_SECRET")" "$(json_escape "$TEST_INSTALL_SLUG")" >"$BROKER_JSON"
printf '%s' "$TEST_ID" >"$BROKER_SLUG"
"$WRANGLER" r2 object put "partyparty-dl/broker/${TEST_ID}.json" \
  --config "${ROOT}/cloudflare/wrangler.jsonc" \
  --local \
  --persist-to "$PERSIST" \
  --file "$BROKER_JSON" \
  --content-type application/json
"$WRANGLER" r2 object put "partyparty-dl/broker/slug/${TEST_INSTALL_SLUG}" \
  --config "${ROOT}/cloudflare/wrangler.jsonc" \
  --local \
  --persist-to "$PERSIST" \
  --file "$BROKER_SLUG" \
  --content-type text/plain

step "seeding event row through local publish-meta"
curl -fsS -X POST "${BASE_URL}/api/broker/publish-meta" \
  -H "content-type: application/json" \
  --data-binary @- >/dev/null <<JSON
{
  "id": "${TEST_ID}",
  "secret": "$(json_escape "$TEST_SECRET")",
  "slug": "${TEST_EVENT_SLUG}",
  "title": "E2E Sync Harness",
  "host": "Local Test DJ",
  "starts": "now",
  "where": "local wrangler",
  "tagline": "local-only sync harness",
  "about": "Created by scripts/e2e-sync.sh against local Wrangler only.",
  "duration_ms": 0,
  "size_bytes": 0,
  "recorded_ms": 0
}
JSON

step "running Go helper against local worker"
go run ./cmd/e2e-sync \
  -event-dir "$EVENT_BASE" \
  -base-url "$BASE_URL" \
  -id "$TEST_ID" \
  -secret "$TEST_SECRET" \
  -install-slug "$TEST_INSTALL_SLUG" \
  -slug "$TEST_EVENT_SLUG"

step "asserting rendered /e/${TEST_EVENT_SLUG}"
curl -fsS "${BASE_URL}/e/${TEST_EVENT_SLUG}" -o "$EVENT_HTML"
grep -Fq "E2E_SYNC_POST_TEXT local-first bytes landed" "$EVENT_HTML"
grep -Fq "E2E_SYNC_COMMENT_TEXT comment landed" "$EVENT_HTML"
if ! grep -Fq "/event/${TEST_EVENT_SLUG}/media/" "$EVENT_HTML" && ! grep -Fq "e2e-pixel.png" "$EVENT_HTML"; then
  echo "FAIL: rendered event page did not contain a media reference"
  exit 1
fi

echo
echo "PASS: local-first sync e2e harness completed"
echo "Run again with: scripts/e2e-sync.sh"
