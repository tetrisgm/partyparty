# Relay architecture v2 (trade study and replacement design)

Status: design for review, revision 2.1. Supersedes v1 (commit 5d82c95) after
owner review. No implementation has started.

Revision 2.1 changes, from owner review of v2: a 500-listener-per-room scale
requirement is now explicit and every option is graded against it; the SNI
passthrough rejection is explained properly (the fan-out burden lands on the
Mac's venue uplink, not the relay); and the Workers Paid bridge is REMOVED at
owner direction, because it pays to keep alive a path that cannot serve a real
party at any price.

How this revision was produced: five parallel code and market recon passes
(Worker flow, Mac relay client, wildcard and certificate estate, Cloudflare and
VPS economics with live verification on 2026-07-28, alternative architectures),
one synthesis, then three independent adversarial reviews (guest flow,
invariants, numbers and ops). The adversarial findings are folded in below as
normative requirements, marked R1..R15. Where a number could not be verified
live it is flagged.

## Correction first: the wildcard stays

v1 proposed retiring the `r-<token>.partyparty.party` hostnames and deleting the
`*.partyparty.party/*` route. That was wrong, and the owner's pushback is
confirmed by the code:

- The QR contract requires the orange bootstrap hostnames in every mode,
  including direct venues. `joinURLLocked` prefers the registered join URL over
  the direct URL (`internal/relay/relay.go:296-301`), and both `applyProbe`
  (`relay.go:315`) and `confirmRelayState` (`relay.go:385`) publish it. The
  direct URL becomes the QR only when relay registration fails or the Mac is
  offline (`relay.go:283-294`). Deleting the route would have changed the join
  flow of every online party, not just isolated venues.
- The wildcard is the zero-provisioning resolution layer for those tokens: no
  per-name DNS records exist (register writes only R2 state,
  `cloudflare/worker.js:462-486`); the names resolve through the proxied zone
  wildcard (live dig 2026-07-28 returns Cloudflare anycast for arbitrary
  single-label names) and Cloudflare Universal SSL (SANs `partyparty.party` and
  `*.partyparty.party`, verified by SNI handshake) terminates their TLS.
- Every other wildcard tenant is path-based and low frequency: standalone
  downloads (`worker.js:1040-1056`), `/api/version`, legal pages, broker
  endpoints, site assets. A repo-wide grep finds no other subdomain consumers.
- The one historical wildcard pathology (synthesized answers for absent
  multi-label machine names, commit 3e817dd) is already cured by the
  `party.partyparty.party` namespace anchor plus the every-minute cron
  (`worker.js:297-339`, `wrangler.jsonc:52`). Live-verified: an absent machine
  name returns NXDOMAIN.

Exactly one tenant moves off the wildcard: relayed guest media and room API
traffic, the per-request Durable Object proxy hot path (`relayPublicRequest`
`worker.js:982-1026` into `RelayRoom` `worker.js:691-962`). Everything else on
the wildcard stays byte-identical.

Two adjacent facts, neither a wildcard change: creating the single grey
`*.relay.partyparty.party` record instantiates `relay.partyparty.party` as an
empty non-terminal, which by RFC 4592 closest-encloser rules stops the orange
zone wildcard from synthesizing answers for absent relay names, so the relay
namespace is born immune to the 3e817dd poison class. And any future media
hostname placed in this zone must be grey, or it lands back under
`run_worker_first` and recreates this exact defect.

## The defect, measured

Per relayed listener, steady state (all figures re-derived from the shipped
pages and config, then independently reproduced by the numbers adversary):

| Source | Rate |
|---|---|
| LL-HLS media parts (150 ms parts, `internal/config/config.go:62-71`) | 6.67/s |
| LL-HLS blocking playlist reloads (`_HLS_msn`/`_HLS_part`) | 6.67/s |
| `/api/status` poll (`web/listener.html:2641`) | 0.33/s |
| `/api/heartbeat` (`listener.html:2677`) | 0.50/s |
| `/api/time` clock sync (6 samples per 30 s) | 0.20/s |
| `/api/client-events` flush | 0.08/s |
| `/api/feed` long-poll re-issue | 0.04/s |
| Total | 14.49/s, 52,163 per listener-hour (92% media) |

Every one of these is a billed Worker invocation. `run_worker_first: true`
(`wrangler.jsonc:13`) means the edge cache is consulted inside the Worker
(`worker.js:995-999`), so a cache hit still bills. Blocking playlist requests
carry unique query directives and can never cache. The free plan's 100,000
requests per day therefore dies at about 2 listener-hours per day; the 84%
alert corresponds to roughly 1.6 to 1.75 listener-hours.

Control-plane traffic is irrelevant by comparison: registration refresh is 120
requests per hour per DJ (30 s cadence, `relay.go:42`), the cron is 1,440 per
day.

This is a data-plane placement defect. No cache setting, geometry knob, or quota
fixes it in place.

## Scale requirement: 500 listeners per room

Owner requirement: parties can reach 500 people. The product must not lock into
an architecture that can never serve that, even though typical rooms today are
far smaller. Every option below is graded against N = 500.

The scale physics, per relayed listener: ~0.32 Mbps audio plus ~0.16-0.28 Mbps
of blocking playlist response bytes, so ~0.5-0.6 Mbps delivered; ~14.5 HTTPS
req/s; ~1.15 req/s of per-listener API traffic (status, heartbeat, time,
events, feed) that cannot be coalesced across listeners.

| At N listeners | 20 | 200 | 500 |
|---|---|---|---|
| Mac venue uplink, SNI passthrough (N encrypted copies) | ~10-12 Mbps | ~100-120 Mbps | ~250-300 Mbps |
| Mac venue uplink, terminating relay (one copy, R15) | ~0.6 Mbps | ~0.6 Mbps | ~0.6 Mbps |
| Relay egress, terminating relay | ~10-12 Mbps | ~100-120 Mbps | ~250-300 Mbps |
| Relay HTTPS req/s | ~290 | ~2,900 | ~7,250 |
| Mac origin req/s behind relay coalescing (~15 media + 1.15 x N API) | ~40 | ~245 | ~590 |
| Worker + DO req/s on the current path | ~290 | ~2,900 | ~7,250 |

Consequences:

- The current Cloudflare path is structurally dead at scale regardless of
  payment: the DO soft limit is ~1,000 req/s per object, so one room saturates
  somewhere near 20-40 listeners and a 500-person room is roughly 7x over the
  limit. This is why the status quo is rejected as a destination AND as a paid
  bridge.
- SNI passthrough is structurally dead at scale in the other direction: the
  N-copies burden lands on the DJ's venue uplink (see the rejection below).
- The terminating relay scales by resizing the VPS: ~300 Mbps peak egress fits
  a 1 Gbps port; ~7,250 req/s of small TLS responses wants a 4-vCPU instance
  (Hetzner CPX31 class, ~16 EUR/month) rather than the 2-vCPU launch size, an
  offline resize that keeps the IP and takes minutes; beyond one node,
  per-room relay assignment in the register response adds horizontal capacity
  with no client change. A 500-listener 4-hour party is ~440 GB of egress,
  about $4.40 at DigitalOcean overage rates or ~1-2 EUR at Hetzner's (verify
  at the console). The Mac's own load stays flat where it matters: one media
  copy on the uplink, with only the per-listener API stream (~590 req/s at
  N=500, trivial for the Go origin over HTTP/2) growing with N.

