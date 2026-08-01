# PartyParty network and sync architecture (v3)

Status: BUILT AND DEPLOYED, except where noted in section 9. Supersedes v1 and
v2, which were trade studies for the relay data plane alone. This version is the
whole shape: one timeline, one schedule, three transports.

## 1. The shape

One idea carries the whole design:

**Every chunk of audio is stamped, once, at capture, with the absolute
wall-clock time it was captured. The room publishes one number D. A chunk
stamped T is played at T + D. Every transport moves bytes without touching the
stamp.**

Consequences:

- Sync is decoupled from distribution. LAN, internet relay, or any future CDN
  are interchangeable, because the schedule travels with the audio.
- Mode stops mattering to the listener experience. Two phones obeying the same
  absolute instant agree whether they arrived over Wi-Fi or through the cloud.
- Every distribution question becomes an implementation detail of "move these
  bytes," not a sync question.

Two limits, stated honestly and neither mode-dependent:

- Native AVPlayer cannot be commanded to a schedule. We steer where playback
  starts and then it free-runs. Clock drift is parts per million, so starting
  on schedule means staying on schedule for a long time; the real divergence
  source is rebuffering, which is observable and correctable while visible.
- Output path is invisible. Bluetooth adds device-specific delay after the
  media clock. Two phones perfectly on schedule can still differ acoustically.
  Nothing in a web player can see or fix this.

So the promise is: together to within tens of milliseconds on the media clock,
and acoustically to within whatever each listener's headphones add.

## 2. Three modes, from two questions

The mode is not a single setting. It falls out of two independent facts:

- **A: can guests reach the Mac on this network?**
- **B: is the internet reachable from the Mac?**

| | B: internet | B: no internet |
|---|---|---|
| **A: guests can reach the Mac** | **DIRECT** (venue Wi-Fi) | **LOCAL** (travel router, dead uplink) |
| **A: guests cannot reach the Mac** | **RELAY** (isolated venue) | **NO PATH** |

Three viable modes, plus one genuinely impossible state that must be detected
and reported rather than left hanging. If guests cannot reach the Mac and there
is no internet, no software can carry audio between them. The console must say
so plainly instead of sitting on "checking" forever.

### Coverage, stated honestly

| Situation | Solution | Status |
|---|---|---|
| No internet, DJ controls the router | Domain-wide DNS rule plus DHCP reservation (section 6) | Solved |
| No internet, no router control, phones resolved recently | Immutable IP-derived names with a long TTL, so the cached answer survives (section 6) | Mitigated, bounded by TTL |
| No internet, no router control, phones never resolved | none | **Not solvable** |
| Venue Wi-Fi, devices can talk | DIRECT | Solved |
| Venue Wi-Fi, devices isolated | RELAY | Solved |
| No LAN path and no internet | NO PATH, detected and stated | Not solvable by anyone |

The one unsolvable case is a boundary, not an oversight. A guest phone with no
app must complete TLS for a name it can resolve. The certificate is never the
obstacle because every install holds the shared wildcard; resolution is. With
no internet and no way to add a router entry, the lookup has nowhere to go.
Every escape is closed by a decision already made: a bare IP fails certificate
validation and no public CA issues for private addresses; Bonjour resolves with
zero configuration but no CA validates `.local`; installing a private CA on
guest phones is not acceptable for a party; the Mac serving DNS needs the
router cooperation we assumed absent; and the Mac creating its own network is
the retired hotspot. This is the standard "HTTPS to a private address without
DNS control" limit for a no-app web guest.

Its practical scope is narrow: bring your own router and it is solved, use a
venue with working internet and it is solved, and a venue whose internet dies
mid-party is covered by the caching mitigation. What remains is a network you
do not control that has never had internet.

The important structural insight: **LOCAL and DIRECT are the same data path.**
Guests fetch HTTPS LL-HLS straight from the Mac in both. They differ only in
which supporting services are reachable:

