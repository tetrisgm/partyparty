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

## Audio and playback

Native HLS/AVPlayer is the proven iPhone engine: smooth, low latency, and it
continues while the phone is locked. hls.js/ManagedMediaSource on iPhone caused
repeated audible seek skips and is not a production option.

The stable production geometry is 500 ms segments, 150 ms parts, and a
48-segment window. Capture backpressure is held off by bounded capture buffering
and non-blocking ffmpeg tee outputs; the audio core must not change without a
supervised go-live test. Any change to playlist geometry or playback
positioning (hold-back, EXT-X-START, the room delay, segment/part shape)
additionally requires a real-AVPlayer soak BEFORE it reaches TestFlight: a
desktop Safari listener attached to the live stream, its playback position
watched against the live edge for at least ten minutes, with zero backward
movement. Unit and contract tests cannot hear AVPlayer: 125.37 shipped a
green-tested playlist whose PART-HOLD-BACK pointed outside the parts region,
and AVPlayer audibly rolled a live listener back within minutes (2026-08-05).
Playback moving backward is never acceptable.

The room target is a FIXED three seconds (schedule.Delay; PART-HOLD-BACK
2.9 s), chosen for stability over immediacy (owner decision, 2026-08-05): the
cushion is sized so ordinary venue Wi-Fi stalls pass silently instead of
reaching ears. At the Shack15 re-test the published feed was gapless all
afternoon while phones riding ~1 s heard every radio burst and a phone at
~2.6 s heard none of them; the knife edge was the product's only remaining
audible failure, so the product left the knife edge. The target is one
declared number for every phone on every path — never adaptive, never
per-phone, never tracking listener conditions.

Healthy native playback is passive — PartyParty never seeks or rate-steers it.
Unbounded drift is still not tolerated: a visible phone that stays at least
750 ms beyond the room target for three measurements gets a fresh HLS
attachment, and corrections stay available for the whole set — spacing between
them is only the mechanical minimum for an attachment to land and re-measure,
stretching briefly only while corrections fail to stick. Never a per-session
cap: one shipped once and left a phone 16.7 s behind at a live test
(2026-08-04). Missing timing telemetry alone never interrupts audio, and
nothing runs while Safari is hidden or the phone is locked.

Relay mode gives `/live/` traffic priority: guest photos take a capped,
throttled secondary path and videos do not enter the relay at all. Direct mode
keeps the full local media experience. This is an intentional music-first
boundary.

## Product Invariants

1. Guests join, listen, and post on the LAN without accounts or internet.
2. The paid App Store download is the purchase boundary. Do not add product
   login, licensing, profiles, or network checks before Go Live.
3. Guest playback is HTTPS LL-HLS. The single exception is the OFFLINE
   EMERGENCY LINK, which is intended and supported: when a party has no
   internet and this Wi-Fi's resolver will not answer for the secure hostname,
   there is no way to obtain or validate a certificate, so the QR offers a
   plain-HTTP link to the Mac's LAN IP. It is narrowly gated in
   `Srv.AllowHTTPFallback`: the request must be non-TLS, the Host must equal the
   CURRENT LAN IP exactly, DNS must not be published, the internet must be
   unreachable, and the room mode must be NO PATH for reason resolver_bad. Every
   other plaintext request still redirects to HTTPS, and a stale IP never
   becomes a second way into the room. Do not widen these conditions, and do not
   restore plain HTTP for any online path.
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

- GitHub Actions is never used in this repo: no workflow files, secrets, or runners. Verification is merge-gate on the PC Linux lane (stack/runbooks/workflow.md); GitHub is a git host only.