Options evaluated. L = listener-hours per month; costs at L = 10/50/200/1000.

| Option | Added latency | LL-HLS blocking fidelity | Cost at 10/50/200/1000 L | Code delta | 2 am story | Verdict |
|---|---|---|---|---|---|---|
| (a) Status quo on Workers Paid | Baseline; edge+DO tens of ms | Yes (45 s DO timeout covers the hold) | ~$5.00/$5.30/$6.60/$27.5-28.5, marginal ~$0.026-0.028 per L forever | 0 | Cloudflare's problem, but nothing you can do during their incident | REJECT: the DO ~1,000 req/s soft limit caps a room near 20-40 listeners at any price; a 500-person room needs ~7,250 req/s. Paying $5 to keep this alive buys nothing (owner decision, v2.1) |
| (b) VPS reverse HTTP/2 tunnel | One RTT guest-VPS + VPS-Mac, ~10-40 ms each US West; under one 150 ms part | Yes: long-poll RoundTrip per blocking request, single-flight keyed so distinct directives never coalesce | ~$6-7 flat at all four | Write ~1,000-1,500 Go + deploy script + bootstrap JS; delete ~800 protocol lines net | One VPS: systemd, disk, cert, provider outage; cron-alerted (R13) | PRIMARY |
| (c) Minimal-delta VPS: port RelayRoom keeping the custom WS protocol | Same transport physics as (b) | Yes, field-proven protocol (32ccfd8, 33c5294) | Same as (b) | Write ~300-500 Go port; zero Mac delta (ConnectURL is Worker-issued and opaque) | Same VPS burden, plus today's single-WS defects survive | FALLBACK |
| (d) R2 mirror plane | +3-6 s glass to glass | No. A passive object store cannot hold a GET until `_HLS_msn` exists; blocking is unimplementable | $0 to ~$138 depending on listeners per room | Revive ~850 lines of retired livemirror (e4df0da, retired 0a13bf8) | Low | REJECT: destroys in-room sync and the ~1.0 s target |
| (e) DO to guest WebSocket push | n/a | n/a | n/a | n/a | n/a | REJECT: locked iPhones require native AVPlayer over plain HTTPS GETs; pushed bytes only reach a player via page JS, which suspends on lock |
| (f) Off-the-shelf tunnels (frp, rathole, ssh -R, WireGuard) | Comparable to (b) | Raw TCP passes it, no media layer | ~$6 flat plus a foreign binary to supervise | Bundle and supervise a second binary in both editions, then still write the media policy layer | VPS plus supply chain | REJECT: WireGuard needs entitlements the product forbids; the rest converge to (b) plus dead weight |
| (g) Pure TCP/SNI passthrough splice | Lowest; MediaMTX answers blocking natively; Mac terminates TLS with its existing cert | Perfect | ~$6 flat in money, but the real cost is venue uplink | New splice protocol both ends anyway (Mac cannot accept inbound) | VPS plus splice daemon | REJECT at the 500 scale requirement; see the dedicated section below |
| (b+) Push-media hybrid on (b) | Slightly better first-request | Yes, but relayd must own LL-HLS playlist semantics against real AVPlayer behavior | Same as (b) | Moderate extra relayd complexity | Same as (b) | DEFERRED: the designated escape hatch if R15 measurement shows playlist fan-out (open decision 6) |
| Geometry knob: widen parts in relay mode | +1.0-1.5 s | Yes | $0 | Tiny | None | REJECT: degrades the latency north star and leaves media in the Worker |

