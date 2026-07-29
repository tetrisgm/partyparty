# Relay architecture (proposed replacement for the Durable Object proxy)

Status: design for review. No implementation has started.

## The defect

Every guest LL-HLS request currently executes application code in Cloudflare.

Path today: guest requests `https://r-<token>.partyparty.party/live/...`, the
`*.partyparty.party/*` route in `cloudflare/wrangler.jsonc:50` sends it to the
Worker, `worker.js:1032` extracts the token, `worker.js:982` runs
`relayPublicRequest`, which calls the `RelayRoom` Durable Object
(`worker.js:691`), which forwards the request over one custom WebSocket to the
Mac (`internal/relay/relay.go:482` `runSession`).

At the shipped geometry (500 ms segments, 150 ms parts, per
`codex/HANDOFF.md`) one listener generates about 6.67 media-part requests per
second plus about one blocking playlist request per part, so roughly 13 requests
per second, about 48,000 Worker invocations per listener-hour. Two listener-hours
exhaust the 100,000/day free allowance.

The edge cache at `worker.js:996` does not help the invocation count. With
`run_worker_first: true` (`wrangler.jsonc:12`) the Worker executes before the
cache is consulted, so a cache hit still bills a Worker request. Blocking
playlists are never cacheable at all.

This is a data-plane placement bug, not a polling bug. The fix is to remove
audio from the serverless control plane.

## Target shape

Three planes, cleanly separated.

1. Direct mode: unchanged. Certificate-backed LAN HTTPS LL-HLS straight from the
   Mac. No internet involvement. This stays the default and preferred path.
2. Control plane (Cloudflare Worker): low frequency only. Install
   authentication, room assignment, relay grant issuance, DNS and certificate
   coordination, the bootstrap probe page, and recording the reachability
   verdict. Never media.
3. Data plane (new relay service): a small always-on Go service on one VPS.
   Guests connect to it directly over HTTPS. Cloudflare is not in the path.

## Answers to the fifteen questions

### 1. What process runs the relay service?

A single static Go binary built from this repository: `cmd/pprelay` with the
logic in `internal/relayd/`. Same language as the Mac client, so the tunnel
protocol types, the media policy, and the offline page live in one shared
package and are covered by the existing `go test ./...` gate.

It runs under systemd as a non-root user with `Restart=always`.

### 2. Where is it initially hosted?

One small VPS in the US West region, close to the owner's venues: Hetzner CX22
in Hillsboro (about 4 euro per month, 20 TB egress included) is the
recommendation. DigitalOcean or Fly.io both work; Fly.io removes server
management but bills egress at about 0.02 USD per GB, which at roughly 2.8 GB
per listener-hour becomes the dominant cost at scale.

Requirements are modest: one stable public IPv4, 1 vCPU, 2 GB RAM, and a real
hostname. This is the one decision that needs the owner's preference before
implementation.

### 3. Which protocol connects Mac to relay?

A reverse HTTP/2 tunnel over TLS on port 443.

The Mac dials out to `relay.partyparty.party:443`, authenticates, and the
connection is upgraded to a raw stream. Then the roles invert relative to a
normal client: the Mac runs an HTTP/2 **server** on that connection
(`http2.Server.ServeConn` with the existing guest handler), and the relay runs
an HTTP/2 **client** on the same connection (`http2.Transport.NewClientConn`,
then `RoundTrip` per guest request).

This is deliberately boring. It buys, from the standard library and
`golang.org/x/net/http2`, everything the current code hand-rolls and gets wrong:

- Concurrent independent streams, so one photo cannot serialize behind audio.
- Per-stream flow control, which is real backpressure, replacing the manual
  512 KB window at `relay.go:38` and `relay.go:748`.
- `RST_STREAM` cancellation when a guest disconnects.
- `MaxConcurrentStreams` as a hard memory bound.
- Ordinary `http.Handler` semantics on the Mac, so the guest surface needs no
  reserialization into a custom frame format.

Outbound TLS on 443 is chosen over QUIC because it traverses restrictive venue
networks, which is exactly the population this feature exists for. The current
implementation already proves outbound WSS on 443 works from these networks.
QUIC stays a future option if head-of-line blocking is ever measured to matter.

Two tunnel connections per room, not one: `audio` and `bulk`. The relay routes
`/live/` to the audio connection and everything else to bulk. A single TCP
connection would let a large photo upload delay audio packets at the transport
layer regardless of HTTP/2 stream priorities, which are unreliable in practice.
Two connections make the isolation structural instead of advisory.

