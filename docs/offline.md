# Offline-First Architecture

partyparty has an offline-first guest model and an activation-gated DJ app model. Keep those separate.

## Guest Model

Guests join the Mac directly over the LAN. The Mac serves the guest page, stream, wall, media, and guest APIs from the local Go server in [internal/server/server.go](../internal/server/server.go) and [internal/server/feed.go](../internal/server/feed.go). The guest UI lives in [web/listener.html](../web/listener.html) and [web/wall.html](../web/wall.html).

Per [AGENTS.md](../AGENTS.md), guests must be able to join, listen, and post with no account and no internet. Do not gate these on web auth, device activation, or cloud reachability:

- `/`
- `/wall`
- `/hls/`
- `/api/status`
- `/api/heartbeat`
- guest media, reaction, comment, request, upload, and feed routes
- `listener.html`
- `wall.html`

The local server decides DJ-vs-guest by client address: loopback is the DJ console, LAN peers are guests. `requireDJ` in [internal/server/feed.go](../internal/server/feed.go) protects DJ-only controls, but guest feed and playback routes remain public to the LAN.

Guest streaming is local. The cloud may host account pages, broker install activation, OTA metadata, and published MP3 replay pages, but live audio is served by the Mac. Do not introduce a cloud live-audio relay.

## Secure Guest Link

Guests should use the HTTPS + LL-HLS path. [AGENTS.md](../AGENTS.md) explicitly says not to reintroduce a plain-HTTP guest fallback.

The secure-link implementation is in [internal/activate/activate.go](../internal/activate/activate.go), [main.go](../main.go), and [internal/server/server.go](../internal/server/server.go):

- The broker or BYO Cloudflare path obtains a publicly trusted certificate with DNS-01.
- The guest hostname points at the Mac's LAN IP, so guests still connect locally.
- `realCert()` in [internal/server/server.go](../internal/server/server.go) reports when the HTTPS guest link is actually servable.
- `activate.CachedCertReady` in [internal/activate/activate.go](../internal/activate/activate.go) lets a previously activated Mac reuse a still-valid cached cert offline.

If online refresh fails, the app should keep trying in the background and keep any already engaged cached secure link. It must not move live audio to the cloud.

## DJ App Model

The DJ app is allowed to require activation. This is separate from guest access.

The shipped gate is:

- `web/dj.html` blocks the console until local `/api/account/status` reports a linked account.
- `/api/account/status` in [internal/server/server.go](../internal/server/server.go) calls `activate.AccountStatus` in [internal/activate/activate.go](../internal/activate/activate.go).
- A linked online response is cached locally as `account.json`.
- If the broker is unreachable later, the cached linked account unlocks the app offline.
- `POST /api/start` in [internal/server/server.go](../internal/server/server.go) returns `403 not_activated` until the process activation latch is true.

The activation latch is deliberately process-local. It prevents a never-linked Mac from going live, but it does not stop a running set if the account is later revoked or signed out; the next launch starts gated again.

## Change Rule

When changing auth, activation, networking, or guest UI:

- Account and activation checks may protect the DJ console and DJ-only local APIs.
- Guest routes must continue to work on the LAN with no account and no internet.
- Secure guest streaming must stay Mac-local over HTTPS + LL-HLS.
- The Cloudflare Worker remains optional for live parties except for first activation, account/device linking, OTA/update metadata, and publishing replays after the event.
