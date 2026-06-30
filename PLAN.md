# partyparty — DJ → Wi-Fi → everyone's phone

A macOS app that captures your live DJ mix, broadcasts it over a local Wi-Fi network,
and lets partygoers listen in their browser — robust to locked phones, tab switches, and
pockets.

## Decisions locked (from your answers)

| Question | Your answer | Consequence |
|---|---|---|
| Latency tolerance | **Casual delay fine** | Optimize for *reliability*, not low latency → **HLS** delivery |
| Audio source | **Hardware controller/mixer** | Audio leaves via the controller, **not** macOS audio → capture the controller's REC-OUT device (BlackHole alone won't work) |
| Network | **Mac makes its own hotspot** | Mac = access point; captive-portal auto-open is the fragile part → QR + simple URL is the reliable path; a travel router is the recommended upgrade |

## Architecture at a glance

```
 ┌─────────────┐   USB    ┌──────────────────────────────────────────┐   Wi-Fi   ┌──────────┐
 │ DJ controller│ ───────▶ │  MAC                                       │ ────────▶ │ Phones   │
 │  / mixer     │  REC-OUT │  ① FFmpeg captures REC-OUT input device    │  (AP)     │ Safari / │
 │ (RekordBox)  │  device  │  ② FFmpeg encodes AAC → HLS segments       │           │ Chrome   │
 └─────────────┘          │  ③ Tiny HTTP server serves /hls + web page │           │ <audio>  │
        │                  │  ④ mDNS + QR + (optional) captive portal   │           │ +Media   │
        ▼ booth/speakers   └──────────────────────────────────────────┘           │ Session  │
   (you hear it live)                                                              └──────────┘
```