### 4. How are concurrent guest requests multiplexed?

HTTP/2 streams on the tunnel, one stream per guest request, with the flow
control, cancellation, and concurrency bounds listed above. There is no custom
framing, no manual window accounting, and no request id map to maintain.

Two additional mechanisms sit in front of the tunnel:

- **Single-flight.** Concurrent identical upstream requests are coalesced into
  one request to the Mac and streamed to every waiter as bytes arrive. This is
  what keeps the DJ's uplink flat as listeners grow, and it must stream rather
  than buffer so it adds no latency.
- **Rolling media cache.** Immutable parts and segments are cached in memory for
  about 60 seconds. Bounded by construction: 48 segments at 500 ms at 320 kbps
  is roughly 1 MB per room. Playlists are never cached, only coalesced, because
  a blocking playlist is a long poll.

Without these, N listeners would pull N copies from the Mac and the venue
uplink, not Cloudflare, becomes the bottleneck.

### 5. How are room credentials created and rotated?

The Worker keeps `authInstall` (`worker.js:968`) and mints an Ed25519-signed
relay grant containing `{roomToken, installID, exp}` with about a 10 minute
lifetime, returned from the existing `/api/broker/relay/register`
(`worker.js:462`).

The Mac presents the grant when dialing the relay. The relay verifies the
signature offline against a public key in its config, so connection
establishment costs zero Worker requests. The Worker holds the private key as a
secret.

Rotation: grants expire and are refreshed by the existing registration loop.
Live tunnels are validated at connect time and capped at a maximum session
lifetime (12 hours) to force periodic reauthentication. The 32-hex `roomToken`
shape is preserved so join URL handling stays stable.

### 6. How does the relay route a guest hostname to a Mac?

Subdomain per room: `https://<roomToken>.relay.partyparty.party`.

The relay reads the first DNS label, looks up `map[roomToken]*room` in memory,
selects the audio or bulk client connection by path, and reverse-proxies. If no
room is connected it returns the existing "The DJ is reconnecting" page
(`worker.js:597`), ported to Go, with a 503.

Subdomain per room rather than a path prefix is load-bearing for two reasons:

- The guest pages use absolute paths (`/live/...`, `/api/status`). A path prefix
  would require rewriting every URL in `listener.html` and `wall.html`, which is
  invasive and risky.
- MediaMTX establishes native HLS sessions with redirects and host-scoped
  cookies, which is why the origin client sets `CheckRedirect` to
  `ErrUseLastResponse` (`relay.go:586`). A shared hostname would put every room
  in one cookie jar and break native session isolation. Distinct hostnames keep
  cookies naturally scoped per room.

DNS: one wildcard record `*.relay.partyparty.party` to the relay IP. TLS: one
wildcard certificate via DNS-01 using the existing `CF_DNS_TOKEN` pattern,
renewed automatically and cached on disk.

### 7. How does the public guest URL avoid the Worker wildcard route?

The relay DNS records are **DNS-only (grey cloud, `proxied: false`)**.

Cloudflare Worker routes only execute for traffic proxied through Cloudflare's
edge. A grey record resolves straight to the relay's IP, so guest requests never
reach Cloudflare and no Worker can run. This is structural, not a matter of
route-pattern precedence.

This is already the proven pattern in this codebase: machine LAN hostnames are
written with `proxied: false` (`worker.js:274`, `worker.js:292`) precisely so
they bypass the edge.

The `r-<token>.partyparty.party` hostnames are retired. Since those proxied
hostnames were the only reason the `*.partyparty.party/*` route exists
(`wrangler.jsonc:50`, whose own comment calls it "operational plumbing"), the
route can be deleted once a check confirms no other proxied hostname depends on
it.

Automated proof, usable in CI: a proxied Cloudflare response always carries a
`cf-ray` header. A relayed guest response must carry the relay's own
`x-pp-relay` header and must **not** carry `cf-ray`. That single assertion
proves the edge was bypassed.

### 8. How is direct versus relay mode selected and persisted?

Unchanged in model, with one move out of the data plane.

Kept exactly as today: registration produces an opaque `NetworkKey`
(`activate.go:81`); the bootstrap page probes the real certificate-backed direct
URL; the browser reports only reachable true or false; the Mac is authoritative
and selects the mode for the whole room (`relay.go:303` `applyProbe`); the
verdict is cached per network key in `network-verdicts.json` with a 24 hour TTL
and a 32 entry cap (`relay.go:924`, `relay.go:947`); Wi-Fi names are never
stored; the QR always reflects the Mac's choice.