Cost crossovers, derived from the tables (the v1 claim of 800-1,000 L was not
derivable and is retracted): Workers Paid total exceeds the transition state
(VPS plus Workers Paid, ~$11-12) at roughly 380-400 L per month, and exceeds a
standalone VPS (~$6, post-decommission) at roughly 45 L per month, because DO
request overage begins near 20 L.

The decisive non-cost facts against (a): the DO soft limit of 1,000 requests per
second caps one room somewhere near 20-40 listeners no matter what is paid,
which fails the 500-listener requirement outright; every media byte transits
single-threaded JS frame slicing; DO eviction mid-party orphans in-flight
requests (in-memory pending map, `worker.js:695`); and a Cloudflare incident
takes the relay down with no action available to you.

### Why SNI passthrough is rejected, stated properly

The attraction is real: lowest latency, perfect blocking-playlist semantics
because MediaMTX answers directly, and zero relay-side certificate work because
each phone's TLS session terminates on the Mac using the wildcard cert it
already holds.

That last property is also the disqualifier. If the relay cannot read the
bytes, it cannot deduplicate them. Every listener's stream is a separate,
independently encrypted copy, and every one of those copies originates on the
Mac and travels up through the venue Wi-Fi and the venue's ISP uplink to the
relay before fanning out. The relay's egress is the same either way; what
changes is WHERE the fan-out happens:

- SNI passthrough: fan-out on the Mac. 200 listeners is ~64 Mbps of audio
  alone, ~100-120 Mbps with playlist responses; 500 listeners is ~250-300
  Mbps. Upstream, from a laptop, across party Wi-Fi, through a venue internet
  connection that typically offers 10-50 Mbps up. Both the Wi-Fi airtime and
  the ISP uplink carry all N copies.
- Terminating relay: fan-out on the VPS. The Mac uploads roughly one copy
  (~0.6 Mbps at any N, subject to R15 measurement) and the VPS serves N from a
  1 Gbps port.

A venue with guaranteed symmetric multi-hundred-megabit fiber could carry SNI
passthrough. Relay mode exists precisely for hostile, unknown venue networks,
so an architecture that only works on generous uplinks contradicts its own
reason to exist, and it fails hardest at exactly the 500-person scale the
product must be able to reach.

Correction to v2: the earlier rejection also leaned on the photo throttle being
impossible at a path-blind relay. That argument was weak, because under SNI the
Mac terminates TLS and could enforce media policy itself. The uplink fan-out is
the real and sufficient reason, and it is the only one this document relies on.

## Recommendation

1. PRIMARY: option (b), the VPS reverse HTTP/2 tunnel, with the hostname scheme
   below and requirements R1..R15.
2. FALLBACK: option (c), held in reserve, adopted only if (b)'s two-phone
   acceptance surfaces an HTTP/2-specific failure not fixable within the unit.
3. NO BRIDGE. The v2 Workers Paid bridge is removed at owner direction: it pays
   to keep alive a path whose ~20-40 listener ceiling cannot serve a real party
   at any price. Consequence, stated once: relay mode stays effectively capped
   at ~2 listener-hours per day on the free plan until step 7 ships. That is
   sufficient headroom for development and the two-phone acceptance, and
   fielded installs' relay behavior is unchanged until they update.

