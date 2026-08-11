#!/usr/bin/env bash
# Adopt PartyParty's OWN OAuth identities, so it stops sharing them with
# clubclub.
#
# Both products were built from one Google client and one Apple Services ID
# (fm.partyparty.web), which is why every hostname move needs a console visit
# and why either product could invalidate the other's sign-in. Creating the
# replacements is console work - Google exposes no public API for OAuth web
# clients, and an Apple Services ID's return URLs are absent from the App Store
# Connect API (its APPLE_ID_AUTH capability carries no settings). Everything
# AFTER creating them is this script.
#
#   scripts/adopt-oauth-client.sh \
#       --google-client-id 1234-abc.apps.googleusercontent.com \
#       --google-secret-file ~/Downloads/client_secret_….json \
#       --apple-service-id fm.partyparty.live
#
# Any subset works; omitted providers are left exactly as they are. The secret
# is read from the file and piped to wrangler - it is never an argument, so it
# stays out of the process list and the shell history.
set -euo pipefail
cd "$(dirname "$0")/.."
APP=cloudflare/app
CONF="$APP/wrangler.jsonc"

# The identities clubclub is using. Adopting one of these would not be a split.
SHARED_GOOGLE="325964451960-8g7u6sf5fb3ib8u6aq11cuusk64fn9dk.apps.googleusercontent.com"
SHARED_APPLE="fm.partyparty.web"

GID="" GSEC="" ASID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --google-client-id) GID="$2"; shift 2 ;;
    --google-secret-file) GSEC="$2"; shift 2 ;;
    --apple-service-id) ASID="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done
[ -n "$GID$GSEC$ASID" ] || { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 64; }

base=$(/usr/bin/grep -oE '"PUBLIC_BASE":[[:space:]]*"[^"]+"' "$CONF" | /usr/bin/sed 's/.*"\(https[^"]*\)"/\1/')
[ -n "$base" ] || { echo "no PUBLIC_BASE in $CONF" >&2; exit 1; }
echo "public base: $base"

if [ -n "$GID" ]; then
  [ "$GID" = "$SHARED_GOOGLE" ] && { echo "that is clubclub's Google client; nothing would be separated" >&2; exit 1; }
  /usr/bin/sed -i '' "s|\"GOOGLE_CLIENT_ID\": \"[^\"]*\"|\"GOOGLE_CLIENT_ID\": \"$GID\"|" "$CONF"
  echo "google client id -> $GID"
fi
if [ -n "$ASID" ]; then
  [ "$ASID" = "$SHARED_APPLE" ] && { echo "that is clubclub's Services ID; nothing would be separated" >&2; exit 1; }
  /usr/bin/sed -i '' "s|\"APPLE_CLIENT_ID\": \"[^\"]*\"|\"APPLE_CLIENT_ID\": \"$ASID\"|" "$CONF"
  echo "apple services id -> $ASID"
fi

if [ -n "$GSEC" ]; then
  [ -f "$GSEC" ] || { echo "no such file: $GSEC" >&2; exit 1; }
  # Accept either Google's downloaded JSON or a bare secret in a file.
  if /usr/bin/grep -q '"client_secret"' "$GSEC" 2>/dev/null; then
    /usr/bin/python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));s=d.get("web") or d.get("installed");sys.stdout.write(s["client_secret"])' "$GSEC" \
      | (cd "$APP" && npx wrangler secret put GOOGLE_CLIENT_SECRET >/dev/null)
  else
    /usr/bin/tr -d '\n' < "$GSEC" | (cd "$APP" && npx wrangler secret put GOOGLE_CLIENT_SECRET >/dev/null)
  fi
  echo "google client secret set (never printed, never an argument)"
fi

echo "deploying…"
(cd "$APP" && npx wrangler deploy >/dev/null)

# Ask the providers rather than assuming. A redirect URI that is not registered
# is the single most common reason a correct-looking sign-in fails, and it
# costs one unauthenticated request to find out.
probe() { # provider authorize-url-base client-id
  local p="$1" url ru body
  ru="$base/auth/$p/callback"
  if [ "$p" = google ]; then
    url="https://accounts.google.com/o/oauth2/v2/auth?client_id=$3&redirect_uri=$ru&response_type=code&scope=openid%20email&state=probe"
  else
    url="https://appleid.apple.com/auth/authorize?client_id=$3&redirect_uri=$ru&response_type=code&scope=name%20email&response_mode=form_post&state=probe"
  fi
  body=$(/usr/bin/curl -s -L --max-time 25 "$url" || true)
  if printf '%s' "$body" | /usr/bin/grep -qiE 'redirect_uri_mismatch|invalid_request'; then
    echo "  $p: NOT REGISTERED - add $ru in the $p console"
    return 1
  fi
  echo "  $p: $ru accepted"
}
gid=$(/usr/bin/grep -oE '"GOOGLE_CLIENT_ID":[[:space:]]*"[^"]+"' "$CONF" | /usr/bin/sed 's/.*"\([^"]*\)"$/\1/')
asid=$(/usr/bin/grep -oE '"APPLE_CLIENT_ID":[[:space:]]*"[^"]+"' "$CONF" | /usr/bin/sed 's/.*"\([^"]*\)"$/\1/')
echo "verifying against the providers:"
ok=0
probe google "" "$gid" || ok=1
probe apple  "" "$asid" || ok=1
[ $ok -eq 0 ] || { echo "deployed, but sign-in will fail until the callbacks above are registered." >&2; exit 1; }
echo "both providers accept this deployment's callbacks."