| | LOCAL | DIRECT | RELAY |
|---|---|---|---|
| Audio path | Mac to phone on LAN | Mac to phone on LAN | Mac to cloud origin to phone |
| Certificate | cached | refreshed online | refreshed online |
| DNS A record | cannot update | updated on IP change | updated on IP change |
| QR target | direct URL | bootstrap URL | bootstrap URL |
| Isolation probe | not possible | via bootstrap | via bootstrap |
| Clock authority | the Mac | the Mac | the Mac, relayed |
| Photos and video | full | full | photos throttled, video off |

## 3. Detection and switching

Deterministic, and it already mostly exists:

1. The Mac attempts registration. Success or failure establishes **B**.
2. **B false** goes to LOCAL. The QR is the direct URL. No probe is possible,
   so LOCAL is assumed rather than proven. If guests then cannot connect, the
   console must surface NO PATH honestly rather than implying success.
3. **B true**: publish the A record, serve the bootstrap, and let the first
   guest's probe establish **A**. Reachable goes to DIRECT, unreachable goes to
   RELAY.
4. A successful direct verdict is cached against the opaque network key for 24
   hours, with no Wi-Fi names stored. A failed probe is treated as transient
   evidence and is never cached as a day's worth of isolation. Once direct
   reachability is proven, a later failed probe cannot demote the room; only a
   LAN transition clears that proof and starts a fresh decision. A LAN IP change
   returns immediately to checking. A relayed guest also keeps probing the
   direct URL and moves itself back to LAN when the direct path becomes
   reachable.

States the console and menu bar must be able to say: `checking`, `local`,
`direct`, `relay`, `no path`.

**Settings override.** Default Automatic. Manual choices are Prefer Direct,
Prefer Relay, and Local Only. Overrides are preferences with honest fallback,
never forced dead ends: choosing Prefer Direct on an isolated network still
reports that guests cannot connect rather than silently failing, and Prefer
Relay without internet reports NO PATH. Local Only is also the privacy choice,
since it guarantees no guest traffic leaves the venue.

## 4. Sync contract, identical in all three modes

- The Mac stamps at capture. The stamp is authored once and is never rewritten
  by any hop. **This is a hard constraint on every transport**, and it is the
  detail that fails invisibly: a cloud packager that re-stamps at its own
  ingest makes LOCAL and RELAY disagree while each still looks correct on its
  own.
- The room publishes D. A chunk stamped T plays at T + D.
- **D is declared, never discovered.** It is the pipeline floor (encode plus
  packaging, fixed and known) plus the hold-back the server writes into the
  playlist. Both terms are server-controlled, so a conforming player riding the
  live edge of a playlist we author is on schedule by construction. This needs
  no advisory tag to be honored, no command over AVPlayer, and no prior
  measurement at a venue. We control what "live" means by controlling what we
  publish.
- **D is a constant, and it never responds to listener conditions.** It is
  derived from the pipeline, not from any network, so it needs no per-venue
  tuning and no adaptation. It differs between modes only because the relay
  path has a larger floor, which is a derivation rather than a knob.
- **No room-wide value may ever be a function of listener health.** A slow
  device, or a hundred slow devices, must never lengthen the delay for anyone
  else. This is already enforced structurally: `latencyTarget` accepts
  broadcast status and room health and discards both
  (`internal/server/server.go:1314`), and the product previously had the
  opposite behavior, where a struggling peer moved room health and healthy
  players moved with it. That property is preserved, not revisited.
- Devices that cannot hold the schedule are handled **strictly per device**, by
  the existing visible-only forward governor that never runs while locked or
  backgrounded, and never affects a peer.

What the schedule buys is coherence, not adaptation: every device targets the
same declared point instead of independently choosing one. That removes spread
without adding latency and without anyone's phone influencing anyone else's.
- **The Mac is the clock authority in every mode.** Guests sync to the Mac
  directly when they can reach it, and to the Mac's clock carried by the relay
  when they cannot. One authority in all modes means offline drift is
  self-consistent and no mode depends on NTP quality.