Why (b) over (c), argued on engineering risk: (c)'s unique advantage is zero Mac
delta, so it ships sooner and covers fielded installs retroactively. Two things
outweigh that. First, the 500-listener requirement cuts against (c)
independently: its hand-rolled single-WebSocket protocol (JSON control frames,
64 KB chunks, a manual 512 KB ack window at `relay.go:38`, `:747-757`, one 20 s
write stall dropping every listener at `relay.go:600-604`, a shared audio FIFO
with no per-listener fairness at `relay.go:890-905`) is the shakiest piece of
the system at ~600 req/s of tunnel traffic, exactly the load a large room
produces; (b) replaces all of it with stdlib HTTP/2 per-stream flow control.
Second, (c)'s risk is reimplementation divergence in ~270 lines of subtle DO
protocol, and the two bug classes that protocol already paid for in the field,
response compression (33c5294) and the cookie/redirect handshake for native HLS
sessions (32ccfd8), are precisely the class a port re-risks, for code built to
be deleted. The beta fleet is small, so (c)'s retroactive coverage is worth
little against either point.

What (b) does not buy, stated honestly: transport physics. One HTTP/2 connection
has the same TCP head-of-line loss behavior as one WebSocket. The wins are
correctness surface, real per-stream backpressure, cancellation, structural
audio/bulk isolation, and flat cost.

## Architecture

### Planes

- Direct mode: unchanged, byte-identical, still preferred.
- Control plane (Worker, unchanged estate): bootstrap page, registration and
  grants, DNS and certificate coordination, downloads, site. About one request
  per guest join plus 120 registration refreshes per hour per DJ. Nothing
  per-listener, nothing per-part.
- Data plane (new): `cmd/pprelay`, logic in `internal/relayd`, one static Go
  binary in this repository, systemd under a non-root user on one VPS.

### Hostnames, DNS, certificates

- QR and bootstrap: `https://r-<token>.partyparty.party/` exactly as today,
  orange, served by the Worker (the bootstrap HTML moves out of the DO into
  stateless Worker code; token existence still gated by the 300 s cached R2
  head, `worker.js:505-521`).
- Media origin: `https://<token>.relay.partyparty.party` on the VPS. DNS is
  exactly one grey A record, `*.relay.partyparty.party` to the VPS IP. Grey
  cloud is the structural Worker bypass, the same proven pattern as the machine
  A records (`worker.js:274`, `:292`); traffic that never reaches the edge
  cannot execute a route.
- TLS: one new certbot lineage for `*.relay.partyparty.party`. A certificate
  wildcard matches exactly one label, proven three ways in recon: Go
  `VerifyHostname` behavior (`internal/activate/activate.go:493`), commit
  58e8261's empirical accept/reject test, and a live TLS alert 40 for two-label
  SNI at the edge. `scripts/issue-wildcard.sh` is reused by changing its two
  variables (lines 17-18). The zone DNS token never leaves the owner's Mac;
  certbot never runs on the VPS.
- R13 (cert delivery, mandatory): the renewed cert is published to R2 via the
  existing authed pattern (mirror of `/api/broker/wildcard-cert`,
  `worker.js:377-388`); relayd polls daily and hot-reloads via
  `tls.Config.GetCertificate`. The scp-in-deploy alternative is rejected: it
  only delivers a cert if a deploy happens to fall inside the renewal margin.
  Gate for step 4: the wildcard-renew launchd job has never fired and logs into
  the wipeable `build/` directory; repoint its log path and verify one real
  execution before relying on it for the second lineage.
- Rejected hostname scheme, recorded: single-label grey per-token names
  (`r2-<token>.partyparty.party`) reintroduce the resolver-poison class where
  the anchor cure cannot reach, and force either rate-limited per-name issuance
  racing the QR or a `*.partyparty.party` private key on the VPS that could
  impersonate the whole product.

### Tunnel

The Mac dials out to the relay on TLS 443 and authenticates with an Ed25519
grant. The roles then invert: the Mac runs `http2.Server.ServeConn` on the
connection with the existing guest handler; relayd runs
`http2.Transport.NewClientConn` and RoundTrips each guest request as one HTTP/2
stream. Stdlib per-stream flow control, RST_STREAM cancellation, and
`MaxConcurrentStreams` replace all hand-rolled framing.

Two tunnel connections per room, audio and bulk. `/live/` rides audio;
everything else rides bulk.

