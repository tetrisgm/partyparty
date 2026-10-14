# PartyParty contract

Mac menu-bar party server; guests use HTTPS LL-HLS and the active-room feed.

- One room-wide reachability mode: direct/local/relay/no path. Relay sends one stream to `cmd/pporigin`; Cloudflare handles bootstrap/LAN certificates, never media. See `docs/relay-architecture.md`.
- iPhone uses native HLS/AVPlayer, never hls.js/ManagedMediaSource. Audio-core changes require supervised go-live testing. Before playback/playlist changes, read `docs/PLAYBACK-CONTRACT.md`.
- Relay prioritizes `/live/`; photos use a capped/throttled secondary path, videos never relay. Direct mode retains full media.
- Visual reference is shipped CSS in `web/listener.html`, not a design document: Geist, `#ff2d55`, warm grey, white cards, soft depth, weight-800 pill buttons. Change that source first.
- Upload/release only when the owner asks, never to debug or because code is ready. No automatic build/publish/deploy/reinstall jobs or commit triggers.
- Distribution is the Mac App Store (live since 125.51, 2026-10-14); site CTAs use `/go/appstore/*`. TestFlight is for testers only. Keep `/api/waitlist` and its stored addresses (admin-key reads), though the site no longer collects them. Preserve the dormant Sparkle channel, `scripts/ship-standalone.sh`, appcast, and versioned R2 downloads; run only when asked.
- Pro is subscription-only. Never restore `fm.partyparty.app.pro.lifetime` or another one-off unlock.
- Before Apple review, packaging, or upload work, read `docs/APPLE-RELEASE.md`.
- No GitHub Actions workflows, secrets, or runners.

## Deploys

- Pushing to `main` deploys nothing. The `partyparty-site` Worker (`cloudflare/`)
  deploys with `wrangler deploy` from the Mac, and app builds follow
  `docs/APPLE-RELEASE.md`, only when the owner asks.
- Cloud sessions cannot deploy: that needs the Mac's wrangler login, keys and
  Keychain. Push a branch or open a PR and say what needs shipping.
- Nothing from the owner's Mac reaches cloud sessions: not their global
  instructions, logins, or Keychain. Do not go looking for them.