Changed: the probe result currently arrives as a `probe` control message on the
relay WebSocket (`relay.go:637`). That coupling forces a relay connection to
exist before classification. The browser will instead POST the probe result to
the Worker, and the Mac will pick it up on its next registration refresh. That
is about 2 Worker requests per minute per DJ, independent of listener count.

### 9. How is audio prioritized over photos?

Layered, strongest first:

1. Separate audio and bulk tunnel connections, so transport-level interference
   is impossible rather than merely discouraged.
2. Bulk connection runs a low `MaxConcurrentStreams`, a byte-rate limiter at the
   existing 256 KB/s (`worker.js:492`), and a 20 MB per-photo cap
   (`worker.js:493`).
3. Videos are rejected before their body enters the relay, preserving the
   current behavior at `worker.js:618` and `server.go:359`.
4. If measurement shows photos still perturb audio, photos are disabled in relay
   mode. The briefing's instruction is explicit and this design honors it:
   never risk audio to deliver a photo.

Priority order overall: LL-HLS playlists and parts, then playback and status
calls, then listener presence, then text posts, then throttled photos, with
video unavailable.

### 10. Expected bandwidth, memory, connection, and hosting costs

Per listener: 320 kbps AAC is about 40 KB/s, about 144 MB per hour.

Relay egress is the dominant term: N listeners cost N times 144 MB per hour.
Relay ingress stays at roughly one copy per room because of single-flight and
the rolling cache, which is the property that protects the DJ's uplink.

- 20 listeners: about 800 KB/s, about 2.8 GB per hour.
- A 20 TB monthly allowance covers roughly 7,000 listener-hours.

Memory: about 1 MB of cached media per active room plus HTTP/2 buffers, so a few
MB per room. A 2 GB instance holds far more rooms than the product needs.

Connections: 2 per DJ plus 1 to 2 per listener. Thousands fit comfortably.

CPU: byte copying and TLS. Negligible; not the constraint.

Hosting: about 4 to 5 USD per month, flat, versus a Cloudflare model whose cost
scales with the HLS part rate.

### 11. How is the relay deployed, monitored, and rolled back?

Deploy: `scripts/deploy-relay.sh` cross-compiles a static
`GOOS=linux GOARCH=amd64` binary, uploads it to a versioned path, flips a
symlink, restarts the systemd unit, and health-checks. Idempotent, bounded, and
run through `run-capped` like every other process in this repo.

Monitor: `GET /__pp/health` returns version, uptime, room count, connection
count, bytes in and out, and cache hit rate. No party content is exposed.

Rollback: repoint the symlink at the previous versioned binary and restart. DNS
does not change, so rollback is seconds and needs no propagation.

Blast radius is small by construction: only isolated-Wi-Fi venues use the relay.
If the relay is entirely down, direct mode is unaffected everywhere else, and
affected guests see the existing reconnecting page.

### 12. What code is deleted?

Worker (`cloudflare/worker.js`), about 400 lines:

- `class RelayRoom` in full (`worker.js:691` to `worker.js:962`).
- `relayConnect` (`worker.js:964`), `relayPublicRequest` (`worker.js:982`),
  `relayCacheablePath` (`worker.js:977`), `relayTokenFromHost`
  (`worker.js:495`), `relayHost` (`worker.js:243`), `relayTokenExists`
  (`worker.js:505`).
- The relay dispatch branches in `fetch` (`worker.js:1032` to `worker.js:1039`).
- Frame and window constants `RELAY_BINARY_ID_BYTES`, `RELAY_CHUNK_BYTES`,
  `RELAY_RESPONSE_WINDOW_BYTES`, `RELAY_RESPONSE_TIMEOUT_MS`
  (`worker.js:488` to `worker.js:491`).
- Media policy helpers and header filters (`worker.js:601` to `worker.js:660`)
  and `relayOfflinePage` (`worker.js:597`) move to Go rather than being deleted.

Kept in the Worker: `/api/broker/relay/register`, the bootstrap page
(`worker.js:523`), and a new low-frequency probe-report endpoint.

`cloudflare/wrangler.jsonc`:

- The `RELAY_ROOMS` Durable Object binding and the `relay-v1` migration, which
  needs a follow-up migration with `deleted_classes`.
- The `*.partyparty.party/*` route, after verifying nothing else proxied needs
  it.

Go (`internal/relay/relay.go`), about 500 of 997 lines:

- The entire session data plane: `session`, `runSession`, `handleIncoming`,
  `startRequest`, `serveRequest`, `ackResponse`, `finishRequestBody`,
  `completeRequest`, `cancelRequest`, `cancelRequests`, `writeOutgoing`, the
  `queue` family, and `relayAudioPath`.
- The request and response fields on `controlMessage`, plus `outgoing` and
  `requestBody`.
- `BinaryFrame` and `DecodeBinaryFrame` (`relay.go:987`, `relay.go:992`) and the
  `binaryIDBytes`, `maxChunkBytes`, `responseWindowBytes` constants.
- The `github.com/coder/websocket` dependency, if nothing else uses it.

Kept in Go: `Manager`, `Status`, the mode messages, the registration loop, the
verdict store, `applyProbe`, `SetDirectURL`, `Snapshot`, and `newOriginClient`
including its redirect behavior. `connectionLoop` is rewritten as a tunnel
dialer.

Tests deleted or replaced: `TestBinaryFrameRoundTrip`,
`TestSessionStreamsRequestAndResponseBodies`,
`TestSessionBackpressuresLargeResponses`,
`TestSessionQueuesLiveAudioAheadOfSecondaryResponses`,
`TestRunSessionProxiesARequestOverWebSocket`. Kept:
`TestOriginClientPreservesHLSCookieRedirect` and every Manager mode test.

### 13. How do Store and standalone editions use the same relay?

Identically, with no new permissions. Both already ship
`com.apple.security.network.client`
(`app/partyparty-app-store.entitlements`), which is all an outbound TLS
connection on 443 requires. No admin rights, no privileged helper, no Screen
Recording, no network reconfiguration, and no new prompt. Credentials remain the
existing anonymous install creds, so the account-free invariant holds. The two
editions keep their separate bundle identifiers and distribution channels.

### 14. How will two physical phones verify synchronization and locked-screen playback?

By running the isolated-Wi-Fi acceptance already written in `codex/HANDOFF.md`,
unchanged:

1. Relaunch on the client-isolated network; confirm the QR is withheld, then
   appears as `Checking Wi-Fi`.
2. First iPhone moves the whole room to relay with no dead direct page shown.
3. Second iPhone joins the same relay origin, becomes audible with no refresh,
   and stays within 1.0 second of the first.
4. Lock both phones at least 20 minutes; audio and lock-screen controls stay
   continuous and no recovery action runs while hidden.
5. Post text and a still photo; both arrive without affecting playback; the
   picker excludes video and a direct video request is rejected before its body
   enters the relay.
6. Interrupt the Mac's internet briefly; the console reports reconnecting and
   the room recovers.
7. `node scripts/analyze-session-log.mjs --strict <session.log>` reports no
   failed stream contract, startup-spread, or steady-room spread finding.

### 15. How will we prove Worker usage is low-frequency?

Three independent proofs:

- **Structural.** Relay hostnames are grey-clouded, so guest traffic cannot
  reach a Worker. Asserted automatically by the absence of `cf-ray` and the
  presence of `x-pp-relay` on a relayed guest response.
- **Measured.** Cloudflare Worker analytics over a bounded relayed listening
  session, compared against relay-side request counters from `/__pp/health`.
  Worker requests must not scale with listener count or part rate.
- **Arithmetic.** Post-change Worker traffic is registration (about 12 per hour
  per DJ), one probe report per new network, and one bootstrap page load per
  guest join. Expected under 30 Worker requests per hour per DJ regardless of
  listeners, against roughly 48,000 per listener-hour today.

## Implementation order

Each step is independently verifiable. Nothing ships until the whole unit is
verified, and it ships once.

1. `internal/relayd` plus `cmd/pprelay`: tunnel server, room registry, reverse
   proxy, single-flight, rolling cache, media policy, health endpoint. Unit and
   integration tests including concurrent playlist and part requests and a
   byte-for-byte comparison proving HLS bytes are unchanged.
2. Mac side: replace `connectionLoop` with the tunnel dialer, delete the session
   data plane, keep the mode logic.
3. Worker and wrangler: add the grant and probe-report endpoints, delete
   `RelayRoom`, the media proxy, and the wildcard route.
4. Provision the host, DNS, and wildcard certificate. Deploy and health-check.
5. Two-phone physical acceptance on both direct and isolated Wi-Fi.
6. Commit on `main`, push once, ship the standalone beta only, and update the
   installed app. No App Store Connect or TestFlight upload.

## Open decisions for the owner

1. Hosting provider and region (recommendation: Hetzner CX22, Hillsboro).
2. Whether photos stay enabled in relay mode at launch or ship disabled and get
   enabled after the priority scheduler is measured.