- R2 (strict audio priority, sacred rule 4): transport separation alone is
  fairness, not priority, on a congested uplink. The Mac therefore keeps a
  cross-connection priority gate: bulk writes are gated on the audio
  connection's send queue being empty (the same biased-drain discipline as
  today's `relay.go:542-550`, applied across sockets), bulk gets a small
  `MaxUploadBufferPerConn` so backpressure bites fast, and the default bulk
  pace in relay mode is 64-128 KB/s, below the audio copy rate, not the
  Worker's 256 KB/s. The photos-dark kill switch remains. Priority is
  Mac-enforced scheduling plus transport separation, not separation alone.
- Non-negotiable proxy carryovers, paid for by field fixes: never follow
  redirects server-side (`relay.go:586-588`, commit 32ccfd8); Cookie forwarded
  both directions and Set-Cookie unstripped; Accept-Encoding never sent toward
  the Mac and identity bytes from it (commit 33c5294); guest-facing Host
  carried through; query strings untouched; responses streamed unbuffered.

### Single-flight and cache

- Single-flight coalesces concurrent identical upstream requests and streams
  one response to every waiter.
- R3 (cookie correctness, mandatory): the single-flight key includes the Cookie
  header, and a coalesced response bearing Set-Cookie satisfies only the
  originating request; other waiters replay upstream. This is the 32ccfd8 bug
  class; playlists at the live edge share identical query directives across
  guests whose MediaMTX session cookies differ, and must never share a session
  handshake.
- R4 (cache scope, sacred rule 4): the rolling in-memory cache holds `/live/`
  HLS part objects only, roughly 60 s, bounded by construction near 1 MB per
  room (48 x 500 ms at 320 kbps). Playlists are only coalesced, never cached.
  Guest photos are never cached or retained; `/media/` passes through with
  coalescing only. relayd logging is content-free: counters only, no request
  paths, no bodies, no tokens at rest; `/__pp/health` exposes aggregates only.
- R15 (uplink scaling is a hypothesis, not a property): single-flight keyed on
  full path, query, and cookie coalesces only listeners at the same directive.
  Desynced listeners bypass coalescing and playlist bytes scale with N (worst
  case ~5.3 Mbps at 20 fully desynced listeners). Steady-state convergence
  makes this likely fine, but it is unmeasured. relayd counts non-coalesced
  playlist fetches and Mac-uplink bytes; step 6 acceptance asserts uplink bytes
  stay near one copy as listeners join. The push-media hybrid (b+) is the
  designated escape hatch if measurement disagrees.

### Credentials

The Worker keeps `authInstall` and mints an Ed25519-signed grant
`{roomToken, installID, exp ~10 min}` from the existing
`/api/broker/relay/register` (`worker.js:462-483`). relayd verifies offline
against a public key in its config; connecting costs zero Worker requests.
Sessions cap at 12 h. The 32-hex token shape survives.

- R5 (grant staleness, mandatory): relayd accepts a re-dial whose grant expired
  within a grace window (12 h) when roomToken plus installID match a previously
  verified session on this relayd process; the Mac triggers an immediate
  re-register on any grant-rejected dial instead of waiting out the refresh
  interval; exp is verified with plus or minus 60 s leeway; the VPS runs NTP.
  Without this, a tunnel blip during a Cloudflare incident leaves a healthy Mac
  and healthy VPS unable to reconnect.

### Guest flow (revised, with the loop fix)

What the QR encodes is unchanged: the `r-` bootstrap URL whenever registration
succeeds, in all modes; the direct URL only when registration fails or the Mac
is offline.

1. Guest scans, loads the `r-` bootstrap page from the Worker. One Worker
   request.
   - R6 (bootstrap state source): `/api/broker/relay/register` persists
     `directUrl` into the R2 broker record it already rewrites, refreshed every
     registration, so the stateless bootstrap can bake `directUrl` with at most
     one refresh interval of staleness. The Worker never calls relayd
     server-side; the planes stay separate.
2. R7 (concurrent, bounded): the bootstrap starts the direct probe and a
   relay-state GET (`https://<token>.relay.partyparty.party/__pp/state`,
   CORS-enabled) CONCURRENTLY. The state GET carries a 1.5-2 s AbortController.
   A successful direct probe plus direct verdict always wins immediately; a
   dead VPS adds zero latency to a direct join. If the cached room state says
   relay and the tunnel is online, the fast path replaces straight to the relay
   origin.
3. R8 (probe transport and provenance): the browser reports only
   `{reachable}` exactly as today, as a text/plain simple request to the RELAY
   origin `/__pp/probe`. relayd injects `networkKey` server-side from the
   tunnel's last state message (mirroring today's DO injection,
   `worker.js:773-777`) and forwards it over the tunnel to the Mac's Manager.
   The Mac stays authoritative (`applyProbe`, `relay.go:303-324`) and pushes
   its decision back; classification latency matches today's live push. v1's
   30 s registration-poll pickup is retracted; it misses the bootstrap's ~9 s
   budget.
