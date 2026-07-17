# partyparty web service architecture

> Updated 2026-07-17 after the `partyparty.party` domain cutover. The earlier
> cloud-live-mirror proposal is superseded: live audio stays on the DJ's Mac.

## Public cloud surface

The Cloudflare Worker at `https://partyparty.party` provides account sign-in,
permanent DJ handles, event replay pages, app downloads, OTA payloads, and the
live-party discovery registry. A permanent party link is
`https://<handle>.partyparty.party/`.

The cloud does not relay live audio. While a set is live, the Mac serves the
guest page and LL-HLS stream directly over the LAN at its activated HTTPS host.
The Worker may redirect a permanent handle to that host, but the media path is
guest-to-Mac. R2 stores completed MP3 replays and release artifacts only.

## Live discovery

The Mac sends authenticated `/api/broker/live` presence heartbeats while it is
broadcasting. `GET /api/discover` returns a small list of unexpired parties with
their direct `joinUrl` values. The public landing page probes those URLs from the
guest's browser and shows the LIVE NOW banner only when a LAN host is reachable.
Rows without a `joinUrl` are ignored. Public-IP matching is only an ordering hint;
the LAN probe is the reachability gate.

This keeps discovery best-effort and preserves the offline contract: QR/direct
LAN join, listening, heartbeats, and wall posting never require the Worker or a
guest account.

## Guest-facing links

- The DJ console and projected wall prefer `urls.public`, the permanent handle.
- If no public link can work (offline/captive mode or no handle), they fall back
  to `urls.primary`, the Mac's direct HTTPS guest URL.
- The guest page shares its current direct URL so nearby guests can still join
  without internet.
- Guest playback is HTTPS + LL-HLS only. There is no plain-HTTP guest fallback.

## Source map

- `internal/server/server.go`: LAN routes, `/api/status`, URL selection, guest API.
- `web/listener.html`: direct LAN guest player, join sheet, and party feed.
- `web/dj.html`: DJ console, activation gate, guest URL and QR rendering.
- `web/wall.html`: projected room wall and guest QR.
- `site/index.html`: public landing and LAN reachability probe.
- `cloudflare/worker.js`: auth, handles, discovery registry, replay pages, and OTA.

For current playback experiments and physical-device qualification, see
[`scheduled-live-playout-plan.md`](scheduled-live-playout-plan.md).
