# partyparty

Capture your live DJ mix and broadcast it to every phone on the party Wi-Fi — in the
browser, and it **keeps playing when guests lock their phones or switch apps**.

One self-contained Go binary: it captures audio with FFmpeg, republishes it as **HLS**,
and serves a guest player + a DJ console (with a join QR code and a live listener count).

See [PLAN.md](PLAN.md) for the full design rationale and the research behind the choices.

```
 DJ controller / RekordBox ──▶ FFmpeg capture ──▶ HLS ──▶ HTTP server ──▶ Wi-Fi ──▶ phones
                                          (all on your Mac)                       (<audio> tag)
```

## Requirements

- **Running the built binary: macOS 26+ (Apple Silicon).** FFmpeg, the LL-HLS server (MediaMTX),
  and the system-audio helper are all **embedded** — nothing to install.
- To **build** from source: **Go 1.26+** (`brew install go`), **Xcode command-line tools**
  (`xcode-select --install`), and **MediaMTX** (`brew install mediamtx`). `make` also downloads a
  static FFmpeg and bundles everything into the one binary.
- Optional: a virtual audio device (`brew install blackhole-2ch`) only if you want to capture a
  single app in isolation. Capturing the whole Mac output needs **no** extra install.

## Quick start

```bash
make run                 # builds ./partyparty and runs it
# or:
go build -o partyparty . && ./partyparty
```

Then:

1. Open the **DJ console**: <http://localhost:8000/dj>
2. Pick a **capture source** (or “Test tone” to check the path end-to-end), hit **Start**.
3. Guests join your Wi-Fi and open the **guest URL** shown in the console (use the QR code).

Verify the whole chain without wiring audio yet:

```bash
make tone                # starts a 440 Hz test tone; open the guest URL and you should hear a beep
```

## Choosing a capture source

| You want to capture… | Do this | Then select |
|---|---|---|
| **Everything on the Mac** (recommended) | nothing — uses ScreenCaptureKit | **🖥️ Capture the Mac’s output** |
| **One app only** (e.g. RekordBox, no system sounds) | route that app's output → BlackHole | the BlackHole device |
| **Hardware controller/mixer** | route its REC / USB record out to the Mac (or into an audio interface) | that device |

**Capture the Mac’s output** is the easy path: a built-in helper grabs system audio via Apple's
ScreenCaptureKit — no driver, no routing. The **first** time, macOS asks for **Screen Recording**
permission (System Settings → Privacy & Security → Screen Recording); grant it, then Stop/Start.
It captures *everything* playing, so turn on **Do Not Disturb** so notification sounds don't go out.

Keep the whole chain at **48 kHz** to avoid clicks. The console’s “How do I capture my sound?”
panel has step-by-step versions of all three.

> **Permissions:** “Mac’s output” needs Screen Recording; capturing a mic/line-in device needs
> Microphone. If a capture stays on *starting* with no audio, the console tells you which permission
> to grant. Errors also show in the FFmpeg log.

## The party network (Mac as hotspot)

Your Mac's Wi-Fi radio can't be an access point *and* a client at once, so share to Wi-Fi
**from a different interface** (USB-Ethernet, or a USB Wi-Fi adapter as the second radio):

System Settings → General → Sharing → **Internet Sharing** → share from *Ethernet/USB* → to
*Wi-Fi* → set an SSID + WPA2 password. Guests get `192.168.2.x`; the Mac is `192.168.2.1`.

**Getting guests to the URL** (most reliable → least):

1. **Printed QR code + the guest URL on a sign.** Opens the real browser, where background audio works.
2. **A memorable name** via DNS hijack (see `scripts/dnsmasq-captive.conf`), e.g. `http://party:8000/`.
3. **Captive-portal auto-open** — run with `--captive` *and* hijack DNS to this Mac. Treat it as a
   billboard that says “open the player in your browser”; the captive popup itself can't keep audio
   playing in the background, so it only links out.

**Recommended upgrade:** a GL.iNet / OpenWrt travel router is a far more reliable access point +
captive portal than macOS Internet Sharing, and frees your Mac's Wi-Fi. Plug the Mac into its LAN
and run partyparty; point the router's DNS/portal at the Mac's IP.

## Options

```
--port 8000           HTTP port
--name "partyparty"   name shown to guests
--bitrate 256k        default AAC bitrate (console picks 64k/96k/128k/192k/256k/320k per broadcast)
--mono                broadcast in mono (~half the bandwidth); also a toggle in the console
--codec aac_at        AAC encoder: aac_at = Apple AudioToolbox (best on macOS); aac = portable fallback
--sample-rate 48000   audio sample rate
--hls-time 2          segment length in seconds (lower = less latency, more overhead)
--hls-list 10         segments kept in the playlist
--tone                auto-start a test tone on launch
--delivery llhls      delivery: llhls (low-latency, MediaMTX+HTTPS) or hls (plain HTTP)
--domain HOST         public hostname matching your cert (guests use the domain, never an IP cert)
--cert / --key FILE   TLS cert (fullchain) + key for LL-HLS; empty = auto self-signed
--hls-port 8888       MediaMTX LL-HLS (HTTPS) port
--rtsp-port 8554      MediaMTX RTSP ingest port
--captive             answer OS connectivity probes (needs DNS hijacked to this Mac)
--ffmpeg /path/ffmpeg path to ffmpeg
```

