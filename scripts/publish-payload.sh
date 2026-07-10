#!/usr/bin/env bash
# Ship an over-the-air PAYLOAD — the web content (player, DJ console, vendored
# libs, config.json of flags/tunables) — WITHOUT cutting an app release. Every
# DJ's Mac fetches, verifies, and serves it within ~15 minutes; guests get it
# on their next page load. No Sparkle, no relaunch.
#
# This is the "minor version" path. The owner-facing scripts/ship.sh
# --payload-only command bumps web/PAYLOAD_VERSION and then calls this. Reach
# for scripts/ship.sh (the "major"/container path) only when the native app or
# its API changed — i.e. when you also bumped ota.RuntimeVersion.
#
# Security: the payload is executable JS we hand to guests' phones, so the
# manifest is ed25519-signed with the private key at
#   ~/Library/Application Support/partyparty/payload-ed25519.seed
# (never in the repo), and the bundle bytes are pinned by a SHA-256 the signed
# manifest carries. The Mac verifies both before serving and refuses downgrades.
#
# Lower-level implementation detail. Always invoke through:
#   scripts/ship.sh --payload-only
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
BUCKET="partyparty-dl"
WR="$ROOT/cloudflare/node_modules/.bin/wrangler"
SEED="$HOME/Library/Application Support/partyparty/payload-ed25519.seed"
BASE="${PARTYPARTY_BASE:-https://party.ramine.net}"

VERSION="$(tr -dc '0-9' < web/PAYLOAD_VERSION)"
MINRUNTIME="$(grep -oE 'RuntimeVersion = [0-9]+' internal/ota/ota.go | grep -oE '[0-9]+' | head -1)"
[ -n "$VERSION" ]    || { echo "web/PAYLOAD_VERSION is empty/non-numeric"; exit 1; }
[ -n "$MINRUNTIME" ] || { echo "could not read RuntimeVersion from internal/ota/ota.go"; exit 1; }
[ -f "$SEED" ]       || { echo "signing key missing: $SEED"; exit 1; }
[ -x "$WR" ]         || { echo "wrangler missing — run: (cd cloudflare && npm install)"; exit 1; }
"$WR" whoami >/dev/null 2>&1 || { echo "Not logged in — run: (cd cloudflare && npx wrangler login)"; exit 1; }
command -v python3 >/dev/null || { echo "python3 required for ed25519 signing"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
BUNDLE="$WORK/payload-$VERSION.tar.gz"
URL="$BASE/content/payload-$VERSION.tar.gz"

echo ">> [1/5] build bundle from web/ (payload v$VERSION, minRuntime $MINRUNTIME)"
# Exactly what the Mac serves — the contents of web/, no web/ prefix. Skip
# macOS cruft so the bundle is clean.
tar --exclude='.DS_Store' --exclude='._*' -czf "$BUNDLE" -C web .
SHA="$(shasum -a 256 "$BUNDLE" | awk '{print $1}')"
echo "   sha256=$SHA  size=$(wc -c < "$BUNDLE" | tr -d ' ')B"

echo ">> [2/5] sign manifest (ed25519)"
# The signed message must match ota.manifest.signedMessage() byte-for-byte:
# "partyparty-payload-v1\n<ver>\n<minRuntime>\n<url>\n<sha>" (NO trailing \n).
SIG="$(
  MSG="$(printf 'partyparty-payload-v1\n%s\n%s\n%s\n%s' "$VERSION" "$MINRUNTIME" "$URL" "$SHA")" \
  SEED_PATH="$SEED" python3 - <<'PY'
import base64, os, sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
seed = open(os.environ["SEED_PATH"], "rb").read()
if len(seed) != 32:
    sys.exit("seed must be 32 raw bytes")
k = Ed25519PrivateKey.from_private_bytes(seed)
sig = k.sign(os.environ["MSG"].encode())
print(base64.b64encode(sig).decode())
PY
)"
[ -n "$SIG" ] || { echo "signing failed"; exit 1; }

MANIFEST="$WORK/manifest.json"
cat > "$MANIFEST" <<JSON
{
  "payloadVersion": $VERSION,
  "minRuntime": $MINRUNTIME,
  "url": "$URL",
  "sha256": "$SHA",
  "sig": "$SIG"
}
JSON

echo ">> [3/5] upload versioned bundle"
"$WR" r2 object put "$BUCKET/content/payload-$VERSION.tar.gz" --file "$BUNDLE"   --content-type application/gzip --remote

echo ">> [4/5] deploy Worker (idempotent — ensures the /content/ route is live)"
( cd cloudflare && "$WR" deploy )

echo ">> [5/5] flip signed payload manifest"
"$WR" r2 object put "$BUCKET/content/manifest.json"           --file "$MANIFEST" --content-type application/json --remote

echo
echo "Published payload v$VERSION (minRuntime $MINRUNTIME)"
echo "  manifest: $BASE/content/manifest.json"
echo "  bundle:   $URL"
echo "  Macs on runtime >= $MINRUNTIME adopt it within ~15 min; older ones wait for an app update."