- Every guest reports its deviation from the schedule in the heartbeat it
  already sends. This is telemetry for the DJ console and the analyzer only. It
  is never an input to any room-wide value.
- Server-side levers to shrink deviation, in order of how reliably they work:
  what the server publishes (deterministic), `PART-HOLD-BACK` (self-enforcing,
  since a player that ignores it stalls), and `EXT-X-START` (advisory, may be
  ignored). Design around the first two; treat the third as an optimization.

Existing pieces this builds on rather than replaces: PDT is already emitted and
already read by both players (`web/listener.html:1325-1339`), per-listener
latency already rides the heartbeat, and `LatencySpread()`
(`internal/stats/stats.go:213`) plus the session analyzer already compute
startup and steady-state spread with pass and fail thresholds.

## 5. RELAY data plane

The current relay is architecturally wrong in a way no amount of payment fixes.
Guests fetch from Cloudflare, a Worker runs per request (`run_worker_first`
means even cache hits bill), and a Durable Object proxies every request over
one WebSocket to the Mac. That is about 14.5 requests per second per listener,
roughly 52,000 per listener-hour, and the Durable Object's approximately 1,000
requests per second ceiling caps a room near 20 to 40 listeners at any price.
A 500 person party needs about 7,250 requests per second. Paying for that path
buys a ceiling, so there is no bridge worth taking.

The normal streaming shape is contribution, then origin, then fan-out. The Mac
should be a **contributor, not an origin**:

- In RELAY mode the Mac pushes **one** outbound stream to a cloud origin,
  roughly 0.32 Mbps regardless of whether 5 or 500 people are listening.
- The cloud origin runs MediaMTX, the same binary already shipped in
  `assets/mediamtx`, with the same geometry, and serves LL-HLS over HTTPS.
- Guests fetch from it. Native AVPlayer, plain HTTPS GETs, lock-screen
  playback unchanged.
- Beyond one box, put a CDN in front or add origins. Immutable HLS parts are
  exactly what caches are built for.

Why this over the reverse tunnel v2 recommended: one copy on the DJ uplink
becomes a structural fact instead of depending on request coalescing working;
the Mac leaves the request path entirely so a 500 person room is a cloud
sizing question, not a laptop question; the media is already at the origin
before anyone asks for it; and the custom framing, flow control, single-flight,
and rolling cache all exist only to compensate for an origin stuck behind NAT,
so they disappear.

The constraint from section 4 applies with force: the contribution protocol
must carry the capture timestamp so the cloud origin publishes the Mac's
timeline rather than its own.

The room API (status, feed, posts, photos) still needs the Mac. That is a much
smaller problem than media, roughly 1.15 requests per second per listener, and
it is the standard media plane plus control plane split. It is the part of this
design with the most remaining detail to work out.

Retained from the v2 study, still valid: the wildcard estate stays exactly as
it is (the QR encodes the bootstrap hostname in every mode, the names resolve
with zero provisioning, and the one historical wildcard pathology is already
cured); relay media hostnames must be grey-clouded so no Worker can execute;
and the Worker keeps only bootstrap, registration, and DNS coordination.

## 6. LOCAL mode: name resolution is a runtime check, not an assumption

LOCAL mode needs the guest's phone to resolve the Mac's hostname without any
internet. Whether that works depends entirely on whether the network's resolver
answers for our name, which is a property of the network, not something to
assume either way.

**We can check it, and the check already exists.** `observeResolver`
(`internal/activate/activate.go:551`) queries the network's own configured
resolver with `PreferGo: true`, so it bypasses the macOS cache and asks the
network rather than itself, and reports whether the hostname resolves to the
Mac's current LAN IP. It returns structured evidence (`Matches`, `Addrs`,
`Err`) and a stable `resolver_mismatch` reason code
(`activate.go:59`, `:72`, `:209-213`). Today this is activation and LAN
readiness evidence; it is promoted here to drive mode selection.