4. Bootstrap polls relay-origin `/__pp/state` on today's budget (30 x 300 ms).
   Direct verdict: replace to `directUrl`; the guest never touches the cloud
   again. Relay verdict: replace to the relay origin.
5. relayd serves the entire guest surface by reverse-proxying tunnel streams to
   the Mac's loopback guest origin (`GuestRelayHandler` policy unchanged,
   `internal/server/server.go:349-381`). Every guest fetch is already a
   relative path, so the surface is origin-portable with zero page rewrites.
- R1 (navigation loop, P0, found independently by two adversarial reviews): as
  synthesized, a relayed guest on the relay origin would see
  `connection.joinUrl` pointing at the `r-` bootstrap (because `joinURLLocked`
  always prefers it), and `listener.html:2545-2551` navigates whenever mode is
  relay and the joinUrl origin differs from `location.origin`; the bootstrap's
  fast path would bounce straight back, forever, killing audio every 3 s.
  Mandatory fix: the `/api/status` connection object serializes `mode`,
  `joinUrl` (QR only), `relayOrigin`, and `directUrl`
  (`relay.Status.DirectURL` exists, `server.go:470-471`). The listener
  suppresses the relay-navigate branch when `location.origin` equals
  `relayOrigin`, navigates direct-to-relay using `relayOrigin`, and navigates
  relay-back-to-direct using `directUrl`, never `joinUrl`. Acceptance asserts a
  relayed phone survives 10+ consecutive status polls with zero navigations.
- R9 (flip hysteresis): one unreachable probe from a phone on cellular must not
  bounce a live room. While a broadcast is live with connected listeners, the
  Mac requires N consistent probes or M seconds of stability before changing an
  established mode (`applyProbe` is the single choke point); the listener
  navigates back to direct only after mode has been stably direct for at least
  10 s.
- R10 (QR liveness gate): `RelayConnected` means tunnel established AND state
  acknowledged by relayd (a state_ack mirror over the tunnel), and the
  `server.go:437-438` JoinURL gate keys on that, so a scannable QR again proves
  the probe path end to end.
- R11 (VPS-down verdicts): when the relay origin is unreachable but the direct
  probe succeeded, the bootstrap replaces to `directUrl` immediately AND fires
  one best-effort probe report to the Worker origin (one request per join) so
  the Mac still receives its verdict and the DJ console does not sit at
  Checking Wi-Fi forever.
- R12 (mid-party VPS death): a listener page that observes ~10 consecutive
  same-origin fetch failures while on a `*.relay` origin replaces itself to the
  `r-` bootstrap URL (derivable from the hostname token) to re-classify. Join
  fallback alone does not cover guests already inside a dead room.

### Media policy

Priority order unchanged: LL-HLS playlists and parts, then playback and status
calls, then presence, then text posts, then throttled photos; video unavailable
in relay mode.

- R14 (video guard fidelity): the rejection allowlist is ported from
  `worker.js:618-629` into relayd as one shared table-driven Go list with a
  test that diffs it against the Mac-side guard (`server.go:383-405`) so the
  two cannot drift. relayd rejects on headers and path with an immediate 409
  and connection close, draining no body bytes; the Mac-side guard remains as
  the invariant backstop.
- New relayd-served copy (reconnecting page, offline page, 503 text) carries
  the no-em-dash rule.

### Observability and ops

- `GET /__pp/health`: version, uptime, rooms, connections, bytes in and out,
  cache hit rate, non-coalesced playlist counter. Aggregates only.
- R13 (alerting, zero new infrastructure): the Worker cron already fires every
  minute; it fetches relay `/__pp/health` with a 5 s timeout, and on N
  consecutive failures sends an MXroute SMTP alert and flips a health flag that
  the register endpoint returns to Macs so the DJ UI can say the relay is
  unavailable. The same cron alerts when the served certificate's remaining
  validity drops below 25 days.
- Deploy: `scripts/deploy-relay.sh` cross-compiles static linux/amd64, uploads
  to a versioned path, flips a symlink, restarts systemd, health-checks, and
  installs journald/log caps. Bounded, idempotent, run through run-capped.
- Rollback, stated honestly in two tiers: relayd binary rollback is a symlink
  flip and restart, seconds, no DNS. A tunnel-protocol regression after the Mac
  ships is not rollback-able from the server side; the remedy is a VPS-side fix
  (fast) or a Mac re-ship (days standalone, weeks Store). Optional one-cycle
  mitigation: keep the WS client behind a build tag for one release so a
  Worker-side repoint can rescue the first tunnel build.
