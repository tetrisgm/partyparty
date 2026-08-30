# PartyParty.party handoff

This file contains current facts that are easy to lose between sessions. Git
history holds the old narrative; retired designs do not belong here.

## Product boundary

PartyParty is the macOS app that broadcasts one live DJ set to phones in the
room. A DJ runs the app, guests scan a QR code, and nobody signs in. There is no
account, profile, cloud-party, public-event, recording, replay, payment, or
remote-journal layer in this repository.

The anonymous install identity used by `internal/activate` is operational
authentication for hostname, certificate, DNS, and relay registration. It is
not a user account. `internal/contribute` is the live relay publisher, not the
deleted account-era cloud synchronization system.

Another product can answer account and journal paths on the shared
`partyparty.party` apex. It is maintained elsewhere and is not ours to deploy,
delete, or reconstruct. This repository owns the product site, anonymous LAN
broker, relay registration/bootstrap, machine namespace, and dormant
standalone-update plumbing represented in `cloudflare/`.

The codebase is intentionally simple at its outer edge:

- `main.go` wires the Go server, capture, event store, peer discovery,
  activation, room-mode manager, and relay contributor.
- `web/` contains the embedded vanilla HTML/CSS/JavaScript guest, wall, and DJ
  surfaces. They must work without a runtime internet dependency.
- `app/` is the native macOS shell and permission/menu-bar surface.
- `internal/contribute`, `internal/roomplane`, and `cmd/pporigin` form the
  transient relay path described in `docs/relay-architecture.md`.
- `cloudflare/` is the only Worker in this tree. It never carries media.

## Playback and capture invariants

Production audio is native HLS/AVPlayer on iPhone. hls.js is a non-Apple
fallback; hls.js/ManagedMediaSource caused repeated audible seeks on iPhone and
is not a production option.

The production geometry is fixed at 320 kbps stereo AAC-LC, 500 ms segments,
150 ms parts, 48 retained segments, a 0.9-second `PART-HOLD-BACK` floor, and
`schedule.Delay == 3s`. The multivariant playlist carries
`EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES`. Direct, local, and relay publish
one declared room target. It is never adaptive and never listener-specific.

Healthy native playback is passive. A visible phone at least 750 ms beyond the
target for three measurements receives a fresh HLS attachment. Corrections stay
available for the whole set; there is no per-session cap. They do not run while
Safari is hidden or the phone is locked, and missing telemetry alone never
interrupts audio.

Do not change delay, hold-back, attachment position, segment/part shape, or the
audio core without the pre-upload real-AVPlayer soak and supervised physical
test required by `AGENTS.md`. Unit tests, WebKit, computed browser state, and a
playlist proxy cannot prove audible native playback.

### Unresolved direct/relay measurement (2026-08-11)

A muted real AVPlayer measured the direct path at about **1.17 seconds** and the
relay path at about **3.33 seconds**, despite the declared three-second target.
This leaves the common direct path without the intended cushion and puts mixed
direct/relay guests roughly 2.2 seconds apart. It is reproduced and not fixed.

`scripts/bench-playlist-proxy.py` is not valid evidence for attachment position:
it produced roughly 3.1 seconds whether the pin was on the multivariant, also on
the media playlist, or absent. The synchronous proxy itself makes the player
fall behind. A candidate must be measured through the real guest path during a
supervised set. Do not lower the declared target to match the accidental direct
measurement; the cushion exists to absorb venue Wi-Fi stalls.

### Shack15 cutoff cause and fix

The 2026-08-04 silence keepalive fired 120 ms after the last real capture frame,
inside normal HAL jitter, and spliced zeros into live audio. The current
two-clock design leaves real audio exclusively on device sample time, starts
wall-clock filler only after 1.5 seconds without real frames, and fades real
audio back over 5 ms. On a silent Mac the aggregate device clock can stop
entirely, so delayed wall-clock filler is required. A silent-to-music test
produced no `gapHistory` growth after this change.

Compiling on the DJ Mac during a set has caused capture strain and audible
cutoffs. Do not build while it is broadcasting.

## Shazam status

A Mac Development-signed build matched two real tracks from system output,
including catalog artwork, so live `SHSession` catalog recognition works in a
properly provisioned development build. Ad-hoc builds do not reach Shazam and
are not a valid recognition test.

