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

Rejected alternatives, recorded so they are not revisited:

- **IP-encoded labels offline.** They solve stale DNS caches during online IP
  drift, which is a real problem, but not one LOCAL has: a travel router's
  resolver is authoritative and instant. A router wildcard maps every *name* to
  one *address*, not the reverse, so it cannot decode an IP from a label;
  dnsmasq's synth-domain can, but its label format is implementation-specific
  and coupling our naming to one router is the opposite of sturdy.
- **Mac as the network's DNS server** via DHCP option 6. Self-heals on IP
  change, but the router must advertise the Mac's address, which is the very
  thing that moves; it makes network-wide DNS depend on the app running; and it
  drifts toward the DNS-hijacking pattern the product retired.
- **Bonjour `.local`.** The only zero-config option, blocked by TLS: no public
  CA validates `.local`, and HTTPS-only is non-negotiable.

## 7. Plan

Three independently shippable units, in dependency order. Each is verified with
the AGENTS.md gates (`go build ./... && go vet ./... && gofmt -l .` printing
nothing `&& go test ./...`, `cd cloudflare && node test/smoke.mjs`, and
`cd app && swift build` when `app/` is touched), committed on `main`, and
shipped to the standalone beta only.

**Unit 1: the mode model.** Make the three modes and the impossible state
explicit and honest end to end: the two-axis state machine, LOCAL as a first
class mode rather than a registration failure, NO PATH detection and copy, the
console and menu bar states, and the Automatic plus manual override setting.
Small, touches no audio, and makes current behavior truthful. It is the
skeleton the other two hang on.

**Unit 2: the sync contract.** Publish D, carry the capture stamp end to end,
report per-guest deviation, and make D adapt from observed spread. Applies to
all three modes at once because it is mode independent. Verified against the
existing analyzer thresholds, with the mic kit as an occasional check on the
output-path layer that telemetry structurally cannot see.

**Unit 3: the relay data plane.** Replace the Durable Object proxy with
push-to-origin: contribution from the Mac, MediaMTX on a cloud host, guests
fetching from it, and the room API plane. Deletes the Worker media proxy, the
Durable Object, and the Mac's custom WebSocket session code. Gated by the two
phone isolated-Wi-Fi acceptance in `codex/HANDOFF.md`.

Sequencing rationale: Unit 1 defines the states Unit 3 must slot into; Unit 2
defines the invariant Unit 3 must preserve (the stamp). Building the relay
first would mean rewriting it once both are settled.

## 8. Decisions needed

Section 6 is settled: single stable hostname, domain-wide router rule plus a
DHCP reservation, verified by the resolver check. Nothing there blocks Unit 1.

1. **Cloud host** for the relay origin. Roughly 6 to 7 USD per month at launch
   size, with a documented resize path for large rooms.
2. **D default**, and whether D may differ between LOCAL/DIRECT and RELAY. One
   value is seamless across a mode flip; per-mode is lower latency on LAN.
3. **Photos in RELAY mode** at launch: enabled behind the throttle, or dark
   until measured.
