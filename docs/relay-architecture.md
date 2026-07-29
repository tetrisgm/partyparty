# PartyParty network and sync architecture (v3)

Status: design for review. Supersedes v1 and v2, which were trade studies for
the relay data plane alone. This version is the whole shape: one timeline, one
schedule, three transports. No implementation has started.

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
4. The verdict is cached against the opaque network key, 24 hour expiry, with
   no Wi-Fi names stored. A LAN IP change returns immediately to checking.
   This is today's behavior (`internal/relay/relay.go:303-324`, `:947-976`) and
   it is kept.

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
  already sends. Spread is therefore continuously observable in production, on
  every network and device, rather than measured in one room on one afternoon.
- Server-side levers to shrink deviation, in order of how reliably they work:
  what the server publishes (deterministic), `PART-HOLD-BACK` (self-enforcing,
  since a player that ignores it stalls), and `EXT-X-START` (advisory, may be
  ignored). Design around the first two; treat the third as an optimization
  whose effect is visible in the reported numbers.
- D adapts from measured spread and stall rate instead of being a constant that
  someone guesses per venue.

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
- `app/Sources/partyparty/`: menu bar state text.

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

Acceptance: the full two-phone isolated-Wi-Fi run in `codex/HANDOFF.md`, plus a
relayed response carrying `x-pp-relay` and no `cf-ray`, plus Worker request
volume that does not scale with listener count.

## 8. Decisions needed

Section 6 is settled: single stable hostname, domain-wide router rule plus a
DHCP reservation, verified by the resolver check. Nothing there blocks Unit 1.

1. **Cloud host** for the relay origin. Roughly 6 to 7 USD per month at launch
   size, with a documented resize path for large rooms.
2. **Photos in RELAY mode** at launch: enabled behind the throttle, or dark
   until measured.

D is not a decision. It stays today's one-second target for LOCAL and DIRECT,
and for RELAY it is that plus the extra pipeline floor of the contribution hop.
Both are constants derived from the path, and neither responds to conditions.
The non-negotiable constraint on Unit 2 is that the room's delay never grows
because a listener is slow.
