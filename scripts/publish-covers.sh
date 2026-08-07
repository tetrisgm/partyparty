#!/usr/bin/env bash
# Put the bundled cover pile where the web can reach it.
#
# The Mac serves these out of its own binary at /covers/<name>.webp. The
# platform is a different origin with no filesystem, so the same pictures live
# in R2 under media/covers/ and are served by the app Worker's /media/ route.
# One pile, two ways of reaching it - a DJ who shuffles on the web and a DJ who
# shuffles in the app are choosing from the same set.
#
# Idempotent: uploading the same key twice replaces it with identical bytes.
# Safe to run after adding pictures to web/covers/.
set -euo pipefail

cd "$(dirname "$0")/.."
BUCKET="partyparty-dl"
WRANGLER="cloudflare/node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || WRANGLER="npx wrangler"

count=0
for file in web/covers/*.webp; do
  name="$(basename "$file")"
  printf '  %-28s' "$name"
  $WRANGLER r2 object put "$BUCKET/media/covers/$name" \
    --file "$file" --content-type image/webp --remote >/dev/null
  printf 'ok\n'
  count=$((count + 1))
done

echo
echo "$count covers published to $BUCKET/media/covers/"
echo "Reachable at https://partyparty.party/media/covers/<name>.webp"