All also settable via env: `PARTYPARTY_PORT`, `PARTYPARTY_NAME`, `PARTYPARTY_BITRATE`, etc.

## Build

```bash
make            # compiles the Swift helper, then builds ./partyparty
```

The web UI, the vendored `hls.js`/QR library, the lock-screen artwork, and the compiled
ScreenCaptureKit helper are all embedded, so the single binary is self-contained (it just needs
`ffmpeg` on `PATH`). The helper is built for **Apple Silicon**; for an Intel/universal build you'd
also compile `swift/ppcapture.swift` for `x86_64` and `lipo` them together.

## Audio quality

Capture is lossless 48 kHz stereo. Fidelity is set by the encoder, bitrate, and channels:
- Encoder: **`aac_at`** (Apple AudioToolbox) by default — the best AAC available on macOS.
- Bitrate: pick **Audio quality** in the DJ console (64 / 96 / 128 / 192 / 256 / 320 kbps); default 256.
- **Mono toggle**: ~halves the per-listener bandwidth for the same perceived quality.

Bandwidth = bitrate × listeners (HLS is unicast), so on a packed/weak network turn on **Mono** and
drop the bitrate. Good floor: **mono 96k** (clearly fine). Hard floor: **mono 64k**. 320k stereo is
overkill but great for a few friends.

### Network health indicator

The console shows a live **Network health** readout (Good / Strain / Congested) plus listener count
and estimated Mbps. It detects trouble server-side from real HLS behaviour — mainly listeners
requesting **expired segments** (a sure sign they've fallen behind the live edge) and how far behind
the live edge established listeners are. When it sees strain it suggests turning on Mono / lowering
the bitrate — but the decision stays yours (no automatic switching). It's a heuristic and lags by a
few seconds; treat it as an early-warning gauge, not a precise meter.

Judge quality on **real music** via "Capture the Mac's output" — the **Test tone is a deliberately
harsh buzzer** for connectivity checks, not a fidelity test. Choppy/cutting-out is a *network*
symptom (weak Wi-Fi/hotspot), not the encoder — a real router fixes that, and it's unrelated to bitrate.

## Latency & delivery

**Mode is a live setting in the DJ console** — switch LL-HLS ↔ HLS on the fly (MediaMTX starts/stops
automatically; the broadcast restarts on the new mode). `--delivery` just sets the startup default.

Two delivery modes:

- **`llhls` (default) — ~1–2s, Low-Latency HLS via MediaMTX over HTTPS.** Capture → FFmpeg → RTSP →
  MediaMTX → LL-HLS. Still plays on locked/backgrounded phones (it's HLS). **Requires HTTPS** — see below.
- **`hls` — ~3–7s, plain HLS over HTTP** (no MediaMTX, no cert). Use `--delivery hls`. The console's
  **Latency vs. stability** selector (1s/2s/3s segments) applies in this mode. Bulletproof, zero-setup,
  QR-and-go for any number of strangers.

WebRTC is intentionally **not** offered: it gives sub-second latency but stops when the phone locks,
which violates the project's hard requirement.

### LL-HLS needs HTTPS

LL-HLS only hits low latency over HTTPS. partyparty can auto-generate a **self-signed** cert for
development, but real parties need a domain with a publicly-trusted certificate.

For a real party, use a **publicly-trusted cert for a domain you own** so guests get zero warnings:

```bash
brew install certbot
./scripts/setup-cert.sh party.yourdomain.com      # Let's Encrypt DNS-01 (one TXT record)
./partyparty --domain party.yourdomain.com \
  --cert run/letsencrypt/config/live/party.yourdomain.com/fullchain.pem \
  --key  run/letsencrypt/config/live/party.yourdomain.com/privkey.pem
```

Then point your party router's DNS at the Mac so the domain resolves locally (no internet needed):
GL.iNet/OpenWrt dnsmasq → `address=/party.yourdomain.com/<mac-lan-ip>`. Guests scan the QR → the player
loads `https://party.yourdomain.com:8888/party/index.m3u8` with a valid cert, ~1–2s latency, locked-phone intact. That's the deliberate trade for rock-solid background/locked-phone
playback (HLS self-heals dropped Wi-Fi without any JavaScript running). See PLAN.md for why HLS beats
WebRTC/Icecast for a pocket-in-a-party scenario.

## Layout

```
main.go                 entry, flags, embeds web/ + the helper, wires everything up
internal/config         flags + env
internal/netinfo        LAN IP + .local hostname detection
internal/devices        ffmpeg avfoundation device listing + classification
internal/broadcast      capture process manager: ffmpeg → RTSP push (llhls) or HLS files (hls)
internal/mediamtx       embedded MediaMTX: self-signed cert, config, subprocess (LL-HLS)
internal/stats          listener counting + health via player heartbeats
internal/server         HTTP routes, API, heartbeat, plain-HLS serving, captive portal
swift/ppcapture.swift   ScreenCaptureKit system-audio helper (compiled to assets/ppcapture)
web/                    listener.html, dj.html, vendor/, art-512.png   (embedded)
scripts/                setup-cert.sh (real cert), llhls-test.sh, dnsmasq captive example
```
