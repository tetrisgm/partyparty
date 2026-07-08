# Task: Kill the macOS Internet Sharing UX; use iPhone Personal Hotspot instead

## Why
The network onboarding's "Turn on Internet Sharing" button deep-links into the
macOS System Settings → Sharing pane ("Share your connection from Wi-Fi / To
devices using: USB 10/100/1000 LAN…"). It is opaque, confusing, and no DJ will
ever use it. Owner: "kill this thing." Replace the whole Mac-hotspot idea with
**iPhone Personal Hotspot** guidance, which everyone already knows how to use and
keeps guests' internet.

## Build
1. **Remove the Internet Sharing deep-link entirely:**
   - web/dj.html: delete the "Turn on Internet Sharing" and "Try a hotspot"
     buttons that post `/api/open-wifi-sharing` (and their click handlers).
   - internal/server: remove the `POST /api/open-wifi-sharing` handler and the
     macOS Sharing-pane `exec.Command("open", "x-apple.systempreferences:…")`
     helper. Remove any now-dead helper it called.
2. **Replace the "no shared Wi-Fi" guidance with iPhone Personal Hotspot** for
   BOTH the `no_network` and `ethernet_can_host` situations (there is no good
   programmatic Mac-hotspot path, so we stop pretending):
   - Writeup: "No Wi-Fi here? On your iPhone: Settings → Personal Hotspot → turn
     it on. Join it on this Mac, and have guests join the same hotspot — everyone
     stays connected and keeps their internet." No system-pane link, no buttons
     that open Settings.
3. **Soften the isolation nudge** (it currently misfires — it cried "guests can't
   reach your Mac, try a hotspot" when the real problem was elsewhere):
   - Do NOT auto-suggest a hotspot purely because `guestCount === 0`.
   - After a longer window with no listeners, show a gentle, DISMISSABLE hint
     worded as "Guests not connecting? Make sure they're on the same Wi-Fi as
     this Mac." — no hotspot push.

## Guardrails (also see AGENTS.md)
- web/dj.html + the `/api/open-wifi-sharing` removal in internal/server ONLY.
- Do NOT touch internal/broadcast/* (audio core), the sign-in/activation path,
  or main.go. Keep the rest of the network-situation detection intact.
- Branch only; do NOT deploy.
- Verify: `gofmt -l`, `go build ./...`, `go vet ./...`, `go test ./...`,
  `node cloudflare/test/smoke.mjs` (still 135), and a `new Function()` parse of
  dj.html's inline script.

## Done when
No Internet Sharing deep-link or Settings-pane button remains anywhere; the
no-Wi-Fi guidance is iPhone Personal Hotspot; the nudge is softened + dismissable;
everything builds and parses.
