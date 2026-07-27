# AGENTS.md — partyparty (for Codex / autonomous agents)

partyparty is a macOS menu-bar app that turns a DJ's Mac into a LAN party
server. Guests on the same venue Wi-Fi scan a QR and use HTTPS LL-HLS plus the
active-room feed, all served by the Mac. A Cloudflare Worker
(`partyparty.party`) handles anonymous LAN hostname/certificate coordination and
the product website. It never hosts
event pages or party content.

## Layout
- `main.go` + `internal/` — the Go server/binary (audio capture, LL-HLS, HTTPS).
- `app/` — the Swift menu-bar shell (SwiftPM). Loads the Go server's console in a webview.
- `web/` — served pages: `dj.html` (DJ console), `listener.html` / `wall.html` (**GUEST** pages). Embedded in the binary.
- `cloudflare/worker.js` — website and anonymous LAN certificate/DNS broker.
  Tests: `cloudflare/test/smoke.mjs`.

## Verify EVERY change before you commit
- Go: `go build ./... && go vet ./... && gofmt -l .` (must print nothing) `&& go test ./...`
- Worker: `cd cloudflare && node test/smoke.mjs` (all pass)
- Swift: `cd app && swift build`
Run the checks relevant to the files you touched. Only commit if they pass, and paste the output in your final report.

## SACRED — never break these
1. **Guest offline join.** Guests join / listen / post on the LAN with NO account and NO internet. NEVER gate guest routes (`/`, `/wall`, `/hls/`, `/api/status`, `/api/heartbeat`, media/reaction posts) or `listener.html` / `wall.html` on auth, activation, or network.
2. **Account-free DJ app.** The paid Mac App Store download is the purchase
   boundary. Never add a PartyParty login, license server, account gate, profile,
   username, or StoreKit network check to Go Live. Anonymous install credentials
   exist only for LAN DNS/certificate provisioning.
3. **HTTPS + LL-HLS only** for guests. Do NOT reintroduce a plain-HTTP guest fallback.
4. **No cloud party product.** The Mac serves live audio and active-room posts.
   Never add public event pages, replays, remote listening, or cloud party feeds.
5. **The audio core is OFF-LIMITS for autonomous work.** Do NOT modify `internal/broadcast/` (ffmpeg / tee / MediaMTX) and do NOT remove the "dead" plain-HLS code — that needs a supervised go-live test.
6. **No authentication email service.** PartyParty has no product accounts or
   magic links. Do not add an email API or SMTP-based authentication.
7. **One network topology and playback path.** The venue provides Wi-Fi. Do not
   restore Internet Sharing, hotspots, captive portals, or DNS hijacking. Apple
   guests always use native HLS/AVPlayer so lock-screen playback remains intact.
8. **App Store permission floor.** Store builds stay sandboxed and Sparkle-free.
   They may request Local Network, System Audio Recording, or Microphone only
   when needed, plus an optional user-enabled login item. Never require admin,
   privileged helpers, Screen Recording, or automatic network reconfiguration.

## Rules
- Preserve unrelated work and commit completed changes on the current working branch. Do not make branch merging or user review a prerequisite for delivering a verified build.
- Push verified `main` once per coherent change. Native releases are packaged
  with `scripts/package-app-store.sh` and delivered only through App Store
  Connect. Website/Worker changes deploy through Wrangler after smoke tests.
- Never restore Sparkle, direct installers, appcasts, downloadable executable web
  payloads, or the retired direct-release daemon.
- NEVER commit secrets (`*.pem`, `*.key`, `*.p8`, `*.seed`, API keys). Secrets live in `~/Library/Application Support/partyparty` and as Cloudflare Worker secrets.
- Match the surrounding code style; keep changes tight and well-tested.
- Commit messages end with: `Co-Authored-By: Codex <noreply@openai.com>`
- The roadmap + your task queue are in `codex/`. Read `codex/PLAN.md`.
