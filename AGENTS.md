# PartyParty contract

Mac menu-bar party server; guests use HTTPS LL-HLS and the active-room feed.

- One room-wide reachability mode: direct/local/relay/no path. Relay sends one stream to `cmd/pporigin`; Cloudflare handles bootstrap/LAN certificates, never media. See `docs/relay-architecture.md`.
- iPhone uses native HLS/AVPlayer, never hls.js/ManagedMediaSource. Audio-core changes require supervised go-live testing. Before playback/playlist changes, read `docs/PLAYBACK-CONTRACT.md`.
- Relay prioritizes `/live/`; photos use a capped/throttled secondary path, videos never relay. Direct mode retains full media.
- Visual reference is shipped CSS in `web/listener.html`, not a design document: Geist, `#ff2d55`, warm grey, white cards, soft depth, weight-800 pill buttons. Change that source first.
- Upload/release only when the owner asks, never to debug or because code is ready. No automatic build/publish/deploy/reinstall jobs or commit triggers.
- TestFlight is invitation-only; the public site collects `/api/waitlist` addresses (admin-key reads), with no download. Mac App Store is active. Preserve the dormant Sparkle channel, `scripts/ship-standalone.sh`, appcast, and versioned R2 downloads; run only when asked.
- Pro is subscription-only. Never restore `fm.partyparty.app.pro.lifetime` or another one-off unlock.
- Apple work uses `asc`; start with `asc review doctor`. It reads `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY_PATH`; no custom API clients. Read exact App Review feedback first and classify binary/metadata/notes/account issues before code changes. Fix the requested issue before tooling work. Every submission requires owner intent (`APP_STORE_UPLOAD=1`/manual dispatch).
- Store builds require Apple-released macOS and `scripts/package-app-store.sh` for archive/export/verification. Never mix Sparkle, Developer ID entitlements, or standalone metadata into Store targets.
- No GitHub Actions workflows, secrets, or runners. Run project tests on the Mac; GitHub hosts git.