**A bare IP is not an option, but an IP-encoded name is free.** Connecting to
`https://192.168.1.117:8443` fails certificate validation, no public CA issues
for RFC1918 addresses, and HTTPS-only is non-negotiable. However
`scripts/issue-wildcard.sh` issues `*.party.partyparty.party`, described at
`activate.go:170` as "the ONLY cert path for broker installs," and every
install fetches that same shared wildcard. So any label under it is already
covered with zero new issuance, including an IP-derived one such as
`192-168-1-117.party.partyparty.party`. The certificate is never the obstacle.
Only resolution is.

This gives LOCAL a clean, checkable definition:

- **Resolver answers for our name** (`Matches` true): LOCAL is viable. Serve
  the direct link. No internet required for anything in the guest path.
- **Resolver does not answer**: LOCAL cannot work on this network. This is a
  fact about the venue's DNS, reported as such, with the remedy stated (add a
  host entry on a router you control, or use a network with internet).

**Reachability needs no cloud probe in LOCAL mode.** The bootstrap probe exists
because on an online network we want to know about client isolation before a
guest hits a dead page. Offline there is no bootstrap and no relay to fall back
to, so the proof is simpler: a guest that loads the page has demonstrated both
resolution and reachability. If no guest connects, the resolver observation
distinguishes the two causes, which is what makes the message actionable rather
than a shrug:

- resolver mismatch: the network is not resolving our name.
- resolver matches but nothing connects: the network is isolating devices, and
  with no internet there is no relay, so this is NO PATH.

**Router setup for a DJ-controlled network, sturdiest form.** Two one-time
settings, then set and forget:

1. A **domain-wide DNS rule** answering everything under `party.partyparty.party`
   with the Mac's address (dnsmasq form: `address=/party.partyparty.party/<ip>`,
   which most consumer travel routers run). Domain-wide rather than
   host-specific so it survives a re-provisioned install, a changed hostname,
   or any label we add later.
2. A **DHCP reservation** for the Mac. This is the one that matters: the only
   real failure mode is the Mac's address changing after a lease expiry or
   router reboot, which silently aims the rule at whichever device inherited
   the address.

The resolver check above verifies both, so a misconfiguration is reported
rather than discovered by guests.

**Caching mitigation for networks you do not control.** Today the A record
carries a 60 second TTL (`cloudflare/worker.js:274`), chosen so an address
change reconverges quickly. That short TTL is also why a phone cannot survive
the uplink dying mid-party: its cached answer expires within a minute.

An **IP-derived name is immutable**, because the name states the address, so
the mapping can never go stale and can safely carry a long TTL. Publishing
`192-168-1-117.party.partyparty.party` alongside the stable hostname gives both
properties at once: address drift is handled by minting a new name rather than
waiting out a cache, and a phone that resolved once holds a valid answer for
hours. It costs no new certificate work, since the shared wildcard already
covers any label.

This converts "the venue's internet died at 11pm" from a party-ending event
into a non-event. It does nothing for a network that never had internet, where
nothing was ever cached.

Rejected alternatives, recorded so they are not revisited:

- **IP-encoded labels as a router-configuration shortcut.** They help caching,
  above, but not configuration. A router wildcard maps every *name* to one
  *address*, not the reverse, so it cannot decode an address out of a label;
  dnsmasq's synth-domain can, but its label format is implementation-specific
  and coupling our naming to one router is the opposite of sturdy.
- **Mac as the network's DNS server** via DHCP option 6. Self-heals on IP
  change, but the router must advertise the Mac's address, which is the very
  thing that moves; it makes network-wide DNS depend on the app running; and it
  drifts toward the DNS-hijacking pattern the product retired.
- **Bonjour `.local`.** The only zero-config option, blocked by TLS: no public
  CA validates `.local`, and HTTPS-only is non-negotiable.

## 7. Plan