The App ID has the ShazamKit capability, but inspected Mac development and App
Store provisioning profiles did not expose a Shazam entitlement; a binary that
claims `com.apple.developer.shazamkit` is killed at launch. Do not add that
entitlement speculatively. Recognition in a fielded App Store/TestFlight build
has not been verified, and resolving that Apple-side ambiguity remains separate
from the already-proven development behavior.

## Network facts

Direct and local guests use the Mac's HTTPS server. Relay guests use the origin;
the Mac pushes each HLS object once and is not in their request path. Relay
photos are capped and throttled, and videos never enter the relay.

The LAN resolver used during the 2026-08-11 investigation cached negative
answers for the zone's 1,800-second SOA minimum. Looking up a name before its
record existed made system resolution fail for half an hour even while public
authoritative lookups succeeded. Create a record before testing it, and wait
out a poisoned cache. Flushing or reconfiguring the NAS resolver is shared
infrastructure work and is not part of a product task.

For offline use, a valid cached certificate is not enough: the venue resolver
must still map the secure hostname to the current LAN IP. The app observes that
resolver directly. Only when internet relay is unavailable and secure local
resolution is proven impossible may it expose the exact-IP HTTP emergency
link; locked-screen playback is not promised there.

Do not judge relay room health by fetching an `r-<token>` bootstrap hostname;
that endpoint intentionally returns the probe-and-redirect page. Media health
belongs to the room's `*.relay.partyparty.party` origin or the origin health
endpoint. Relay presence and relay media are separate planes, so one being
fresh does not prove the other works.

## Local party and multi-Mac state

Party data lives under the activation state directory in one folder per party.
The folder contains guest media and a static recap; journals, thumbnails,
identities, and reports live in its private state. The app does not retain a
recording of the music.

Macs on the same LAN advertise through Bonjour. A Mac going live can adopt an
active peer's party identity and join the same room instead of creating a rival
event. Peer posts remain owned by their source Mac and media URLs are rewritten
to that source. Guests can re-home to another member when one Mac disappears.

Event journals are compatibility surfaces. New fields must replay safely with
old lines, mutations must be written before being acknowledged, and remote
timestamps must never control a local logical clock.

## Distribution boundary

The active release lanes are the Mac App Store and invitation-only TestFlight.
Uploading happens only when the owner explicitly asks. The standalone Sparkle
lane is dormant but intentionally retained for already-installed builds. No
commit, timer, launch agent, workflow, or watcher may publish or install a
release automatically.

Store and standalone artifacts are separate products of the same source commit.
Do not let Sparkle, Developer ID entitlements, or standalone update metadata
enter the Store target. App Store operations use `asc` and the repository's
packaging/verification scripts; no upload is a diagnostic step.

## Deep review record (2026-08-30)

The current review is deliberately landing as small commits. Completed work so
far includes:

- removed account-era tests, reconciliation/moderation APIs, duplicate reply
  handlers, unused UI assets/fonts, and stale ignore entries;
- bounded unauthenticated origin operations, Worker request bodies, idle HTTP
  connections, guest identities, listener telemetry, peer snapshots, queues,
  and relay photo work;
- serialized or coalesced listener status, wall polling/rendering, and native
  status refreshes; avoided deep-copying unchanged feed history;
- hardened DJ authorization, relay TLS, upload paths, malformed relay writes,
  origin restarts, track-deletion journaling, and immutable event snapshots;
- made relay mode transitions generation-aware and updated the web surfaces to
  avoid rapid polling and unnecessary DOM/QR reconstruction;
- replaced the obsolete account, one-second playback, and Durable
  Object/WebSocket documentation with the system that ships.

Activation certificate/identity atomicity, relay contribution lifecycle, and
cross-Mac feed cursor correctness are under focused concurrency review. Do not
call this audit complete until those increments land and the full Go, race,
browser, Worker, and Swift gates pass from a clean tree.

## Owed to physical reality

- Join through the wildcard certificate on a real iPhone.
- Run a relayed party with many real phones on venue Wi-Fi.
- Measure direct and relay playback together during a supervised set, then make
  any geometry decision from that evidence.
- Verify Shazam recognition in the actual App Store/TestFlight signing lane.

These are field-verification debts, not invitations to deploy, upload, alter
shared infrastructure, or claim native Safari behavior from simulation.