Glass-to-glass latency target: **~6–15 s** (totally fine — listeners aren't watching your hands).

---

## ① Audio capture — the #1 thing to get right (and to test before the party)

Because you DJ on a **hardware controller/mixer**, the master audio goes out through the
controller's own audio driver — **it never touches macOS system audio**. That means the usual
"BlackHole loopback" trick captures *silence*. You must capture the controller's record return.

**Two ways, in order of preference:**

1. **Capture the controller's USB REC-OUT device directly (no extra cable).**
   Pioneer DJM/DDJ gear exposes a record/return device to CoreAudio. In the mixer's *Setting
   Utility*, route a USB output pair to **MIX / REC OUT**. Then point FFmpeg at that input device.
   List devices first:
   ```
   ffmpeg -f avfoundation -list_devices true -i ""
   ```
   You'll see something like `[1] DDJ-FLX4` or `[2] DJM-...` under "AVFoundation audio devices."
   Capture it (replace the index):
   ```
   ffmpeg -f avfoundation -i ":1" -ac 2 -ar 48000 ...   # ":1" = audio device index 1
   ```

2. **Analog loopback (works with any mixer, incl. Allen & Heath Xone, etc.).**
   Controller **REC OUT / BOOTH OUT** → an audio interface **line input** → capture that interface
   input in FFmpeg the same way. One extra A/D round-trip, universally reliable.

**Whichever you use, confirm the exact device name/index on YOUR hardware before the night.**
This is the single biggest source of "it worked at home, dead at the party."

Keep the whole chain at **48 kHz** (mixer, interface, FFmpeg `-ar 48000`) to avoid clicks/resampling.

> Note: Apple's modern ScreenCaptureKit "system audio" capture does **not** help here either —
> with a hardware controller there's nothing on the system bus to capture. The controller's
> record device is the source regardless of how the app is built.

---

## ② Encode + stream protocol — HLS (AAC) is the primary

We compared the realistic options for one publisher → 20–80 browser listeners on a LAN:

| Protocol | Latency | Background / locked phone | Scale to ~80 | Server effort | Verdict |
|---|---|---|---|---|---|
| **HLS (AAC)** | 6–15 s | ✅ **Self-heals** network blips (native player re-fetches segments, no JS needed) | ✅ trivial (static files) | low | **PRIMARY** |
| Icecast / progressive (MP3/AAC) | 2–10 s | ⚠️ Plays, but if the stream drops while locked, **JS can't run to reconnect** → silence until re-opened | ✅ trivial | low | Great for the *MVP smoke test* & lower latency |
| LL-HLS (AAC) | ~2 s | ✅ like HLS | ✅ | medium (Safari needs **TLS** on LAN = friction) | Optional, if you want it snappier |
| WebRTC (Opus) | <0.5 s | ❌ **iOS suspends backgrounded WebRTC audio** | ❌ needs an SFU per-listener | high | **No** — breaks the pocket requirement |
| MPEG-DASH | 6–30 s | ~ | ✅ | medium (not native on iOS) | No advantage over HLS |

**Why HLS wins for you:** your priority is "keeps playing in a pocket for hours on crowded
party Wi-Fi." HLS is the only option that *self-heals* a dropped connection while the phone is
locked, because iOS's native player keeps requesting the next `.ts` segment without any JavaScript
running. A progressive Icecast stream plays fine until the first Wi-Fi blip, then goes silent
because the reconnection code can't execute in a frozen tab. Given you said casual delay is fine,
HLS's extra few seconds are a non-issue.

**Capture → HLS in one FFmpeg command:**
```
ffmpeg -f avfoundation -i ":1" -ac 2 -ar 48000 \
  -c:a aac -b:a 192k \
  -f hls -hls_time 2 -hls_list_size 10 \
  -hls_flags delete_segments+append_list+omit_endlist \
  -hls_segment_type mpegts \
  /path/to/webroot/hls/stream.m3u8
```
Then any static file server pointed at `webroot/` serves the stream. (Use HE-AAC `-c:a aac_he` /
`libfdk_aac` for lower bitrate if Wi-Fi is tight.)

**MediaMTX option (optional hedge):** [MediaMTX](https://github.com/bluenviron/mediamtx) ingests
once and serves HLS **and** WebRTC simultaneously — foreground listeners get low-latency WebRTC,
locked phones fall back to HLS. Costs a TLS cert on the LAN (Safari requires it for LL-HLS/WebRTC),
so only worth it if you later decide latency matters.

---

## ③ Listener web app — the rules that make "phone in pocket" actually work

Verified findings that drive the design:

- A plain **HTML5 `<audio>` element** keeps playing through tab-switch, app-switch, and screen-lock
  on **iOS Safari and Android Chrome** — *as long as it's a normal browser tab*.
- **Do NOT ship it as an "Add to Home Screen" PWA on iOS** — standalone PWAs historically *pause*
  audio when minimized/locked ([WebKit bug 198277](https://bugs.webkit.org/show_bug.cgi?id=198277)).
  Counterintuitive, but the plain tab is more reliable. Keep it a normal page.
- **Web Audio API (`AudioContext`) and WebRTC are suspended** when iOS backgrounds the tab — don't
  use them for playback.
- Audio can't autoplay — needs **one user tap**. Embrace a big "Tap to Listen" button.
- **Media Session API** gives lock-screen controls + now-playing metadata (it does *not* keep audio
  alive — the `<audio>` element does that — but it's needed for a usable lock-screen UI).
- **Self-host `hls.js`** — there's no internet at the party, so you can't load it from a CDN.

**Minimal listener page (the real skeleton):**
```html
<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>🎧 Party Radio</title>
<button id="listen">▶︎ Tap to Listen</button>
<audio id="player" preload="none" playsinline></audio>
<script src="/vendor/hls.min.js"></script>  <!-- self-hosted, NOT a CDN -->
<script>
const URL_ = '/hls/stream.m3u8';
const audio = document.getElementById('player');
const btn = document.getElementById('listen');

function attach() {
  if (audio.canPlayType('application/vnd.apple.mpegurl')) {
    audio.src = URL_;                          // iOS Safari: native HLS (best)
  } else if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDuration: 6, maxBufferLength: 30 });
    hls.loadSource(URL_); hls.attachMedia(audio); audio._hls = hls;  // Android/desktop
  } else { audio.src = URL_; }
}
btn.onclick = async () => {
  attach();
  try { await audio.play(); btn.hidden = true; } catch (e) {}
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: 'Live', artist: 'Party Radio',
      artwork: [{ src: '/art-512.png', sizes: '512x512', type: 'image/png' }]
    });
    navigator.mediaSession.setActionHandler('play',  () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
  }
};
// best-effort recovery once the tab is foregrounded again
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') audio.play().catch(()=>{});
});
audio.addEventListener('stalled', () => audio.play().catch(()=>{}));
audio.addEventListener('error',   () => { attach(); audio.play().catch(()=>{}); });
</script>
```

---

## ④ Network + getting guests onto the URL

**You chose: Mac is its own hotspot.** Key realities:

- A Mac's **built-in Wi-Fi radio can't be an access point AND a client at the same time.** To run
  the AP on built-in Wi-Fi, the "Share your connection from" interface must be **something else** —
  USB-Ethernet dongle, or a USB Wi-Fi adapter as the second radio. (No internet needed on it; the
  hotspot still broadcasts and hands out DHCP.)
- macOS **Internet Sharing** works offline: it broadcasts the SSID and hands out leases via `bootpd`
  (Mac becomes `192.168.2.1`, clients get `192.168.2.x`). Quick setup: System Settings → General →
  Sharing → **Internet Sharing** → share from *Ethernet/USB* → to *Wi-Fi* → set SSID + WPA2 password.
- **The captive-portal auto-open is the fragile part.** macOS has **no built-in captive portal** —
  forcing the "Sign in to network" pop-up means running your own DNS hijack (`dnsmasq`) + web server,
  and macOS rewrites `bootpd.plist` on every toggle. Recent macOS (Tahoe 26.x) added stricter
  Local Network permission gating that makes this flakier. Treat captive auto-open as a *nice-to-have*,
  not the primary path.

**Onboarding strategy (most reliable → least):**

1. **Printed QR code + short URL on signs** pointing at `http://192.168.2.1:8000/`. This is the
   primary, bulletproof path — it opens the *real* browser, where background audio works.
2. **DNS hijack for a memorable name** (e.g. `party.lan` → `192.168.2.1`) if you run `dnsmasq`.
   (`.local`/Bonjour works on iOS but is unreliable on Android — don't depend on it.)
3. **Captive portal as a billboard, never the player.** The iOS/Android captive sign-in screen is a
   restricted WebView that **tears down audio the instant the user locks or switches apps** — so it
   *cannot* host the player. If you do run one, make it a splash that says *"🎧 Tap to open the player
   in your browser"* + the QR/URL, and let people land in real Safari/Chrome.

**Recommended upgrade (~$80): a GL.iNet travel router (e.g. GL-MT3000 "Beryl AX").** It's a real
dual-band AP for 80 clients, runs `dnsmasq` (easy DNS hijack of `party.lan` + the OS connectivity-check
hosts) and `opennds` for a proper captive splash — all surviving macOS updates. The Mac just plugs
into its LAN port and serves the stream, freeing the Mac's Wi-Fi entirely. You picked the Mac-hotspot
path, which works; this is the reliability buy if the captive portal turns into a headache.

---

## ⑤ The Mac app itself — build ladder

**MVP (tonight, no app):** Icecast or FFmpeg-HLS + a static page. Prove the whole chain end-to-end.

**v1 (a real, single-purpose app):** one **single binary (Go or Node)** that:
- spawns/manages FFmpeg (capture → HLS),
- serves `/hls`, the listener page, and self-hosted `hls.js`,
- shows a full-screen **"Join" screen on the Mac**: SSID, URL, big QR code, live listener count,
- advertises over mDNS.

This is the sweet spot: minimal, distributable, no Electron bloat.

**v2 (polished):** wrap it as a **Tauri app** (Rust core + web UI, FFmpeg as a bundled "sidecar",
~10 MB installer) for a clean start/stop UI and packaging — *or* a **native Swift menu-bar app**
if you want best-in-class macOS integration. Note the capture path (FFmpeg on the controller's
record device) is identical in all cases, so framework choice is purely about UI/packaging.

**Prior art to lean on (don't reinvent):**
- **Icecast + an encoder** (BUTT GUI, Darkice, or Liquidsoap) — the proven radio core.
- **Audio Hijack** ($69) — can capture an app + broadcast to Icecast with zero code (fast path if
  you ever DJ in-the-box).
- **AzuraCast** — turnkey Dockerized radio with a built-in web player + listener analytics
  (heavyweight, but everything's done for you).
- **MediaMTX** — if you later want WebRTC/LL-HLS.
- Skip **Owncast** (video-only, no audio-only mode) and **Snapcast** (native clients, not browser).

---

## MVP recipe — testable tonight

**Fastest smoke test (Icecast, lowest latency):**
```
brew install icecast ffmpeg
# edit icecast.xml: set <source-password>, <admin-password>, <port>8000
icecast -c /opt/homebrew/etc/icecast.xml
# find your controller's record device index:
ffmpeg -f avfoundation -list_devices true -i ""
# stream it (replace :1 with your device index, PASS with source-password):
ffmpeg -f avfoundation -i ":1" -c:a libmp3lame -b:a 192k \
  -content_type audio/mpeg -f mp3 icecast://source:PASS@localhost:8000/party.mp3
```
Phones (on your hotspot) open `http://<mac-ip>:8000/party.mp3` in an `<audio>` page. Verify it keeps
playing with the phone **locked in your pocket for 10+ minutes**.

**Then switch the delivery to HLS** (the production path, §2 command) and re-test the lock-screen
behavior — that's the configuration you'll actually run at the party.

---

## Roadmap

- **Phase 0 — Validate the risky bits (do first):** confirm controller record-device capture; confirm
  the hotspot serves N phones; confirm HLS keeps a *locked* phone playing for 30+ min. Everything else
  is easy by comparison.
- **Phase 1 — MVP:** FFmpeg-HLS + static listener page + QR sign. Usable at a real party.
- **Phase 2 — v1 app:** single binary, Mac "Join" screen (QR + listener count), mDNS, one-click start/stop.
- **Phase 3 — Polish:** Tauri/Swift wrapper, now-playing metadata, captive portal, optional WebRTC.

## Top risks & pre-party checklist

- [ ] **Controller capture verified** on your exact hardware (device index won't change night-of).
- [ ] **Locked-phone soak test** on the actual iOS version guests will have (behavior shifts across
      point releases) — both iPhone and an Android.
- [ ] **Wi-Fi capacity**: the AP/airtime is the real bottleneck at 80 clients, not the protocol —
      test with as many devices as you can; consider 5 GHz and the travel-router upgrade.
- [ ] **Self-hosted `hls.js`** (no CDN at the party).
- [ ] **Sample rates all at 48 kHz** end-to-end.
- [ ] **Ringer/volume**: iOS won't start audio if the ringer is off/zero — note it on the QR sign.
- [ ] Printed **QR + URL signs** as the primary onboarding (don't rely on captive auto-open).

## Bonus features (later)

- **Now-playing metadata** on the lock screen: pull track title from RekordBox via the Pro DJ Link /
  StageLinQ protocol (libraries like `prolink-connect`) and push it into the Media Session.
- **Live listener count** from Icecast `/status-json.xsl`, or distinct IPs hitting the HLS playlist.
- **Song requests / reactions** page on the same server.
- **Recording** the set to disk in parallel (FFmpeg `tee` muxer).

## A note on music licensing

Streaming copyrighted tracks — even on a closed LAN — is technically a public performance. For a
private party on an offline network (not recorded, not redistributed, not public-facing) this is
low-risk, but worth knowing before you point it at the open internet.

---
*Plan generated from a research + adversarial-verification pass (capture, protocols, mobile background
audio, captive portal, prior art). The HLS-vs-WebRTC, captive-portal-WebView, and macOS-AP claims were
independently fact-checked against 2025–2026 sources.*
