#!/usr/bin/env bash
# Run the platform locally: a local D1, the migrations, and the Worker.
#
# Nothing here touches the real account. The database is a file under
# cloudflare/app/.wrangler, the Worker listens on localhost, and no mail is
# sent - queued messages are readable at /dev/outbox instead.
set -euo pipefail

cd "$(dirname "$0")/../cloudflare/app"

PORT="${PORT:-8788}"
WRANGLER="../node_modules/.bin/wrangler"
[ -x "$WRANGLER" ] || WRANGLER="npx wrangler"

# DEV_LOGIN opens the two development-only doors: signing in without Apple or
# Google, and reading the outbox. wrangler reads .dev.vars for `dev` and never
# uploads it, so this cannot follow the code to production.
if [ ! -f .dev.vars ]; then
  cat > .dev.vars <<'VARS'
DEV_LOGIN=1
STATE_SECRET=local-development-only
PUBLIC_BASE=http://localhost:8788
VARS
  echo "wrote .dev.vars (development only, never deployed)"
fi

echo "==> applying migrations to the local database"
# `migrations apply`, not `execute`: wrangler records what has run, so this is
# a no-op on the second launch instead of failing on an ALTER TABLE.
$WRANGLER d1 migrations apply partyparty-app --local

cat <<INFO

==> ready. Open these in order:

    http://localhost:$PORT/dev/signin        sign in as a test DJ
    http://localhost:$PORT/manage            make a group
    http://localhost:$PORT/@<handle>         join it as a guest
    http://localhost:$PORT/dev/outbox        every email, with live links

    The outbox is how you confirm a membership, accept an invitation and reach
    the settings page - nothing is delivered in development.

INFO

exec $WRANGLER dev --local --port "$PORT"
