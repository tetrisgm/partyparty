# Low latency (LL-HLS) setup — the "Activate" flow

Guest playback uses HTTPS LL-HLS only. iPhones require a publicly trusted
certificate; a self-signed certificate on a LAN IP is rejected by Safari.
partyparty automates the certificate and local-domain setup while the stream
itself remains on the LAN.

The shipped profile is not a 1.5–2.5-second end-to-end stream. Its generated
playlist uses ~1.003-second parts, ~2.005-second segments, and advertises a
~2.508-second `PART-HOLD-BACK`. In field telemetry, an uncorrected iOS 26
Safari listener settled at ~5.23 seconds because AVPlayer adds its own buffer.
The room deliberately uses a fixed 7-second playout deadline so every common
Safari cohort has ample history and takes the same synchronization path.

## One-time setup

1. **Pick a hostname** on a domain you control that's on Cloudflare, e.g.
   `dj.example.net`. Nothing needs to exist at it.

2. **Create a Cloudflare API token** (you do this — it's a credential):
   dash.cloudflare.com → My Profile → API Tokens → Create Token → *Custom token*
   with exactly one permission: **Zone → DNS → Edit**, scoped to that zone.

3. **Give partyparty the two values** — as files, so the double-clicked `.app`
   picks them up with no shell environment and they survive reboots:

   ```sh
   mkdir -p ~/Library/Application\ Support/partyparty
   pbpaste > ~/Library/Application\ Support/partyparty/cf-token   # paste the token first
   echo -n dj.example.net > ~/Library/Application\ Support/partyparty/live-host
   ```

   (Both also accept env vars / flags for CLI runs: `PARTYPARTY_CF_TOKEN`,
   `PARTYPARTY_LIVE_HOST` / `--live-host`. A settings UI comes later.)

## What happens at launch

With both configured, every launch checks the secure path before guest playback:

1. **Certificate** — if there's no cached cert (or <30 days left), obtain one
   from Let's Encrypt via **DNS-01** (a temporary TXT record through the
   Cloudflare API; no inbound connectivity needed). Cached in
   `~/Library/Application Support/partyparty/`. First run takes ~1–2 min;
   after that it's instant for ~60 days.
2. **A record** — upsert `dj.example.net → <the Mac's LAN IP>` (DNS-only, never
   proxied). Yes, a private IP in public DNS — that's the Plex trick: guests on
   your Wi-Fi resolve the public name to the local Mac.
3. **Self-check** — resolve the host through the system resolver (the same path
   guests' phones take). If the venue router's **DNS-rebind protection** blocks
   private-IP answers, activation reports the failure and does not advertise an
   insecure guest URL.
4. All good → `delivery=auto` picks **LL-HLS**; the QR/guest URL becomes the
   domain; MediaMTX serves HTTPS with the real cert.

## Shipped latency profile

| Layer | Value | Purpose |
|---|---:|---|
| LL-HLS part target | ~1.003s | Stable Safari delivery on ordinary Wi-Fi |
| LL-HLS segment target | ~2.005s | Playlist packaging |
| Advertised part hold-back | ~2.508s | Protocol-level live-edge cushion |
| Authoritative room deadline | 7s | Common Safari/Chrome playout position |
| Muted join budget | up to 10s | Build history, validate 2.5s buffer headroom, and align once |

The join budget is temporary setup time, not additional steady-state playback
latency. After audio opens, playback remains at rate 1 with no sync seeks.

## Caveats (honest list)

- **The domain must resolve on the venue LAN.** The app's local DNS path keeps
  this working offline after activation; the audio never leaves the LAN.
- **Router DNS-rebind protection** can block public-name→private-IP answers
  (common on OpenWrt defaults, some ISP boxes). The self-check catches it and
  reports the failure instead of exposing an insecure guest fallback; the fix
  is an allowlist entry on the router (`rebind_domain` on OpenWrt) or using the
  travel router.
- **Cert renewal** happens automatically at launch when <30 days remain and
  internet is available. A previously activated Mac keeps its cached account
  and certificate state for offline parties.
- Continue real-device soaks across current iOS Safari releases; native media
  playback is retained specifically because it survives lock/background use.
