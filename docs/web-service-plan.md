# partyparty web service architecture

The cloud side of partyparty, served by one Cloudflare Worker at
**`https://partyparty.party`**. Doctrine: **assume online** — cloud-assisted
discovery, identity, feed, and replay — with the LAN/HLS path as the offline
fallback. In-room live audio and the remote cloud mirror are both plain HLS in
an `<audio>` element (locked-phone / background-safe); audio is never WebRTC.

## Domain + hosting

- **`partyparty.party`** is a Cloudflare zone in the account. One Worker
  (`partyparty-site`) is bound to the apex (`custom_domain`) plus a single
  wildcard zone route `*.partyparty.party/*`. The zone's Universal SSL covers
  `*.partyparty.party`, so **every handle's permanent link works with zero
  per-DJ provisioning** — no custom domains to add, ever.
- Static landing (`../site`) is served by the assets binding with
  `run_worker_first: true` so the Worker's hostname router runs first.
- R2 (`partyparty-dl`) holds the app download, Sparkle appcast, cert-broker
  install records, and published/live set media. D1 (`partyparty-events`) holds
  accounts, profiles, events, presence, guests, posts. Zero egress on R2.

## The one guest-facing URL: `<handle>.partyparty.party`

A DJ's permanent link is their profile when idle and their party when live —
same URL, adapts per guest:

- **Live + on the party's Wi-Fi** → the page's browser probes the Mac's LAN
  host (`<slug>.partyparty.party:<port>`, a no-cors HTTPS fetch that only
  resolves against the Mac's valid cert = authenticated on-LAN proof) and hands
  off to the tight LAN LL-HLS listener.
- **Live + off-LAN** → the event page, playing the R2 cloud mirror a few
  seconds behind the room.
- **Idle** → the DJ's profile / last set.

Local-vs-remote is decided by the **LAN probe**, never a cloud IP compare —
iCloud Private Relay / carrier NAT give phones a different public IP than the
Mac on the same Wi-Fi, so IP matching is unreliable. `/api/discover` returns
live parties globally (egress IP only reorders as a hint); the page probes each
and surfaces only a party whose LAN host actually answered.

Machine hostnames are handle-derived (`<handle>-live.partyparty.party`), minted
during the Mac's own activation refresh (adopts host + fresh ACME cert with no
client change), never renamed while live.

## Live audio: LAN + cloud mirror

The Mac tees a stream-copy HLS leg (isolated, `onfail=ignore`+fifo so it can't
back-pressure the LAN leg) and `internal/livemirror` uploads 3s segments +
playlist to R2 via `PUT /api/broker/live-segment|live-playlist`; the Worker
serves them at `/event/<slug>/live/<file>`. On by default
(`PARTYPARTY_CLOUD_MIRROR=0` opts out). The live check-in mints the event row at
go-live so a fresh party's mirror is servable immediately.

## Shared room + web feed

The room (LAN guests + DJ console) and the web (off-LAN event page) are **one
party**: web guests get the same name/emoji/optional-email join sheet, post into
the same wall, and are counted in one combined listener tally. Web posts ride
back to the Mac on the live check-in response (deduped by cloud id, marked
`NoPublish` so the after-set mirror never echoes them); room posts reach the web
mid-party via the post-sync drain (which runs while live, not just after).

## Accounts + identity

Passwordless email (MXroute SMTP from `noreply@partyparty.party`) + Google and
Apple OAuth, hand-rolled in the Worker, keyed by email. Every account has a
UNIQUE `handle`; `/welcome` confirms it, `/settings` edits it (old handles retire
to `handle_aliases` and 301 forward), `/@handle` is the profile.

## Broker + certs (the Plex pattern)

Linked installs get a real Let's Encrypt cert for their machine host with zero
config: the app runs ACME locally (private keys never leave the Mac) and asks
the broker to publish the DNS-01 TXT + the DNS-only A record. The broker's
`CF_DNS_TOKEN` writes into the `partyparty.party` zone (`CF_ZONE_ID`);
`/api/broker/dns-admin` (ADMIN_KEY-gated) is the self-serve zone-maintenance
hook.

## Shipping

Two lanes: native releases via `scripts/ship.sh` (bumps `CODE_MAJOR`,
notarizes, deploys the Worker + landing, flips the Sparkle appcast) and OTA
web/config payloads via `scripts/ship.sh --payload-only`.

> The product migrated from an earlier prototype domain to `partyparty.party`
> on 2026-07-17; the old domain and its compatibility shim were fully removed.