Three units, in dependency order. Each is independently shippable, verified with
the AGENTS.md gates (`go build ./... && go vet ./... && gofmt -l .` printing
nothing `&& go test ./...`; `cd cloudflare && node test/smoke.mjs`;
`cd app && swift build` when `app/` is touched), committed as one batched
commit on `main`, pushed once, and shipped to the standalone beta only. No App
Store or TestFlight upload.

Sequencing rationale: Unit 1 defines the states Unit 3 must slot into, and Unit
2 defines the invariant Unit 3 must preserve, namely that the capture stamp and
the declared schedule survive the relay unmodified. Building the relay first
would mean rewriting it once the rest is settled. No unit waits on a field
observation before it can be designed.

### Unit 1: the mode model

Goal: five honest states derived from evidence, plus an override.

Changes:
- `internal/relay/relay.go`: add `ModeLocal` and `ModeNoPath`. Replace the
  degrade-to-direct behavior in `noteRegistrationFailure` (`:283-294`) with one
  pure decision function over (internet reachable, resolver observation, probe
  result, override) returning mode plus a stable reason code. Keep the verdict
  cache, the network key, and the 24 hour expiry unchanged.
- `internal/activate`: expose the latest `ResolverObservation` (`:524-564`) so
  the manager can read it. It is computed already; it is not currently
  reachable from the mode decision.
- `internal/server/server.go`: surface mode, reason code, and resolver evidence
  on `/api/status`; add a persisted mode-override setting endpoint.
- `web/dj.html`: copy for all five states, and the override control
  (Automatic, Prefer Direct, Prefer Relay, Local Only).
- `app/Sources/PartyParty/`: menu bar state text.

Tests: a table test over every (internet, resolver, probe, override)
combination asserting mode and reason code; NO PATH is reached only when the
network is genuinely unserviceable; override precedence never lies (Prefer
Relay without internet reports NO PATH rather than pretending); every existing
manager mode test passes unmodified.

Acceptance: normal venue Wi-Fi behaves exactly as today. With the Mac's
internet disabled but the router still resolving, the room reports LOCAL, the
QR is the direct link, and guests still join and hear audio. On a network with
neither internet nor resolution, the console states NO PATH with the resolver
reason instead of sitting on checking.

### Unit 2: the scheduled playout contract

Goal: the schedule is authored by the server and true by construction, with its
value maintained by an algorithm rather than by anyone testing venues.

Two earlier drafts of this unit were wrong in opposite directions. One split it
into "observe at a party, then decide," which is per-venue tuning. The other
added a controller that widened the delay when devices struggled, which lets a
slow phone drag the whole room. Both are rejected. The schedule is a constant
the server authors, and nothing about it responds to conditions.

Changes:
- Publish D on `/api/status` as the room's declared delay, defined as the
  pipeline floor plus a fixed declared hold-back. It stays a compile-time
  constant per mode, in the spirit of `roomLatencyTarget`
  (`internal/server/playback.go:7`).
- Author the playlist so the live edge is the scheduled point: set the declared
  hold-back rather than relying on `EXT-X-START` being honored. Replace the
  tests that assert `EXT-X-START` absence
  (`internal/server/handlers_test.go:1277`, `:1291`) with tests that assert the
  declared hold-back is exactly what we intend.
- Each guest reports its deviation from the schedule in the heartbeat it
  already sends. This is telemetry only. It feeds the DJ console and the
  analyzer, and it must never feed back into any room-wide value.
- Devices that fall behind are corrected individually by the existing
  visible-only forward governor. Locked and backgrounded playback is never
  touched, and no correction is ever triggered by a peer's condition.
- Confirm the PDT stamp originates at capture, since Unit 3 depends on it
  surviving unmodified.

Tests: the delay identity (declared hold-back plus floor equals published D)
against authored playlists; deviation math against synthetic heartbeats; and an
explicit regression test that the room's published target is invariant across
every broadcast status and health value, so the `latencyTarget(_, _)` property
at `internal/server/server.go:1314` cannot be eroded later.