- Accepted, named risk: the grey record publishes the raw VPS IP with no DDoS
  shield in front of a bounded egress budget. Blast radius of VPS loss after
  R7/R11/R12: direct venues lose nothing, not even join latency; isolated
  venues fall back to the reconnecting flow.

## Costs, corrected

Per-listener egress is audio plus blocking playlist bodies: 40 KB/s audio plus
20-35 KB/s of playlist responses at 6.67/s, so roughly 0.20-0.24 GB per
listener-hour, not v1's 0.158 (that error was 35-50%). Consequences:

- Hetzner CPX11 (1 vCPU, 2 GB, 1 TB included US traffic): headroom roughly
  4,200-5,000 listener-hours per month. Price about 4.49 EUR plus about 0.50
  EUR for the primary IPv4, near $5.85 per month at spot EUR/USD. Flagged: the
  CPX11 US price and allowance were not verifiable on an official page
  (JS-rendered); verify in the order console before committing, 60 seconds.
- DigitalOcean Basic $6 per month (1 GiB RAM, 1,000 GiB pooled, $0.01/GiB
  overage): fully price-verified fallback, same conclusions.
- Fly.io: no included egress, linear $0.02/GB, roughly $8.4-12 per month at
  1,000 L; rejected as the end state.
- Optional lever: relayd may gzip playlist bodies toward guests (legal; the
  identity-encoding contract binds the Mac-facing side only), which would pull
  egress back toward the audio floor. Decide with a measured ratio, not an
  assumption.

Relay ingress stays near one copy per room subject to R15 measurement. Memory a
few MB per room. CPU is byte copying and TLS, and it is the term that grows with
listeners: budget a vCPU per roughly 2,000-3,000 small TLS responses per second,
so the launch 2-vCPU instance covers rooms into the low hundreds and the CPX31
class covers 500. VPS money cost is near flat by comparison; the current
architecture on Workers Paid would cost about $0.026-0.028 per listener-hour
forever AND still cap a room at the DO throughput ceiling, which is why paying
for it was rejected.

## Deletions, resequenced

Nothing is deleted until fielded installs no longer need it. During transition,
`/api/broker/relay/register` returns the legacy `connectUrl` AND the new
`relayUrl` plus grant; old clients ignore the new fields (`worker.js:478-482`
contract preserved).

Deleted at step 8, gated on adoption (zero legacy DO WebSocket connects for 14
days with the Store build live):

- Worker: `class RelayRoom` in full (`worker.js:691-962`), `relayConnect`
  (`:964-975`), the DO-proxy body of `relayPublicRequest` and its cache
  machinery, the `RELAY_ROOMS` binding and `relay-v1` migration with a
  `deleted_classes` follow-up.
- KEPT, correcting v1: `relayTokenFromHost`, `relayHost`, `relayTokenExists`,
  the `r-` dispatch branch, and the `*.partyparty.party/*` route. The bootstrap
  HTML moves from the DO into the stateless handler.

Deleted at step 2 (Mac, replaced in the same commit by the tunnel dialer):

- The entire WS session data plane, `relay.go:459-914`, plus
  `BinaryFrame`/`DecodeBinaryFrame` and the coder/websocket dependency.
- KEPT: `Manager`, the mode state machine and DJ-facing messages, the
  registration loop, the verdict store (24 h TTL, 32-network cap, no Wi-Fi
  names), `newOriginClient` redirect/cookie/identity semantics,
  `GuestRelayHandler`. Every existing Manager mode test passes unmodified;
  `TestOriginClientPreservesHLSCookieRedirect` semantics survive as tunnel
  tests.

## Implementation order

Gates are the exact AGENTS.md commands: `go build ./... && go vet ./... &&
gofmt -l .` (prints nothing) `&& go test ./...`; `cd cloudflare && node
test/smoke.mjs`; `cd app && swift build` where app/ is touched. One coherent
unit, one batched commit on main, one push, one standalone-beta ship. No Store
or TestFlight upload.

- Step 0, removed (v2.1, owner direction): no Workers Paid flip. The account
  stays on the free plan throughout; ~2 listener-hours per day of legacy relay
  headroom is sufficient for development and acceptance testing.
- Step 1, `internal/relayd` + `cmd/pprelay`: tunnel accept (audio+bulk), grant
  verification with R5 grace, room registry, RoundTrip proxy, single-flight
  with cookie-aware keying (R3), `/live/`-only rolling cache (R4), media policy
  with the shared video allowlist (R14), probe/state endpoints (R8), health,
  reconnecting page. Tests: concurrent blocking playlists with distinct
  directives never coalesce; two simultaneous fresh joins receive distinct
  MediaMTX session handshakes (R3); byte-for-byte HLS fidelity; cookie and
  redirect passthrough; cancellation on guest disconnect; allowlist parity
  (R14); content-free logging (R4).
