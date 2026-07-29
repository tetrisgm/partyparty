# Relay architecture v2 (trade study and replacement design)

Status: design for review, second revision. Supersedes v1 (commit 5d82c95) after
owner review. No implementation has started.

How this revision was produced: five parallel code and market recon passes
(Worker flow, Mac relay client, wildcard and certificate estate, Cloudflare and
VPS economics with live verification on 2026-07-28, alternative architectures),
one synthesis, then three independent adversarial reviews (guest flow,
invariants, numbers and ops). The adversarial findings are folded in below as
normative requirements, marked R1..R16. Where a number could not be verified
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

## Trade study

Options evaluated. L = listener-hours per month; costs at L = 10/50/200/1000.

| Option | Added latency | LL-HLS blocking fidelity | Cost at 10/50/200/1000 L | Code delta | 2 am story | Verdict |
|---|---|---|---|---|---|---|
| (a) Status quo on Workers Paid | Baseline; edge+DO tens of ms | Yes (45 s DO timeout covers the hold) | ~$5.00/$5.30/$6.60/$27.5-28.5, marginal ~$0.026-0.028 per L forever | 0 | Cloudflare's problem, but nothing you can do during their incident | BRIDGE ONLY |
| (b) VPS reverse HTTP/2 tunnel | One RTT guest-VPS + VPS-Mac, ~10-40 ms each US West; under one 150 ms part | Yes: long-poll RoundTrip per blocking request, single-flight keyed so distinct directives never coalesce | ~$6-7 flat at all four | Write ~1,000-1,500 Go + deploy script + bootstrap JS; delete ~800 protocol lines net | One VPS: systemd, disk, cert, provider outage; cron-alerted (R13) | PRIMARY |
| (c) Minimal-delta VPS: port RelayRoom keeping the custom WS protocol | Same transport physics as (b) | Yes, field-proven protocol (32ccfd8, 33c5294) | Same as (b) | Write ~300-500 Go port; zero Mac delta (ConnectURL is Worker-issued and opaque) | Same VPS burden, plus today's single-WS defects survive | FALLBACK |
| (d) R2 mirror plane | +3-6 s glass to glass | No. A passive object store cannot hold a GET until `_HLS_msn` exists; blocking is unimplementable | $0 to ~$138 depending on listeners per room | Revive ~850 lines of retired livemirror (e4df0da, retired 0a13bf8) | Low | REJECT: destroys in-room sync and the ~1.0 s target |
| (e) DO to guest WebSocket push | n/a | n/a | n/a | n/a | n/a | REJECT: locked iPhones require native AVPlayer over plain HTTPS GETs; pushed bytes only reach a player via page JS, which suspends on lock |
| (f) Off-the-shelf tunnels (frp, rathole, ssh -R, WireGuard) | Comparable to (b) | Raw TCP passes it, no media layer | ~$6 flat plus a foreign binary to supervise | Bundle and supervise a second binary in both editions, then still write the media policy layer | VPS plus supply chain | REJECT: WireGuard needs entitlements the product forbids; the rest converge to (b) plus dead weight |
| (g) Pure TCP/SNI passthrough splice | Lowest; MediaMTX answers blocking natively; Mac terminates TLS with its existing cert | Perfect | ~$6 flat in money | New splice protocol both ends anyway (Mac cannot accept inbound) | VPS plus splice daemon | REJECT: encrypted passthrough forbids relay-side single-flight and cache, so the venue uplink carries N full copies (~6.4 Mbps upstream at 20 listeners) on exactly the hostile Wi-Fi this mode exists for; the photo throttle cannot exist at a path-blind relay; the e2e win is symbolic since every install holds the wildcard key |
| (b+) Push-media hybrid on (b) | Slightly better first-request | Yes, but relayd must own LL-HLS playlist semantics against real AVPlayer behavior | Same as (b) | Moderate extra relayd complexity | Same as (b) | DEFERRED: the designated escape hatch if R15 measurement shows playlist fan-out (open decision 6) |
| Geometry knob: widen parts in relay mode | +1.0-1.5 s | Yes | $0 | Tiny | None | REJECT: degrades the latency north star and leaves media in the Worker |