Acceptance: room spread tightens against today's behavior with **no increase**
in the one-second target, and a deliberately crippled device (throttled
network) changes nothing for its peers. Verified by
`node scripts/analyze-session-log.mjs --strict`, with the mic kit as an
occasional check on the output-path layer telemetry structurally cannot see.

### Unit 3: the relay data plane

Goal: replace the Durable Object proxy with push-to-origin.

Changes: contribution from the Mac (one outbound stream, capture stamp
preserved); MediaMTX on a cloud host serving LL-HLS to guests; the room API
plane; grey-clouded relay hostnames; bootstrap handoff to the relay origin.
Deletes the Worker media proxy, the `RelayRoom` Durable Object, the
`RELAY_ROOMS` binding, and the Mac's custom WebSocket session code
(`internal/relay/relay.go:459-914`), while keeping the wildcard estate, the
bootstrap, registration, and DNS coordination exactly as they are.

The room API plane is the part with the most remaining detail and should be
designed concretely at the start of this unit rather than assumed.

Deletion of the legacy path is gated on fleet adoption, not on the new path
working, so fielded installs are never stranded.

Acceptance: a relayed response carrying the origin's own headers rather than a
Cloudflare edge's, and Worker request volume that does not scale with listener
count.

## 8. Decisions needed

Section 6 is settled: single stable hostname, domain-wide router rule plus a
DHCP reservation, verified by the resolver check. Nothing there blocks Unit 1.

1. **Cloud host** for the relay origin. Settled: Hetzner CPX11 in Hillsboro,
   about 5.85 USD per month with the IPv4 add-on, with DigitalOcean's 6 USD box
   as the fallback if fully verified pricing matters more than the last dollar.

   A fan-out relay is bandwidth bound, so the only number that decides this is
   cost per TB of egress: Hetzner about 1.17 USD per TB after a 1 TB allowance
   (the well known 20 TB figure is EU only; US plans include 1 TB, still roughly
   4,500 listener-hours), DigitalOcean 10 USD per TB after 1 TB, and Fly.io 20
   USD per TB with NO included egress at all. At 0.22 GB per listener-hour, one
   500 person four hour party is 440 GB: nothing on Hetzner or DigitalOcean
   because it fits the included terabyte, and 8.80 USD on Fly. Four such parties
   a month is about 7 USD on Hetzner, 14 on DigitalOcean, and 40 on Fly.

   Platform-as-a-service hosting was briefly recommended for having no server to
   administer. That is worth roughly thirty minutes once, plus unattended
   upgrades, and it is not worth paying seventeen times per terabyte forever for
   a service whose whole job is sending bytes. The deploy script makes day to day
   operation one command on any of them.

   Note the HLS-push contribution decision is independent of this. It exists so
   the capture timestamp survives to relayed guests; that it also frees the
   origin from needing a raw TCP port is a bonus, not the reason.
2. **Photos in RELAY mode** at launch: enabled behind the throttle, or dark
   until measured.

D is not a decision. It stays today's one-second target for LOCAL and DIRECT,
and for RELAY it is that plus the extra pipeline floor of the contribution hop.
Both are constants derived from the path, and neither responds to conditions.
The non-negotiable constraint on Unit 2 is that the room's delay never grows
because a listener is slow.


## 9. Build status

Units 1 and 2 are complete. Unit 3's origin is deployed and verified in
production; its remaining work is listed below.

**Shipped and verified**

- The mode model: five states from one pure decision function
  (`internal/relay/mode.go`), the resolver observation promoted to a decision
  input, the DJ override at `/api/connection-mode`, and console and menu bar copy.
- The schedule: the `/live` proxy authors the declared hold-back
  (`internal/server/schedule.go`), and a regression test sweeps every broadcast
  state, health value, bitrate, and listener count to prove the room delay never
  moves in response to conditions.
- Contribution (`internal/contribute`): forwards this Mac's own LL-HLS byte for
  byte, so the capture stamp survives, with no encoder in the path at all.
