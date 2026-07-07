# AGENTS.md — partyparty (for Codex / autonomous agents)

partyparty is a macOS menu-bar app that turns a DJ's Mac into a **self-contained
LAN party server**: guests scan a QR, join over Wi-Fi, and hear a low-latency
HLS stream + post photos/videos/comments — all working with **ZERO internet**.
A Cloudflare Worker (`party.ramine.net`) is the *optional* cloud: sign-in, DJ
event replay pages, OTA updates.

## Layout
- `main.go` + `internal/` — the Go server/binary (audio capture, HLS, HTTP, local DNS).
- `app/` — the Swift menu-bar shell (SwiftPM). Loads the Go server's console in a webview.
- `web/` — served pages: `dj.html` (DJ console), `listener.html` / `wall.html` (**GUEST** pages). Embedded in the binary + shipped as an OTA payload.
- `cloudflare/worker.js` — the public website + broker (D1 + R2). Tests: `cloudflare/test/smoke.mjs`.

## Verify EVERY change before you commit
- Go: `go build ./... && go vet ./... && gofmt -l .` (must print nothing) `&& go test ./...`
- Worker: `cd cloudflare && node test/smoke.mjs` (all pass)
- Swift: `cd app && swift build`
Run the checks relevant to the files you touched. Only commit if they pass, and paste the output in your final report.

## SACRED — never break these
1. **Guest offline join.** Guests join / listen / post on the LAN with NO account and NO internet. NEVER gate guest routes (`/`, `/wall`, `/hls/`, `/api/status`, `/api/heartbeat`, media/reaction posts) or `listener.html` / `wall.html` on auth, activation, or network.
2. **DJ activation gate (shipped v15.47).** The DJ app requires a linked account before the console / Go Live run (`/api/start` → 403 `not_activated`; `dj.html` blocking gate; server latch `accActivated`). Keep it. A once-activated Mac must still work OFFLINE (the account cache in `internal/activate`).
3. **HTTPS + LL-HLS only** for guests. Do NOT reintroduce a plain-HTTP guest fallback.
4. **No cloud relay.** The Mac serves the stream; the cloud only hosts MP3 replays. Never route live audio through the cloud.
5. **The audio core is OFF-LIMITS for autonomous work.** Do NOT modify `internal/broadcast/` (ffmpeg / tee / MediaMTX) and do NOT remove the "dead" plain-HLS code — that needs a supervised go-live test.
6. **Email transport is MXroute SMTP — NEVER a paid email API.** No Resend, SendGrid, Postmark, Mailgun, etc. The owner has a lifetime MXroute account and pays for nothing else. Magic-link email sends via SMTP (`sendViaMXroute` over `cloudflare:sockets`; `AUTH_EMAIL_SERVER` / `MXROUTE_SMTP_*` secrets). Reference: `~/dev/stack/runbooks/email-smtp-dns.md`.

## Rules
- Work on **your branch only**. Commit to the branch; do NOT push to `main`, do NOT run `scripts/release.sh`, do NOT bump `CODE_MAJOR`, do NOT `wrangler deploy`. Releases + deploys are owner-only.
- NEVER commit secrets (`*.pem`, `*.key`, `*.p8`, `*.seed`, API keys). Secrets live in `~/Library/Application Support/partyparty` and as Cloudflare Worker secrets.
- Match the surrounding code style; keep changes tight and well-tested.
- Commit messages end with: `Co-Authored-By: Codex <noreply@openai.com>`
- The roadmap + your task queue are in `codex/`. Read `codex/PLAN.md`.
