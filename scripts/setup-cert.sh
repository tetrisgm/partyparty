#!/usr/bin/env bash
# One-time: get a publicly-trusted TLS cert for YOUR domain so party guests get
# HTTPS LL-HLS with zero warnings (no per-phone cert trust).
#
# Uses Let's Encrypt DNS-01: works even though the Mac isn't reachable from the
# internet — you just add one TXT record at your DNS provider when prompted.
#
#   ./scripts/setup-cert.sh party.yourdomain.com
#
# Then run:  ./partyparty --domain party.yourdomain.com --cert <fullchain> --key <privkey>
# And point your router's DNS so the domain resolves to this Mac's LAN IP.
set -euo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "usage: $0 party.yourdomain.com"; exit 1; }
command -v certbot >/dev/null || { echo "install certbot first:  brew install certbot"; exit 1; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/run/letsencrypt"
mkdir -p "$DIR"

echo "Requesting a Let's Encrypt cert for $DOMAIN (DNS-01)."
echo "certbot will show a TXT record to add at your DNS provider — add it, wait ~1 min, then continue."
echo

certbot certonly --manual --preferred-challenges dns -d "$DOMAIN" \
  --config-dir "$DIR/config" --work-dir "$DIR/work" --logs-dir "$DIR/logs" \
  --agree-tos --register-unsafely-without-email --no-eff-email

CERT="$DIR/config/live/$DOMAIN/fullchain.pem"
KEY="$DIR/config/live/$DOMAIN/privkey.pem"
IP="$(ipconfig getifaddr en0 2>/dev/null || echo '<mac-lan-ip>')"

cat <<MSG

✓ Cert ready.

1) Run partyparty with your domain + cert:
     ./partyparty --domain $DOMAIN --cert "$CERT" --key "$KEY"

2) Make the domain resolve to this Mac on your party network.
   On a GL.iNet / OpenWrt router (LuCI → Network → DHCP/DNS, or dnsmasq config):
     address=/$DOMAIN/$IP
   (Or any DNS the guests use — point $DOMAIN at $IP.)

3) Guests join the Wi-Fi and scan the QR. The player loads
     https://$DOMAIN:8888/party/index.m3u8
   with a valid cert — no warnings, ~1-2s latency, still plays when locked.

Note: Let's Encrypt certs last 90 days; re-run this to renew.
MSG