- The room plane (`internal/roomplane`): reads served from the origin, heartbeats
  aggregated into one digest, writes queued for the Mac.
- The origin (`internal/origin`, `cmd/pporigin`): authenticated publish,
  credential-free guest reads, blocking playlist reloads, bounded media window,
  idle rooms swept.
- Mode wiring: contribution starts and stops with RELAY.

**Live infrastructure**

Running on the existing Oracle box in us-sanjose-1 that also serves
chiptunes.app, at about 39 ms from the owner's Mac. Grey DNS for
`relay.partyparty.party` and `*.relay.partyparty.party`, a wildcard certificate
renewed by certbot and hot-reloaded without a restart, and systemd weights giving
PartyParty a roughly 25 to 1 CPU share under contention while leaving the radio
untouched when no party is live.

Verified in production: authenticated publish accepted, unauthenticated publish
refused, guest fetch byte identical with PROGRAM-DATE-TIME intact, and a blocking
reload genuinely held before returning a playlist rather than an error.

**Remaining**

Nothing in this design. The legacy relay is deleted rather than deprecated: the
`RelayRoom` Durable Object, the Worker media proxy, the WebSocket connect
endpoint, the Mac's socket data plane, and the loopback origin that fed it are
gone, and the `RELAY_ROOMS` binding is retired with a delete migration. Room
credentials are minted per install by the broker. The guest bootstrap hands off
to the relay origin, and the listener carries the guard that stops a relayed
guest bouncing between the origin and the bootstrap.

Fielded installs speaking the old protocol stopped relaying when that shipped,
which was the owner's explicit call.

What is left is operational rather than architectural: run a real party and read
the numbers the system already reports. The session analyzer computes startup and
steady-room spread from every party automatically, `/__pp/health` reports the
origin's rooms and media, and the DJ console shows the room's declared delay
against its measured spread. If those disagree with this document, this document
is wrong.

**Addendum, 2026-07-29: the day the halves were joined**

The design above was correct and the implementation of each half passed its
tests, and the first time a phone was actually pointed at it, five wiring gaps
surfaced, each invisible to unit tests and each fatal alone. They are recorded
here because their SHAPE is the lesson: every one was a place where two
components each honored their own contract and nobody had proven the joint.

The contributor fetched a playlist path MediaMTX does not serve, and could not
have read it anyway without the session cookie the multivariant playlist hands
out. The declared hold-back was authored only on the direct path, so relayed
guests would have run on the muxer's raw value. The origin validated publish
credentials against a static file while the broker mints them per install. The
room API plane existed, was tested, and was never started. The origin served no
guest page at all.

After those: the origin's oldest-first eviction deleted the two files uploaded
once per set (the guest page and the init segment) as soon as a set outlived
the live window, which is about three minutes. Heartbeats arrived as GET, were
counted only on POST, and a phone audibly playing counted as nobody. The
listener's long-poll assumed a parking server and became a seven-per-second hot
loop against a snapshot origin; room snapshots now carry content versions, the
origin parks on an ETag match, and the page paces itself against any server
that answers instantly. An origin restart is now detected by an epoch on every
PUT response, and the fixed-name assets are pinned and re-sent. RELAY is only
claimed after the origin's health endpoint answers. Offline LOCAL required a
resolver observation that the cached-certificate path never made.

All of it is now verified end to end: a real iPhone in the simulator playing
the relayed stream from the origin, the DJ console reading "1 listening (1 via
relay)", three feed requests in thirty-five seconds where there would have been
two hundred thirty, and an offline server settling on LOCAL with the direct URL
in its QR. Releases ship through a launchd daemon
(net.ramine.partyparty.autoship) from a dedicated clone, gated on receipts,
with the Worker resolving release downloads from the bucket by name so a ship
edits no source. The Worker cron probes the origin every minute and keeps
outage transitions at /api/relay-canary. Every set writes its own report into
the event folder.

Still owed to reality: a party with more phones than one simulator, on a venue
network nobody controls.
