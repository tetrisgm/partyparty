# Task: Network-situation detection endpoint (Go)

## Goal
Give the DJ console a way to detect the venue's network situation so it can
suggest the right guest-join path. Add a `GET /api/network-situation` endpoint
plus a `POST /api/open-wifi-sharing` deep-link helper. Go only.

## THE CONTRACT (must match exactly — the dj.html task consumes this)
`GET /api/network-situation` (DJ/loopback only, like the other /api routes) -> 200 JSON:
```json
{
  "situation": "shared_wifi_ready | ethernet_can_host | wifi_no_internet | no_network | hotspot_active",
  "onWifi": true,
  "onEthernet": false,
  "hasInternet": true,
  "resolves": true,
  "hotspotting": false,
  "lanIP": "192.168.1.42",
  "primaryUrl": "https://disco42.pp.ramine.net:8443/",
  "guestCount": 0
}
```
Field meaning:
- `onWifi` — the active/default route is a Wi-Fi interface.
- `onEthernet` — there is a NON-Wi-Fi upstream usable for macOS Internet Sharing
  (Ethernet, USB-Ethernet dongle, or USB/iPhone tether). This is what makes a
  GOOD hotspot (Mac can share it to Wi-Fi and guests keep internet).
- `hasInternet` — a ~1s probe to a known host succeeds (e.g. dial 1.1.1.1:443).
- `resolves` — the guest hostname resolves to the Mac's LAN IP right now. REUSE
  the existing `verifyResolves` logic in internal/activate/activate.go (~line 805).
- `hotspotting` — the Mac is currently sharing (the `bridge100` interface is up).
- `lanIP` — current LAN IP ("" if none). Already known to the server.
- `primaryUrl` — the guest party URL; same value the status endpoint returns as
  `urls.primary` (internal/server/server.go ~line 326). "" if none.
- `guestCount` — currently-connected guests. Source it from the EXISTING roster /
  listener tracking the server already keeps (find it; default 0 if unavailable).

`situation` derivation (priority order):
1. no `lanIP` -> `no_network`
2. `hotspotting` true -> `hotspot_active`
3. `onWifi && hasInternet && resolves` -> `shared_wifi_ready`  (best case; prefer this whenever on Wi-Fi and reachable)
4. `onEthernet && hasInternet` (and not already on a usable Wi-Fi for guests) -> `ethernet_can_host`
5. `onWifi && !hasInternet` -> `wifi_no_internet`
6. else -> `shared_wifi_ready` if `onWifi && resolves`, otherwise `no_network`

`POST /api/open-wifi-sharing` (DJ/loopback only): opens the macOS Sharing settings
pane so the DJ can flip on Internet Sharing. Use the existing `exec.Command("open", ...)`
pattern (see the /api/account/open handler). Deep link:
`x-apple.systempreferences:com.apple.Sharing-Settings.extension` (verify it opens
the Sharing pane on THIS Mac; if that identifier is wrong on this macOS, find the
one that does and use it). Return `{ "ok": true }`.

## Detection notes (macOS)
- Detecting Wi-Fi vs Ethernet vs none does NOT need Location permission. Reading
  the Wi-Fi SSID *name* DOES (macOS 14+) — so DO NOT read the SSID here; we only
  need the interface TYPE. Map the default-route interface to its hardware port
  (e.g. via `networksetup -listallhardwareports` / `route -n get default`), or
  enumerate interfaces. Pick whatever is reliable on this Mac.
- `hotspotting`: check for an up `bridge100` interface (Internet Sharing creates it).
- Keep every probe cheap and non-blocking (short timeouts); the console will poll
  this every few seconds.

## Guardrails (also see AGENTS.md)
- Go only (internal/server + internal/activate as needed). Do NOT touch
  internal/broadcast/* (audio core), the sign-in/activation gate, or main.go's
  cert loop. New endpoint + helpers only.
- Branch only; do NOT deploy or push main.
- Verify: `gofmt -l` clean, `go build ./...`, `go vet ./...`, `go test ./...`.
- ALSO verify LIVE on this Mac: run the server, `curl -s localhost:<port>/api/network-situation`,
  and paste the REAL detected JSON into the branch commit message so we can sanity-check
  the detection against the actual machine. Add a Go unit test for the `situation`
  derivation (table test over the field combos).

## Done when
Endpoint returns the contract JSON with correct `situation` on this Mac, the
open-sharing deep link opens the Sharing pane, tests pass, build/vet/gofmt clean.
