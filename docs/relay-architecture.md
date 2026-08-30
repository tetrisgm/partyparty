# PartyParty network and relay architecture

This document describes the system that ships. PartyParty is a local-first
macOS party server. The Cloudflare Worker coordinates anonymous setup and guest
bootstrap, but it never proxies media. When venue Wi-Fi isolates guests, the
Mac contributes one copy of its existing LL-HLS output to `cmd/pporigin`, which
serves the same bytes to every relayed listener.

## 1. One room-wide path

The Mac selects one connection mode for the room from three facts: internet
reachability, whether the local resolver answers for the Mac's secure hostname,
and the result of a real guest's direct-path probe.

| Mode | Guest path | When it applies |
|---|---|---|
| `checking` | bootstrap pending | Network evidence is not settled yet. |
| `direct` | phone -> Mac over HTTPS | Internet works and a guest proves the LAN path. |
| `local` | phone -> Mac over HTTPS | Internet is unavailable but local DNS can resolve the Mac. |
| `relay` | phone -> origin; Mac -> origin once | A guest proves the LAN is isolated and cloud reach is enabled. |
| `no_path` | none | Neither an allowed direct path nor a working relay exists. |

`direct` and `local` use the same data path. Their names distinguish which
supporting services are available, not how audio reaches a phone. `no_path` is
an honest product state, not a retry loop disguised as one.

The DJ can choose Wi-Fi only or Wi-Fi + cloud, and can apply direct, relay, or
local preferences. A preference never fabricates reachability: selecting relay
without internet, or Wi-Fi only on an isolated venue network, produces
`no_path` with a stable reason code.

A successful direct verdict is stored against an opaque network key for at most
24 hours. Failed probes are transient. A LAN-address change clears the probe so
evidence from one network cannot silently choose the path on another.

## 2. Guest bootstrap and local HTTPS

Each installation receives an anonymous install identity, a memorable hostname
under `party.partyparty.party`, and certificate material from the Worker-backed
broker. There is no DJ account or guest account.

On an online network the public bootstrap tries the certificate-backed direct
URL and reports whether the guest can reach the Mac. It then sends the guest to
the direct URL or the room's relay origin. In local mode the QR points straight
to the Mac so joining does not depend on an unavailable public service.

The Mac checks the network's configured resolver directly. A cached certificate
is useful only when that resolver maps the hostname to the current LAN address.
A router the DJ controls can provide that record together with a DHCP
reservation.

A bare IP cannot satisfy the hostname certificate. The only exception is an
explicitly degraded HTTP link to the exact current LAN IP. It is offered only
when there is no internet relay and the local resolver is proven unable to
resolve the secure hostname. Locked-screen playback is not promised on that
path.

The Worker is limited to control-plane duties:

- product website and dormant standalone-update metadata;
- anonymous install registration and certificate/DNS coordination;
- relay registration, publish-credential verification, bootstrap, and health
  routing.

It does not receive HLS playlists, media parts, guest photos, room snapshots, or
listener requests. The former media-proxy Durable Object and WebSocket tunnel
are retired.

## 3. Fixed playback contract

Every viable mode publishes the same fixed room target:

- 500 ms segments;
- 150 ms parts;
- 48 retained segments;
- `PART-HOLD-BACK` floor of 0.9 seconds;
- `EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES` in the multivariant playlist;
- `schedule.Delay == 3s` everywhere.

The relay does not add a second target and no listener can change the room-wide
value. Native HLS/AVPlayer is the production iPhone engine. Healthy playback is
passive: the page does not continuously seek or rate-steer it. A visible phone
that remains at least 750 ms beyond the target for three measurements receives
a fresh native HLS attachment. That correction remains available throughout a
set and never runs while Safari is hidden or the phone is locked.

The Mac's playlists carry `PROGRAM-DATE-TIME`. Contribution uploads playlists
and media without repackaging or re-encoding them, so direct and relayed guests
see the same capture timeline. The origin stores and serves those bytes
unchanged.

