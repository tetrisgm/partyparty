# Low latency (LL-HLS) setup — the "Activate" flow

Plain HLS is the zero-config default (~4s delay, plays everywhere, fully
offline). **LL-HLS cuts that to ~1.5–2.5s** but iPhones will only play it over
HTTPS with a **publicly-trusted certificate** — a self-signed cert on a LAN IP
is rejected by iOS Safari. partyparty automates the whole cert story (the Plex
`*.plex.direct` pattern) with two pieces of one-time config.

## One-time setup

1. **Pick a hostname** on a domain you control that's on Cloudflare, e.g.
   `dj.ramine.net`. Nothing needs to exist at it.

2. **Create a Cloudflare API token** (you do this — it's a credential):
   dash.cloudflare.com → My Profile → API Tokens → Create Token → *Custom token*
   with exactly one permission: **Zone → DNS → Edit**, scoped to that zone.

3. **Give partyparty the two values** — as files, so the double-clicked `.app`
   picks them up with no shell environment and they survive reboots:

   ```sh
   mkdir -p ~/Library/Application\ Support/partyparty
   pbpaste > ~/Library/Application\ Support/partyparty/cf-token   # paste the token first
   echo -n dj.ramine.net > ~/Library/Application\ Support/partyparty/live-host
   ```

   (Both also accept env vars / flags for CLI runs: `PARTYPARTY_CF_TOKEN`,
   `PARTYPARTY_LIVE_HOST` / `--live-host`. A settings UI comes later.)

## What happens at launch

With both configured, every launch (fails **soft** at each step → plain HLS):

1. **Certificate** — if there's no cached cert (or <30 days left), obtain one
   from Let's Encrypt via **DNS-01** (a temporary TXT record through the
   Cloudflare API; no inbound connectivity needed). Cached in
   `~/Library/Application Support/partyparty/`. First run takes ~1–2 min;
   after that it's instant for ~60 days.
2. **A record** — upsert `dj.ramine.net → <the Mac's LAN IP>` (DNS-only, never
   proxied). Yes, a private IP in public DNS — that's the Plex trick: guests on
   your Wi-Fi resolve the public name to the local Mac.
3. **Self-check** — resolve the host through the system resolver (the same path
   guests' phones take). If the venue router's **DNS-rebind protection** blocks
   private-IP answers, activation backs off to plain HLS and says so in the log.
4. All good → `delivery=auto` picks **LL-HLS**; the QR/guest URL becomes the
   domain; MediaMTX serves HTTPS with the real cert.

## The latency knob in LL-HLS mode

The console's Latency control maps to LL-HLS part duration (changing it while
live restarts the broadcast):

| Mode | Part | Expected glass-to-glass | Note |
|---|---|---|---|
| Lowest | 200ms | ~1.4–2s | **experimental** — soak-test your iPhones (field reports saw video stalls at 200ms; audio-only is lighter but unproven) |
| Balanced | 350ms | ~1.7–2.5s | recommended default |
| Stable | 500ms | ~2.2–3s | biggest cushion for weak Wi-Fi |

## Caveats (honest list)

- **Needs internet at the venue** for guests to resolve the name (the audio
  itself still never leaves the LAN). A fully-offline popup stays on plain HLS
  automatically — or configure the travel router's dnsmasq
  (`address=/dj.ramine.net/<mac-ip>`) to go offline-LL-HLS manually.
- **Router DNS-rebind protection** can block public-name→private-IP answers
  (common on OpenWrt defaults, some ISP boxes). The self-check catches it and
  falls back; the fix is an allowlist entry on the router (`rebind_domain` on
  OpenWrt) or using the travel router.
- **Cert renewal** happens automatically at launch when <30 days remain
  (needs internet at that moment; a lapsed cert just means plain HLS until the
  next online launch).
- **LL-HLS on a locked iPhone (30–60 min soak) is still the one unverified
  lock-safety question** — see the device protocol before making it the
  default for a real party.
