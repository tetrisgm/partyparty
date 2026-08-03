# PartyParty.party agent contract

PartyParty is a macOS menu-bar app that turns a DJ's Mac into a live party
server. Guests scan a secure QR code and use HTTPS LL-HLS plus the active-room
feed.

## Architecture

The Mac chooses one room-wide mode from guest reachability and internet
reachability: direct, local, relay, or no path. In relay mode the Mac pushes one
copy of its LL-HLS stream to `cmd/pporigin`, which fans out the original
playlists. The Cloudflare Worker handles bootstrap and anonymous LAN
certificate coordination but never carries media. See
`docs/relay-architecture.md`.

## Product Invariants

1. Guests join, listen, and post on the LAN without accounts or internet.
2. The paid App Store download is the purchase boundary. Do not add product
   login, licensing, profiles, or network checks before Go Live.
3. Guest playback is HTTPS LL-HLS only. Do not restore plain HTTP.
4. Cloud relay state is ephemeral. Do not add public party pages, replays,
   recordings, archives, or cloud feeds.
5. Do not modify `internal/broadcast/` autonomously. It owns ffmpeg, tee, and
   MediaMTX behavior.
6. Do not add an authentication email service.
7. Do not restore hotspots, Internet Sharing, captive portals, DNS hijacking,
   or automatic network reconfiguration.
8. Apple guests use native HLS/AVPlayer for background and lock-screen audio.
9. Room delay never tracks listener count; correction is per device.
10. Store and standalone builds are isolated. Store builds are sandboxed and
    Apple-updated; standalone builds use a separate bundle ID and Sparkle.

## Apple

- Uploading to TestFlight or App Store Connect happens ONLY when the owner asks
  for it. Never as a debugging probe, never because a fix looks ready. Six
  builds went up in five days that nobody requested; each one is permanent in
  App Store Connect, spends beta-review capacity, and notifies real testers.
  `APP_STORE_UPLOAD=1` and the manual workflow dispatch are the decision point,
  not a formality.
- No launchd job, cron, or watcher builds, publishes, deploys, or reinstalls
  this project on its own. Automation that fires on a commit turns ordinary
  development into unrequested releases. Releasing is a decision, not a trigger.
- The Mac App Store and TestFlight are the active distribution lane. The
  standalone Sparkle channel is DORMANT, not retired: `scripts/ship-standalone.sh`,
  the appcast, and the R2 download plumbing stay intact and working so the option
  can be taken up again. Do not delete them, and do not run them without being
  asked.
- `asc` (App Store Connect CLI, `brew install asc`) is the tool for every App
  Store and TestFlight operation: `asc review doctor` before anything, then
  `asc review status`, `asc versions`, `asc builds`, `asc testflight`. It reads
  ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY_PATH. Do not hand-roll API
  clients; `asc review doctor` names blockers directly and is the first thing to
  run when a submission will not go through.
- What App Review asks for outranks everything else. Read the reviewer's
  feedback on the App Review page FIRST and fix exactly that. Packaging,
  tooling and CI work are downstream of it and must never be done instead of it.
- Never flood App Store Connect. Every submission is permanent and visible;
  two of the three submissions on this app's record were made by an API key
  without anyone asking. A submission is a deliberate act by the owner.
- Build Store packages only on an Apple-released macOS host.
- `scripts/package-app-store.sh` owns archive, export, and package verification.
- Before changing code after an Apple rejection, inspect the exact review
  message and classify whether it concerns binary, metadata, review notes, or
  account state.
- Never mix Sparkle, Developer ID entitlements, or standalone update metadata
  into the Store target.
