# LAN HTTPS low-latency reliability — architecture review request

> **RESOLVED.** The architecture review is complete and the fix is implemented.
> The chosen design and the prescriptive contract are in
> [`lan-https-reliability-execution-plan.md`](lan-https-reliability-execution-plan.md).
> Delivered so far: persistent per-install machine A records (never deleted on
> offline/quit), a strict *verified* Cloudflare receipt on `/api/broker/a` and
> `/api/broker/live`, the `party.partyparty.party` namespace-anchor TXT replacing
> the `192.0.2.1` guard wildcard (absent machine names now return NXDOMAIN), stable
> machine hostnames (no handle-derived renames), removal of the false DoH
> "DNS-rebind protection" classifier and every raw-`http://<ip>:8000/` fallback,
> and a structured activation result (cert vs DNS vs resolver evidence). Still to
> come as a follow-on unit: the full `/api/status` `lan` object with listener/
> guest-path TLS self-checks and the console `lan.state` UI (execution-plan §5–7).
> The observations below are retained as the original field evidence.



**Status:** open problem. Please review the current architecture, critique it, and
recommend the most robust approach. This document is the brief; the goal is your
architectural verdict + a concrete build plan, not a code dump.

## The one-sentence goal

A guest on the **same Wi-Fi** as the DJ's Mac, on a **default-configured phone**,
scans the QR (or taps a link) and lands in the **low-latency LAN room** (HTTPS
LL-HLS, ~1–2 s behind the music) **automatically and reliably**, with **no
per-network fiddling** and **no dependency on fragile tech that "may or may not be
there."** Off-Wi-Fi guests fall back to the cloud stream (~10 s) — that part works.

**Owner's hard constraints (do not relitigate):**
- **Keep the HTTPS LL-HLS pipeline.** Low latency requires it and it is already
  built. Do **not** add a parallel plain-HTTP streaming path. Make the HTTPS path
  reliable instead.
- A pretty URL is *preferred* but connecting by IP is acceptable **if** it is
  robust. Robustness beats prettiness.

## How it works today

1. DJ console shows a QR encoding `https://<handle>.partyparty.party/` (cloud
   "router" page on the Cloudflare Worker).
2. That page runs a JS probe of the **machine host**
   `https://<slug>.party.partyparty.party:8443/` (the Mac's own HTTPS server).
   - Reachable → `location.replace()` into the LAN room (low latency). ✅
   - Unreachable (3.5 s timeout) → cloud event page (~10 s latency). ❌ what users hit
3. **Audio only comes from the machine host.** The plain-HTTP `streamUrl` was
   deliberately removed ("HTTPS-only"), so `chosenStream() = llhlsUrl` and
   `llhlsUrl` is `https://<machine-host>:8443/live/party/index.m3u8`, non-empty
   only when a **real cert** is present. No machine host = no audio = cloud.

The machine host requires three things to be simultaneously true for a guest:
- **DNS:** grey (DNS-only) A record `<slug>.party.<base>` → the Mac's **current
  LAN IP**. Written by the app at launch via the broker (`/api/broker/a`).
- **Cert:** a real Let's Encrypt cert for that host (DNS-01 via the broker),
  served on `:8443`.
- **Reachability:** the guest's phone resolves that name to the private LAN IP and
  can open a TCP/TLS connection to it on the LAN.

### The guard wildcard (relevant context)

The zone has a **proxied** product wildcard `*.partyparty.party` (orange-cloud) so
any handle works with zero provisioning. DNS's closest-encloser rule means that
proxied wildcard would also synthesize **live-looking Cloudflare-edge answers** for
*absent* multi-label machine names like `seth-live.party.partyparty.party` — which
poisons resolver caches and makes guests hang on a CF edge that has no valid cert
for that name. To stop that, a **grey guard wildcard** `*.party.partyparty.party →
192.0.2.1` (TEST-NET, dead) sits one level deeper and is re-ensured hourly by the
Worker cron. An **exact** machine A record beats the guard; a **missing** one falls
through to `192.0.2.1`.

## What actually broke (field evidence, 2026-07-22, home Wi-Fi)

DJ is Seth's Mac (`slug=seth-live`, LAN IP `192.168.1.85`). Both test phones got
the high-latency cloud stream and the LAN room's bottom bar (player + photo +
comment composer) was absent — i.e. nobody reached the machine host.

```
dig seth-live.party.partyparty.party @1.1.1.1   -> 192.0.2.1     (guard; exact record MISSING)
dig ramine-live.party.partyparty.party @1.1.1.1  -> 192.168.1.117 (correct, a different Mac)
dig zzz-absent.party.partyparty.party @1.1.1.1   -> 192.0.2.1     (guard, as designed)
```

Seth's Mac log at activation:
```
activate: local resolver hides the record (DNS-rebind protection); authoritative DNS is correct — activating anyway; same-Wi-Fi guests will use the cloud stream
activate: secure link ready from online refresh — seth-live.party.partyparty.party
```

Confirmed in code:
- The cron GC **deliberately keeps** the machine A record on live-install expiry
  (`worker.js` `scheduled()`), so GC is **not** deleting it.
