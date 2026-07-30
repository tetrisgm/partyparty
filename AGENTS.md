# AGENTS.md - partyparty (for Codex / autonomous agents)

partyparty is a macOS menu-bar app that turns a DJ's Mac into a party server.
Guests scan a QR and use HTTPS LL-HLS plus the active-room feed.

The Mac selects ONE room-wide mode from two facts, whether guests can reach it
and whether the internet is reachable: DIRECT (venue Wi-Fi), LOCAL (no internet,
same LAN data path), RELAY (the Wi-Fi isolates devices), or NO PATH (neither
works, stated honestly rather than left checking). See `docs/relay-architecture.md`,
which is the authority.

In RELAY the Mac PUSHES its own LL-HLS to a relay origin (`cmd/pporigin`) which
fans it out, so the Mac sends one copy whether five or five hundred people
listen. It forwards its own playlists byte for byte so PROGRAM-DATE-TIME, and
with it the room schedule, survives. A Cloudflare Worker handles anonymous LAN
hostname/certificate coordination, the bootstrap page, and the website. It is
NEVER in the media path: no Durable Object, no socket, no per-request proxy. It
never stores party history, recordings, or public event pages.

## Layout
- `main.go` + `internal/` - the Go server/binary (audio capture, LL-HLS, HTTPS).
- `app/` - the Swift menu-bar shell (SwiftPM). Loads the Go server's console in a webview.
- `web/` - served pages: `dj.html` (DJ console), `listener.html` / `wall.html` (**GUEST** pages). Embedded in the binary.
- `cloudflare/worker.js` - website and anonymous LAN certificate/DNS broker.
  Tests: `cloudflare/test/smoke.mjs`.

## Verify EVERY change before you commit
- Go: `go build ./... && go vet ./... && gofmt -l .` (must print nothing) `&& go test ./...`
- Worker: `cd cloudflare && node test/smoke.mjs` (all pass)
- Swift: `cd app && swift build`
Run the checks relevant to the files you touched. Only commit if they pass, and paste the output in your final report.

## SACRED - never break these
1. **Guest offline join.** Guests join / listen / post on the LAN with NO account and NO internet. NEVER gate guest routes (`/`, `/wall`, `/hls/`, `/api/status`, `/api/heartbeat`, media/reaction posts) or `listener.html` / `wall.html` on auth, activation, or network.
2. **Account-free DJ app.** The paid Mac App Store download is the purchase
   boundary. Never add a PartyParty login, license server, account gate, profile,
   username, or StoreKit network check to Go Live. Anonymous install credentials
   exist only for LAN DNS/certificate provisioning.
3. **HTTPS + LL-HLS only** for guests. Do NOT reintroduce a plain-HTTP guest fallback.
4. **No stored cloud party product.** Direct and local modes serve live audio
   and active-room posts from the Mac over venue Wi-Fi. Relay mode holds one
   party's live window in memory on the origin and drops it when the room goes
   quiet. Never add public event pages, replays, recordings, remote archives, or
   cloud party feeds.
5. **The audio core is OFF-LIMITS for autonomous work.** Do NOT modify `internal/broadcast/` (ffmpeg / tee / MediaMTX). Contribution reads the LL-HLS that package already produces rather than adding a leg to its tee, which is how the relay was built without touching it.
6. **No authentication email service.** PartyParty has no product accounts or
   magic links. Do not add an email API or SMTP-based authentication.
7. **One venue topology and playback path.** The venue provides Wi-Fi. Do not
   restore Internet Sharing, hotspots, captive portals, or DNS hijacking. The
   Mac authoritatively selects the mode for the whole room. Apple guests always
   use native HLS/AVPlayer so lock-screen playback remains intact.

9. **The room delay never tracks listeners.** A slow device, or a hundred, must
   never lengthen the delay for anyone else. `latencyTarget` deliberately
   discards broadcast status and room health, and a regression test sweeps every
   combination to keep it that way. Devices that fall behind are corrected
   strictly per device.
8. **Two isolated distribution channels.** Store builds stay sandboxed,
   Sparkle-free, and updated only by Apple. The standalone beta is a separate
   Developer ID signed and notarized build with a separate bundle identifier;
   it may contain Sparkle and update from the signed PartyParty beta appcast.
   Neither edition may require admin, privileged helpers, Screen Recording, or
   automatic network reconfiguration. Both may request Local Network, System
   Audio Recording, or Microphone only when needed, plus an optional
   user-enabled login item.

## Rules
- On every App Store or TestFlight rejection, open the exact submission or build
  details in App Store Connect and read every Apple message before changing
  code, entitlements, signing, bundle identifiers, certificates, profiles,
  builds, or portal configuration. Classify the failure from Apple's stated
  evidence first. Do not infer that the app identity or build pipeline is broken
  when the rejection asks for metadata, review notes, clarification, or another
  narrower correction. Record the exact rejection and the chosen response in
  the release handoff.
- Preserve unrelated work and commit completed changes on the current working branch. Do not make branch merging or user review a prerequisite for delivering a verified build.
- Push verified `main` once per coherent change. Native releases produce two
  independently verified artifacts from the same clean commit:
  `scripts/package-app-store.sh` for App Store Connect, and the standalone beta
  ship workflow for the PartyParty website/update feed. Website/Worker changes
  deploy through Wrangler after smoke tests.
- Standalone distribution is a beta/testing channel. Its app, archive, appcast,
  update signature, immutable download, and website link must agree on the exact
  version/build and source commit. Never put Sparkle, its keys, its framework,
  appcast metadata, Developer ID-only entitlements, or standalone update code in
  the Mac App Store product.
- Do not restore the retired shared direct-release daemon or any downloaded
  web-payload system. A standalone release may publish only a complete signed
  and notarized app artifact through its dedicated bounded ship workflow.
- NEVER commit secrets (`*.pem`, `*.key`, `*.p8`, `*.seed`, API keys). Secrets live in `~/Library/Application Support/partyparty` and as Cloudflare Worker secrets.
- Match the surrounding code style; keep changes tight and well-tested.
- Commit messages end with: `Co-Authored-By: Codex <noreply@openai.com>`
- The roadmap + your task queue are in `codex/`. Read `codex/PLAN.md`.