Cost crossovers, derived from the tables (the v1 claim of 800-1,000 L was not
derivable and is retracted): Workers Paid total exceeds the transition state
(VPS plus Workers Paid, ~$11-12) at roughly 380-400 L per month, and exceeds a
standalone VPS (~$6, post-decommission) at roughly 45 L per month, because DO
request overage begins near 20 L.

The decisive non-cost facts against (a) as the destination: the DO soft limit of
1,000 requests per second caps one room somewhere near 20-40 listeners no matter
what is paid (unmeasured; measure once with `wrangler tail` during the bridge,
R16); every media byte transits single-threaded JS frame slicing; DO eviction
mid-party orphans in-flight requests (in-memory pending map, `worker.js:695`);
and a Cloudflare incident takes the relay down with no action available to you.

## Recommendation

1. BRIDGE, today, zero code: flip the Cloudflare account to Workers Paid
   ($5/month). 10M included requests cover roughly 192 relay listener-hours per
   month, then $0.30 per million, about $0.026-0.028 per marginal listener-hour
   all-in. This un-kills the product while the real fix is built, and it moves
   audio proxying from the ToS-grey free tier onto the explicitly sanctioned
   paid Developer Platform (CDN large-file carve-out, verified live
   2026-07-28). It is a plan flip, not an architecture; do not let it calcify.
2. PRIMARY: option (b), the VPS reverse HTTP/2 tunnel, with the hostname scheme
   below and requirements R1..R16.
3. FALLBACK: option (c), held in reserve, adopted only if (b)'s two-phone
   acceptance surfaces an HTTP/2-specific failure not fixable within the unit.

Why (b) over (c), argued on engineering risk: (c)'s unique advantage is zero Mac
delta with retroactive fleet coverage, but the bridge neutralizes that urgency
entirely; fielded 124.x installs keep relaying through the DO at pennies while
the real fix lands. (c)'s risk is reimplementation divergence in ~270 lines of
subtle DO protocol, and the two bug classes that protocol already paid for in
the field, response compression (33c5294) and the cookie/redirect handshake for
native HLS sessions (32ccfd8), are precisely the class a port re-risks. And (c)
is a throwaway: its ported code is exactly what (b) exists to delete, namely the
hand-rolled 512 KB ack window (`relay.go:38`, `:747-757`), the 20 s
single-write stall that drops every listener at once (`relay.go:600-604`), and
the shared audio FIFO with no per-listener fairness (`relay.go:890-905`).
Building (c) first, then (b), buys nothing the bridge does not already buy.

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
few MB per room. CPU is byte copying and TLS. VPS money cost is flat; the
current architecture on Workers Paid costs about $0.026-0.028 per listener-hour
forever and caps a room at the DO throughput ceiling.

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

- Step 0, bridge, today, zero code: flip to Workers Paid. Verify: one phone
  joins a relayed room end to end. Optionally run `wrangler tail` once to
  measure the true DO message rate (R16).
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
- Step 8, decommission, gated on adoption: delete the DO path and binding;
  optionally return the Workers plan to Free (post-fix traffic is
  bootstrap-only and sits far inside 100k/day).

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
   the IPv4 add-on, price verified in the order console at purchase time.
   Fully-verified alternative: DigitalOcean Basic $6. Choosing Fly.io costs
   linear egress forever; choosing EU Hetzner costs ~0.3 s for US venues.
2. Photos in relay mode at launch. Recommend enabled, under R2's Mac-enforced
   priority gate and the reduced 64-128 KB/s pace, with the kill switch ready.
   Shipping disabled costs guests photos at exactly the venues where relay
   runs; enabling later needs another ship.
3. Workers plan after decommission. Recommend keeping Paid through the
   transition (it is the bridge), dropping to Free after step 8. Keeping Paid
   anyway is $5/month headroom insurance, defensible.
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
