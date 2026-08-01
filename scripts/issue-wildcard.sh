#!/usr/bin/env bash
# Issue or renew the shared machine wildcard cert (*.party.partyparty.party) and
# publish it to R2 at wildcard/current.json, where every linked install fetches
# it (see /api/broker/wildcard-cert + activate.fetchWildcard). This is the ONLY
# cert path for broker installs - there is no per-Mac ACME fallback - so this
# cert must never lapse. Run once to issue; a launchd job runs it ~monthly to
# renew (party.partyparty.wildcard-renew).
#
# Idempotent + safe: certbot only reissues when near expiry (--keep-until-
# expiring), and we always re-upload the current cert so R2 matches disk. State
# (ACME account + cert) persists in ~/.config/stack/wildcard so renewals reuse
# the same account. The Cloudflare token is read from the stack config and never
# printed. stdin is closed so an unattended run can never hang on a prompt.
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN='*.party.partyparty.party'
CERTNAME='party.partyparty.party'          # certbot lineage name (stable)
EMAIL='support@partyparty.party'
CFG="$HOME/.config/stack/wildcard"          # persistent certbot state
CF_ENV="$HOME/.config/stack/cloudflare.env" # CLOUDFLARE_API_TOKEN=...

[ -f "$CF_ENV" ] || { echo "missing $CF_ENV (needs CLOUDFLARE_API_TOKEN)"; exit 1; }
command -v certbot >/dev/null || { echo "certbot not installed"; exit 1; }

umask 077
mkdir -p "$CFG"/{le,work,logs}
TOKEN="$(grep -E '^CLOUDFLARE_API_TOKEN=' "$CF_ENV" | cut -d= -f2- | tr -d '\r"')"
export CLOUDFLARE_API_TOKEN="$TOKEN"   # wrangler R2 auths off this (headless - no OAuth login)
INI="$CFG/cf.ini"
printf 'dns_cloudflare_api_token = %s\n' "$TOKEN" > "$INI"
chmod 600 "$INI"

echo ">> certbot certonly ($DOMAIN) - issues, or renews only if near expiry"
certbot certonly --dns-cloudflare --dns-cloudflare-credentials "$INI" \
  --dns-cloudflare-propagation-seconds 25 \
  -d "$DOMAIN" --cert-name "$CERTNAME" --keep-until-expiring \
  --agree-tos -m "$EMAIL" --non-interactive --no-eff-email \
  --config-dir "$CFG/le" --work-dir "$CFG/work" --logs-dir "$CFG/logs" < /dev/null

LIVE="$CFG/le/live/$CERTNAME"
[ -f "$LIVE/fullchain.pem" ] || { echo "cert missing at $LIVE"; exit 1; }

echo ">> publish to R2 (wildcard/current.json)"
TMP="$(mktemp)"; trap 'rm -f "$TMP"' EXIT
node -e 'const fs=require("fs");const d=process.argv[1];fs.writeFileSync(process.argv[2],JSON.stringify({cert:fs.readFileSync(d+"/fullchain.pem","utf8"),key:fs.readFileSync(d+"/privkey.pem","utf8")}))' "$LIVE" "$TMP"
( cd cloudflare && npx wrangler r2 object put partyparty-dl/wildcard/current.json \
    --file "$TMP" --content-type application/json --remote )

echo ">> done - wildcard published; expires $(openssl x509 -in "$LIVE/cert.pem" -noout -enddate | cut -d= -f2)"
