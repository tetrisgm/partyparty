# Task: "Guest setup" strip in the DJ console (web/dj.html)

## Goal
Add a Guest-setup section to the DJ console that DETECTS the network situation,
SUGGESTS the best guest-join path, and EXPLAINS "the deal" in plain English —
wiring together the QR pieces that already exist plus a new hotspot card. Reads
the `GET /api/network-situation` endpoint (contract below). dj.html only.

## THE CONTRACT (provided by the network-detect task; do NOT change it)
`GET /api/network-situation` -> 200 JSON:
```json
{ "situation": "shared_wifi_ready | ethernet_can_host | wifi_no_internet | no_network | hotspot_active",
  "onWifi": true, "onEthernet": false, "hasInternet": true, "resolves": true,
  "hotspotting": false, "lanIP": "192.168.1.42",
  "primaryUrl": "https://disco42.pp.ramine.net:8443/", "guestCount": 0 }
```
`POST /api/open-wifi-sharing` -> opens the macOS Sharing pane; returns `{ "ok": true }`.

## What already exists (reuse, don't rebuild)
- The main party QR (encodes the guest URL) — `renderQR()` (~dj.html:1286) and the
  guest link/QR share panel (~dj.html:389).
- The optional two-step "join Wi-Fi" QR for password venues — ~dj.html:1293-1305.
- The console already polls status on a timer; poll `/api/network-situation` the
  same cadence and re-render on change.

## Build: a "Guest setup" strip that maps `situation` -> {headline, writeup, CTA}
The COPY lives here in the client (server only returns facts). One plain-English
line per situation ("the deal"), plus the matching action:

- `shared_wifi_ready` -> "You're set — guests just scan the code." / writeup:
  "Everyone on this Wi-Fi can reach your Mac. Show the QR." / CTA: show the party QR.
- `ethernet_can_host` -> "Host a Wi-Fi for your guests." / writeup: "Your Mac's on a
  cable, so it can share Wi-Fi to guests and they'll still have internet." / CTA:
  "Turn on Internet Sharing" button -> `POST /api/open-wifi-sharing` + a small card:
  "flip on Internet Sharing, name it partyparty, security None," then show the join-Wi-Fi + party QRs.
- `wifi_no_internet` -> "Share the Wi-Fi and the link." / writeup: "Guests on this
  Wi-Fi can reach you, but the smart link needs internet. Give them the Wi-Fi + this
  link, or make a hotspot." / CTA: show join-Wi-Fi QR + party QR + the hotspot option.
- `no_network` -> "No Wi-Fi here — make your Mac a hotspot." / writeup: "Guests will
  connect straight to your Mac. Heads up: they won't have internet while connected —
  perfect for an offline party." / CTA: "Turn on Internet Sharing" -> `/api/open-wifi-sharing` + the card + QRs.
- `hotspot_active` -> "Hotspot's on — guests join your Mac's Wi-Fi, then scan." /
  writeup: "They connect to your hotspot first, then the party QR opens it." / CTA:
  join-Wi-Fi QR (for your hotspot) + party QR.

## Two more pieces
1. **Self-test** (the only reliable isolation check): a line "Before guests arrive,
   scan this yourself to confirm they can connect." Watch `guestCount`: when it goes
   from 0 to >=1, show a green "✓ Guests can reach you." No new server work — just
   react to `guestCount`.
2. **Isolation nudge**: if the party QR has been shown for ~20s and `guestCount` is
   still 0 on a `shared_wifi_ready`/`wifi_no_internet` situation, show a soft warning:
   "No one's connected yet — this Wi-Fi may be blocking guests from reaching your Mac.
   Try a hotspot." with the hotspot CTA.

## Guardrails (also see AGENTS.md)
- web/dj.html only. Keep it consistent with the existing console styling/vars.
- Don't break the existing gate/console flow. Guard all native/bridge calls.
- Since the endpoint won't exist in this branch's worktree, verify the JS parses
  and the situation->copy mapping is correct via a small self-contained harness
  (e.g. `node -e` feeding each situation object through the mapping fn), and a
  full-file `new Function()` syntax check of the inline script. Note in the commit
  that live behavior is validated after merge + on the field test.

## Done when
The strip renders the right headline/writeup/CTA for each of the 5 situations, the
self-test + isolation nudge logic is wired to `guestCount`, JS parses clean, and
the mapping is covered by the node harness. Summarize the 5 situations in the commit.