Any change to this geometry or attachment position requires the real-AVPlayer
pre-upload soak and supervised physical test in `AGENTS.md`. Browser engines,
unit tests, and a playlist proxy cannot establish audible native behavior.

## 4. Relay media plane

`internal/contribute` reads the Mac's loopback LL-HLS output and publishes one
copy of each live object to the broker-selected room origin. Contribution is an
outbound client; the Mac is not in a relayed guest's request path.

The contributor:

- discovers the actual media playlist through the multivariant playlist;
- uploads the matching guest page and its fixed assets;
- sends every referenced media object once per origin incarnation;
- preserves playlists and media byte for byte;
- notices origin restarts through the room epoch and republishes fixed assets;
- cancels obsolete work when enablement or broker target changes.

`cmd/pporigin` authenticates Mac uploads with a per-install publish credential.
Guest reads need no credential. Each room is held only in memory and has bounded
media, photo, listener, snapshot, and write state. Idle rooms expire. Blocking
playlist reloads wait for the requested part or a short deadline instead of
turning LL-HLS into rapid polling.

This makes Mac uplink and work essentially independent of attendance: the Mac
uploads each part once whether five or five hundred guests listen. Origin egress
and connection capacity are the scaling dimensions.

## 5. Relay room plane

Audio and interactive room state have different traffic shapes, so the origin
handles them separately:

- **Reads:** the Mac publishes bounded status and feed snapshots; guests read
  the in-memory replica without reaching the Mac.
- **Presence:** guest heartbeats are aggregated into a periodic digest rather
  than forwarded one by one.
- **Writes:** posts, reactions, comments, requests, and moderation inputs enter
  a bounded queue that the Mac drains and applies as the authoritative writer.

Snapshot versions change only when bytes change, allowing the origin to hold a
guest poll until the relevant state advances. A full write queue rejects new
work instead of growing without bound or claiming acceptance.

Relay mode is deliberately music-first. Still photos use capped storage,
bounded concurrency, and a throttled secondary path. Videos are unavailable
and never enter the relay. Direct and local modes retain the full LAN media
experience.

No relay component creates a durable party, recording, replay, or public event
page. A quiet room's rolling state disappears.

## 6. Multi-Mac rooms

Macs on the same LAN advertise through Bonjour and exchange authenticated room
snapshots. A Mac joining an already active party adopts that party identity so
the room remains one logical event. The local event store is authoritative for
that Mac's writes; peer snapshots are immutable copies merged for presentation.

Peer discovery is supplementary. Losing a peer cannot stop local capture,
playback, or guest service, and peer data must remain bounded and safe to read
while discovery refreshes it.

## 7. Failure boundaries

- Broker failure with a valid cached certificate can still produce `local` if
  the venue resolver answers correctly.
- Origin health failure prevents claiming `relay`; it cannot be hidden behind a
  successful broker registration.
- A target or credential replacement invalidates in-flight contribution work;
  results from the old registration must not mutate the new session.
- Origin restart is normal: the epoch forces the Mac to republish the page,
  assets, initialization object, and live window.
- Missing timing telemetry never interrupts audio and never changes the fixed
  delay.
- Guest-controlled identities, uploads, queues, response bodies, and idle
  connections are all bounded so an unattended room cannot grow memory or
  goroutines without limit.

## 8. Verification boundary

Repository tests cover the mode decision table, activation persistence,
contribution lifecycle, origin authorization and bounds, room-plane semantics,
playlist preservation, and direct/relay HTTP contracts. The production
playback geometry additionally requires the AVPlayer soak before upload.

The remaining field checks are intentionally physical: secure joining on a
real iPhone, a many-phone venue relay, and a supervised direct-versus-relay
timing set. Those observations belong in `docs/HANDOFF.md`; they are not grounds
for silently adapting the schedule.
