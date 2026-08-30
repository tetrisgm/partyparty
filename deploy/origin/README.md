# Relay origin deployment

The origin accepts a DJ Mac's pushed LL-HLS and serves it to guests. It holds no
state on disk, so a deploy is a binary swap and a restart, and rollback is one
symlink.

It shares a box with chiptunes.app. That is deliberate and free, but the two
workloads are not equal: a party stutters in front of a room full of people,
while a radio listener does not notice a hiccup. The systemd units encode that
priority, and `deploy/origin/chiptunes-deprioritize.conf` lowers the radio and
video units so the relay wins CPU contention roughly 25 to 1. This only applies
under contention; when no party is live the radio still gets the whole box.

## Owner-gated setup (once)

These need your Oracle and Cloudflare accounts.

### 1. Allow inbound 443

Oracle blocks it in two independent places, and both must be opened.

In the Oracle console: Networking, then the instance's VCN, then the subnet's
security list, add an ingress rule for source `0.0.0.0/0`, protocol TCP,
destination port 443.

Then on the box, because Oracle's Ubuntu images also filter locally:

```sh
sudo iptables -I INPUT 5 -p tcp -m state --state NEW --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Verify from elsewhere: `nc -vz <box-ip> 443`.

### 2. Wildcard certificate

Rooms are served at `<token>.relay.partyparty.party`, so a wildcard is required,
which means DNS-01. The Cloudflare token should be scoped to DNS:Edit on the
PartyParty.party zone only, so a compromise of this shared box cannot touch
anything else.

```sh
sudo apt-get install -y certbot python3-certbot-dns-cloudflare
sudo install -m 0600 /dev/null /etc/letsencrypt/cloudflare.ini
sudoedit /etc/letsencrypt/cloudflare.ini
sudo certbot certonly \
  --dns-cloudflare --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d '*.relay.partyparty.party' -d relay.partyparty.party \
  --agree-tos -m support@partyparty.party --non-interactive
```

Certbot installs its own renewal timer. The origin re-reads the certificate from
disk when it changes, so renewal needs no restart and is a non-event.

Enter `dns_cloudflare_api_token = ...` in the protected file opened by
`sudoedit`; do not pass the token in a command argument or leave it in shell
history.

### 3. DNS

One wildcard A record, `*.relay.partyparty.party`, pointing at the box, **grey
cloud (proxied off)**. Grey is not cosmetic: a proxied record would put every
guest request back through Cloudflare, which is the placement this whole design
exists to remove.

### 4. Publish credentials

Production credentials are minted per installation by the anonymous broker.
The origin asks the broker whether a presented room/token pair is valid and
caches that verdict briefly; it never retrieves or stores the credential. Set
`PPORIGIN_BROKER` in the environment file to the broker base URL.

The binary's `-rooms` flag remains an optional static override for isolated
local tests. Production does not maintain a room-token file.

### 5. Environment

Copy `pporigin.env.example` to `/etc/pporigin.env` (mode 0600) and adjust.

## Deploying

```sh
scripts/deploy-origin.sh              # build, upload, activate, health-check
scripts/deploy-origin.sh --rollback   # previous release
```

The script cross-compiles a static linux/arm64 binary, keeps the last five
releases, health-checks after activation, and rolls back automatically if the
new release does not answer.

## Watching it

`GET /__pp/health` returns room and media counts only. It deliberately exposes no
room tokens, no credentials, and no media, so it is safe to poll from anywhere.