- The app is supposed to "upsert the fresh LAN IP at every launch" via
  `activate.TryBroker` → `POST /api/broker/a` (`internal/activate/activate.go`).
- The activation loop (`main.go` ~1000) calls `Try`/`TryBroker`, then on `res.OK`
  logs `applyActivationResult(res, "online refresh")`.

## Findings / hypotheses (please confirm or correct)

1. **Primary bug — the machine A record is unreliable.** Seth's exact record is
   simply *absent*, so the guard serves `192.0.2.1`, every guest probe fails, and
   everyone rides the cloud. `ramine-live` proves the zone + record mechanism work
   when the record exists. **Why is Seth's upsert not resulting in a persisted
   record?** (Is `TryBroker`'s `/api/broker/a` actually reached and succeeding on
   his install? Does the "online refresh" fast path skip or short-circuit the
   upsert? Is `/api/broker/a` writing the right name/zone? Is there a silent error
   swallowed by fail-soft?)

2. **The "rebind protection" log is very likely a FALSE POSITIVE caused by the
   guard.** `verifyResolves` compares the resolver's answer to the Mac's LAN IP;
   with the exact record missing it gets `192.0.2.1` (the guard) ≠ `192.168.1.85`
   and reports "local resolver hides the record (DNS-rebind protection)." But
   `ramine-live`'s private IP resolves fine on the same infrastructure, so there is
   no evidence the home router actually strips private-IP answers. **We may be
   chasing a rebind-protection ghost that is really just the missing record + the
   guard.** Please verify.

3. **The guard wildcard may be causing more harm than good.** It pollutes
   resolution (a missing record looks "present" as a dead IP → silent cloud
   fallback) and corrupts the Mac's own self-check (false rebind diagnosis).
   Question: is the guard the right mechanism, or should the machine namespace live
   in a **separate, non-proxied zone/subdomain** with no product wildcard over it,
   so an absent name returns a clean NXDOMAIN instead of either a poisoned CF edge
   IP or a dead guard IP?

## The core architectural questions for you

1. **Is genuine router DNS-rebind protection actually in play here, or is every
   symptom explained by (missing record + guard wildcard)?** This decides
   everything. If it's just the record, the fix is "make the A record bulletproof +
   fix the guard/zone design." If real rebind protection exists on common routers,
   a name→private-IP scheme fundamentally can't be relied on and we need a
   different reachability mechanism.

2. **Given the HTTPS-only constraint, what is the most robust way to guarantee
   same-Wi-Fi reachability of the Mac's cert-backed HTTPS server?** Evaluate at
   least:
   - (a) Bulletproof the exact machine A record (idempotent upsert every launch +
     on every network change; verify persistence; alarm on failure) and redesign
     the guard/zone so a missing record can never silently masquerade as reachable.
   - (b) IP-encoded hostname + wildcard cert (the "plex.direct" pattern,
     `192-168-1-85.<base>` → `192.168.1.85`, cert `*.<base>`). Does this actually
     help, given it is still a public-name→private-IP answer that rebind protection
     would strip the same way? What does it buy over (a)?
   - (c) Any mechanism that bypasses the router's resolver (DoH from the page /
     phone, mDNS with a trusted cert — note we cannot get a public cert for
     `.local` or a raw private IP), or accepts that rebind-protected networks fall
     to cloud by design.

3. **Should the guard wildcard stay, be replaced by a cleaner zone design, or be
   removed?** What is the correct, self-healing zone layout that (i) lets any
   handle work with zero provisioning, (ii) never synthesizes live-looking answers
   for absent machine names, and (iii) never lets a *present* machine's record be
   masked or a *missing* one look reachable?

4. **Reliability engineering:** where should the "publish my current LAN IP + prove
   a guest could reach me" responsibility live so it is robust across sleep/wake,
   network change, DHCP renew, and app restart — and how should the console
   *honestly* report "guests on this Wi-Fi will get the LAN room" vs "guests will
   fall to cloud," instead of the current optimistic "activating anyway"?

## Deliverable requested from Codex

- A crisp **verdict on question 1** (rebind-protection real or ghost), with the
  reasoning and any additional probe you'd run to prove it.
- A recommended **target architecture** (zones, records, guard-or-not, who upserts
  what and when, how a guest reaches the machine host reliably).
- A **concrete, ordered build plan** scoped to this repo (`internal/activate`,
  `main.go`, `cloudflare/worker.js`, `web/*.html`) — smallest change set that makes
  same-Wi-Fi HTTPS reliable, plus what to rip out.
- Call out anything in the current design that is **accidental complexity** and
  should be deleted rather than fixed.

Repo entry points: `internal/activate/activate.go` (Try/TryBroker, verifyResolves,
upsertA), `main.go` (~995–1030 activation loop; ~720 reachability watchdog),
`cloudflare/worker.js` (`handleRouter`, `renderLiveJoin`, `/api/broker/a`,
`/api/broker/dns-admin`, `scheduled()` GC + guard), `web/listener.html`
(`chosenStream`/`usingLL`), `web/dj.html` (QR + `s.urls`).