- Step 2, Mac: two-connection tunnel dialer with the cross-connection audio
  priority gate (R2); tunnel-internal probe-verdict route into Manager (R8);
  `RelayConnected` keyed on relayd state ack (R10); probe hysteresis (R9);
  immediate re-register on grant rejection (R5); delete the WS data plane.
- Step 3, Worker + wrangler: register returns `relayUrl` + grant alongside the
  legacy `connectUrl`, persists `directUrl` to R2 (R6); bootstrap HTML moves to
  the stateless handler; bootstrap JS gains the concurrent probes with aborts
  (R7), relay-origin probe/state, the VPS-down direct fallback with the
  best-effort Worker probe report (R11). The DO path stays live. Extend
  `cloudflare/test/smoke.mjs` for the new bootstrap contract; existing DO
  coverage stays until step 8.
- Step 4, estate and host: create the one grey `*.relay.partyparty.party` A
  record; issue the new cert lineage; repoint the renew job log out of
  `build/` and verify one real launchd execution (R13 gate); provision the VPS;
  wire the cron health-check and cert-expiry alerts (R13); deploy. Verify: dig
  returns the VPS IP, not Cloudflare anycast; SNI handshake succeeds; a relayed
  response carries `x-pp-relay` and no `cf-ray`.
- Step 5, listener.html: serialize `relayOrigin` + `directUrl` in the status
  connection object and implement the R1 navigation guards; chip regex
  recognizes the relay origin; R12 mid-party rescue; R9 10 s stability gate.
  After any listener JS change, verify with browser console messages, not
  layout screenshots.
- Step 6, physical acceptance: the full codex/HANDOFF.md two-phone
  isolated-Wi-Fi run, plus a direct-venue run proving the direct path is
  byte-identical, plus the added assertions: zero navigations across 10+ polls
  on the relay origin (R1), distinct sessions for simultaneous joins (R3),
  Mac-uplink bytes near one copy as listeners join (R15), `x-pp-relay` present
  and `cf-ray` absent, strict analyzer pass.
- Step 7, ship: one batched commit, push once, standalone beta only, update the
  installed app.
- Step 8, decommission, gated on adoption: delete the DO path and binding. The
  Workers plan stays Free throughout; post-fix traffic is bootstrap-only and
  sits far inside 100k/day at any room size.

## Proofs that Worker usage is low frequency

1. Structural: relay hostnames are grey; traffic that never reaches the edge
   cannot execute a Worker. Asserted automatically: `x-pp-relay` present,
   `cf-ray` absent.
2. Measured: Workers analytics over a bounded relayed session against relayd's
   own counters; Worker requests must not scale with listener count or part
   rate.
3. Arithmetic: post-change Worker traffic is about one bootstrap request per
   guest join plus 120 registration refreshes per hour per DJ (12 per hour if
   open decision 7 is taken), versus about 52,000 per listener-hour today.

## Open decisions for the owner

1. Hosting. Recommend Hetzner CPX11, Hillsboro, budgeted $6-7 per month with
   the IPv4 add-on, price verified in the order console at purchase time, with
   the documented resize path to CPX31 class (~16 EUR) when rooms approach
   hundreds of listeners; the resize keeps the IP and takes minutes.
   Fully-verified alternative: DigitalOcean Basic $6. Choosing Fly.io costs
   linear egress forever; choosing EU Hetzner costs ~0.3 s for US venues.
2. Photos in relay mode at launch. Recommend enabled, under R2's Mac-enforced
   priority gate and the reduced 64-128 KB/s pace, with the kill switch ready.
   Shipping disabled costs guests photos at exactly the venues where relay
   runs; enabling later needs another ship.
3. Workers plan: stays Free throughout, per owner (the v2 paid bridge is
   removed). Post-fix Worker traffic is bootstrap-only and sits far inside the
   free tier, so nothing about the destination architecture ever needs the
   paid plan.
4. Legacy DO sunset window. Recommend deletion only after the Store build with
   the tunnel is live AND analytics show zero legacy connects for 14 days.
5. Second relay node for EU venues. Recommend deferring; a US-West single node
   serves an EU venue at roughly +0.3 s. Adding later is a second ~$6 node plus
   per-room relay assignment in the register response; no client change.
6. Push-media hybrid (b+). Recommend not at launch; adopt only if R15
   measurement shows playlist fan-out on the Mac uplink.
7. Registration cadence. Recommend slowing the 30 s refresh (currently 120
   requests per hour per DJ, `relay.go:42`) to about 5 minutes to match the
   grant lifetime, and keeping the tunnel dialed in all modes so the first
   isolated-venue guest never waits on a fresh dial.
