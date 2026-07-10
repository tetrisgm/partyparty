# partyparty — Network & HTTPS architecture

Goal: an **unmodified guest phone** opens a browser and gets the DJ's audio as **LL-HLS over
valid (no-warning) HTTPS**, on a **local, offline-capable** network, with **nothing installed on the
guest** and **no manual router config by the DJ**.

The problem splits into two halves that meet only on a hostname string:

- **Trust (the cert)** — solved *online*, at "Activate" (control plane).
- **Resolution + transport** — solved *locally*, at the venue (data plane).

Why a hostname at all: a public CA will not issue a cert for a private LAN IP, so we need a *name*.
The cert binds to the name; local DNS binds the name to today's IP; the IP can change every event with
zero reissuance.

---

## Supported hardware = a capability, not a specific product

partyparty is **device-agnostic**. "Hardware that works for our use case" means anything that can
(a) host a Wi-Fi network guests join, and (b) let the show hostname resolve to the Mac. The app
detects what's present and uses the best available method — it is **never tied to one SKU**. (Note:
a USB Wi-Fi *dongle* is **not** in the supported set — Apple Silicon has no AP-mode drivers; only a
real router or the Mac's own radio can be an AP.)

Really just **two outcomes**: either *something on the LAN resolves the show name to the Mac* → sub-3s
LL-HLS over HTTPS (tiers A and B below — both are just implementations of "controllable local DNS"),
or *nothing can* → ~3s plain HTTP (tier C). The app auto-selects.

### A. Mac is the access point (no extra hardware)
The Mac hosts the Wi-Fi and runs the embedded DNS responder (verified: binds `:53` with no root on
Tahoe) answering the show name → its own IP. Best-case "nothing to buy." Gated on macOS actually
letting the Mac be an AP offline (unproven on Apple-Silicon Tahoe — an **optional bonus**, not the
foundation).

### B. A router resolves the show name → the Mac (one operation; auto if recognized, else one line)
The operation is always identical: **add one local DNS record on the AP — `dj.partyparty.app → the
Mac`.** Auto vs. manual is only whether the app has a driver for that router; it's the same tier and
same result, degrading gracefully:
- **Auto (recognized router):** the app applies it via a per-firmware "router driver." First-class
  driver = **OpenWrt** (GL.iNet et al.) over SSH `uci` — *discover* the wireless iface + dnsmasq index,
  don't hard-code: set `wireless.<iface>.ssid`/`encryption=none`; `dhcp.@dnsmasq[0].address='/dj.partyparty.app/<mac-ip>'` (+ `rebind_protection='0'`); `uci commit; reload`. More drivers (Asus/etc.) added over time.
- **Manual (any other configurable router):** the app shows the exact line to paste once —
  `address=/dj.partyparty.app/<mac-ip>`, an `/etc/hosts`-style entry, or the vendor's "DNS host
  mapping" field. Works on anything that allows a custom local DNS record.

Topology either way: Mac → router by 2.5G/USB Ethernet (preferred, frees guest Wi-Fi) or by Wi-Fi;
guests → router Wi-Fi. Stable Mac IP via static lease, or the app rewrites the record to its current IP each start.

### C. Any network at all, zero config — the universal baseline
If none of A–C apply (a hotspot you can't touch, rebind protection on, no internet), the app falls
back to **plain HTTP HLS (~3s)** with the Mac's current IP in the QR. No DNS, no cert, no config — it
works on **literally any AP and any hardware**, offline, and still plays locked. This guarantees a
working stream on *any* device; A–C only add the sub-3s HTTPS upgrade.

### Stream (the HTTPS path, A or B)
Mac runs **MediaMTX LL-HLS over HTTPS** with the pre-staged cert for the show hostname. Guest scans QR
→ resolves the name → Mac → valid cert → **~1–2s, no warning, plays locked, fully offline.**

### Why this holds up commercially
- We control DNS (Mac-AP or a router we configure) → catch-all resolution works, rebind off.
- No dependence on Apple-Silicon AP drivers or undocumented macOS APIs (the router carries the AP).
- Hardware-agnostic: bring any OpenWrt travel router, or any router you can add one DNS line to, or
  nothing at all (plain-HTTP baseline). We can *recommend* known-good models, never *require* one.

---

## Control plane: "Activate" (online, at home — once per ~season)

One online moment does everything internet-dependent:
- Account / **license check** (the commercial gate).
- **Per-install subdomain** (`dj-<id>.live.partyparty.app`) — no shared name.
- **Per-install cert** via a commercial ACME CA (DNS-01); **private key generated on the Mac, never
  transmitted** (a leaked key can't poison the fleet). Auto-renews on each check-in.
- Cert cached to disk for offline use; validates offline (chain is on-device; Let's Encrypt/modern CAs
  dropped OCSP, so nothing phones home).

Scale note: per-install certs hit Let's Encrypt's 50/registered-domain/week cap fast → launch on a
**commercial ACME CA** (Google Trust Services / DigiCert) with contractual limits; keep ACME so the CA
is swappable.

---

## Auto-selection ladder (no user toggle — the app picks)

Before showing the QR, the app runs a **guest-perspective self-test** (publish the name, then resolve
it *through the DHCP resolver guests will use*, then HTTPS-GET the stream) and shows a green/red badge.

1. **A router resolving the name → the Mac** (auto if recognized, else the one-line paste) → path B
   above. *Best, reliable, offline.*
2. **Mac can be the AP** (Internet Sharing works) → embedded `:53` DNS (verified bind-able no-root) +
   cert. *Optional "no extra gear" bonus mode — best-effort; rests on the unproven Tahoe AP path.*
3. **Internet-having hotspot** (iPhone Personal Hotspot) + self-test passes → app-managed **dynamic
   public DNS**. *Opportunistic; fails on MiFis/travel routers that ship rebind protection on.*
4. **Anything else** → do not advertise a guest stream. Surface the DNS/TLS
   failure to the DJ; HTTPS LL-HLS is the only supported guest transport.

---

## Build order

1. **Cert / Activate control plane** — hub + ACME (DNS-01) + per-install key-on-device + offline
   validation test on real iPhone/Android. (Zero hardware risk; it's the product-defining promise.)
2. **Router auto-config (generic OpenWrt `uci`/SSH)** + the manual one-line path for non-OpenWrt
   routers + LL-HLS serving + **end-to-end on real hardware** (open SSID → resolve → valid HTTPS →
   audio on a real iPhone; load-test dozens of clients). Validate against ≥1 reference OpenWrt device.
3. **Self-test + clear secure-link diagnostics** without a plain-HTTP guest fallback.
4. **Optional:** Mac-as-AP bonus mode (run the Tahoe Internet-Sharing experiment; ship only if reliable).

## To verify on hardware (don't assume)
- The generic OpenWrt `uci` recipe on ≥2 different OpenWrt travel routers (confirm wireless iface name
  + dnsmasq list index are discovered, not hard-coded) so it's not accidentally one-model-specific.
- Real iPhone end-to-end on the open SSID; client-count + LL-HLS throughput ceiling.
- Mac↔router over Wi-Fi (no Ethernet adapter) quality vs. the 2.5GbE path.
- iOS captive/Private-Relay behavior resolving a `.app` name on the offline LAN.
- A compatibility self-check the app can run against an unknown router, with a
  clear manual secure-DNS setup when automatic configuration is unavailable.

---

# Playback, latency & sync — research consolidation (2026-06-30)

Four adversarially-verified research passes fed this section: (1) DJ ease-of-use + low latency, (2)
encoding/transport, (3) dancefloor sync, (4) iOS 26 / macOS 26 baseline. **These conclusions supersede
earlier latency guesses elsewhere in this repo.** Everything here is grounded in the actual code; items
marked *VERIFY* are unconfirmed on real hardware and must be measured.

## Priorities (the north star, and the metric that actually matters)

DJ ease-of-use + low latency are the product's spine; all network/cert/DNS machinery is *plumbing* for
"low-latency without setup friction," never a feature the DJ configures.

There are **two different latencies**, and they are weighted very differently:

1. **Glass-to-glass** (what the DJ does → a guest hears it): **importance ~6/10.** We can spend this
   freely — absolute latency is *cheap currency* we trade for sync.
2. **Inter-listener spread** (dancer ↔ dancer): **importance 10/10.** All guests — iOS and Android,
   phones locked / in pockets / in other apps — must hear the *same moment* close together so a beat
   drop or track change lands on the whole floor together. **Aspirational target ~200 ms.**

The honest promise we can make is **"the room drops together,"** not "phones phase-locked." Sub-second
inter-device is plausibly reachable lock-safe (see mechanism below); a hard ≤200 ms across locked iPhones
is *not* guaranteable in a browser and must not be promised.

## Honest latency floors (what's achievable)

| Path | Glass-to-glass | Basis |
|---|---|---|
| LL-HLS playlist | **~2.508 s advertised hold-back** | measured from the generated 1.003s-part playlist |
| hls.js (Android/desktop, LAN) | **7 s shipped target** | deliberately delayed to the common room clock |
| **iPhone Safari native** (the majority) | **~5.23 s uncorrected field baseline; 7 s target** | iOS 26 held 5.232–5.239s with zero seeks; each release remains hardware-verified on iOS 26/27 |

Latency budget: the shipped MediaMTX/gohlslib playlist advertises 2.5075s of protocol hold-back
(2.5× its measured 1.003s part target). Native Safari then contributes roughly another 2.7s of
player buffering in the clean iOS 26 field sample. The fixed 7s room deadline deliberately adds about
1.8s over that observed native floor; Chrome carries about 4.5s over protocol hold-back because it must
meet Safari on one easy-to-reach position.
The separate ten-second muted setup budget is not added to steady playback latency.

## Codec / encoder / transport — nothing meaningful to gain (verdict)

- **Keep `aac_at` (AAC-LC).** It is already the lowest-latency codec iOS can play in HLS while locked.
  HE-AAC is ~2× worse latency; AAC-LD/ELD and Opus are not playable by the iOS native `<audio>` HLS path.
- **"Hardware acceleration" buys 0 ms.** There is no hardware audio encoder on Apple Silicon; a single
  AAC stream encodes >1000× real-time. Encode was never the bottleneck.
- **Format alternatives (WAV/PCM, progressive/Icecast, MSE) all lose.** WAV = ~10× bandwidth
  (~1.5 Mbps/listener) for a ~55 ms saving the player buffer swallows. Progressive/Icecast = no latency
  win on iOS *and* loses HLS's zero-JS self-healing (a pocketed locked phone that drops Wi-Fi goes
  permanently silent). WebRTC/Web Audio suspend on background/lock. **Managed Media Source (iOS 17.1+):
  CORRECTED 2026-07-01** — an earlier pass claimed MMS suspends on lock; WebKit-source analysis says
  audio-only MMS in an `<audio>` element likely KEEPS PLAYING when locked (audio sessions carry no
  background restriction; the MediaPlayback assertion keeps page JS alive) — but there are zero field
  reports, so it stays **unverified/device-gated** (see the audit's rank-11 spike) and iPhone stays on
  the native path until a 30-60min locked soak passes.
- **Current shipped transport:** `PartDur:1s`, `SegDur:2s`, `SegCount:16`, AAC-LC at 320k. Change these
  only with real iPhone stability and inter-listener measurements; reducing the advertised hold-back
  does not prove Safari will reduce its own buffer.
- **Native Swift LL-HLS rewrite: not worth it for latency** (~30–120 ms saved, ~0 on iPhone; high
  effort/risk). ffmpeg-emits-LL-HLS is *verified impossible* (no EXT-X-PART support). Keep MediaMTX.

## Inter-listener sync — the mechanism that actually fits the constraints

The Mac is the only authority. Its `/api/time` endpoint supplies an NTP-style wall-clock offset and the
playlist's `EXT-X-PROGRAM-DATE-TIME` maps each media position onto that clock. The room advertises one
fixed **7-second playout deadline**. It is not computed from connected peers, so a slow, fast, or broken
device cannot move anyone else.

Joining is a bounded, muted transaction and is the only time synchronization may change playback:

1. Allow up to **10 seconds** for the authoritative timeline and 2.5 seconds of buffered headroom.
2. Compute `error = measured program delay - 7s`.
3. Seek once while muted in either direction: a 5.2-second listener seeks backward to add delay; an
   8-second listener seeks forward to remove delay.
4. Native Safari gets one settling pass and a final field-calibrated launch seek immediately before
   unmute. This absorbs the Safari 27 post-seek hold seen in device telemetry.
5. Open audio at rate 1.0. After that point there is no peer average, playback-rate convergence, periodic
   seek, or room-wide reaction to another listener's health.

If a phone is genuinely interrupted long enough to lose its live position, that phone reattaches and
performs a new muted startup transaction. Healthy listeners continue untouched. If PROGRAM-DATE-TIME is
unavailable, the join budget expires into native playback and telemetry records the missing clock rather
than inventing a peer-derived target.

Realistic outcome: **sub-second inter-device timing with uninterrupted playback**. A tighter continuous
controller is deliberately rejected because audible corrections are worse than a bounded startup offset.

Per-platform reality:

| | Align precisely? | Holds while locked? | Inter-device spread |
|---|---|---|---|
| hls.js (Android/desktop) | one muted PDT startup correction | coasts at rate 1; JS may throttle | sub-second target |
| iPhone native | one or two muted startup seeks | native audio continues while locked | sub-second target |

A mixed locked crowd is **bounded by iPhone.** Side-by-side phones playing *out loud* will still
comb-filter (<25 ms unreachable) — tell users that case is physically out of reach.

**Room/PA sync (composes):** once phones share T, the venue PA is ~T ahead, so delay the *PA* to T (an
`adelay` on a forked Mac monitor output) — only when the Mac drives the PA, the DJ monitors **pre-delay**
(or can't beatmatch), and the delay ramps (never steps). When a mixer drives the PA, just **display the
number** ("Set PA delay = NNN ms").

## Parity: one strategy + two thin player adapters

iPhone-first. **Not a literal single code path** (Chrome has no native HLS → needs hls.js; iPhone native
`<audio>` is the lock-safe path; hls.js-over-Managed-MSE surviving lock is *unproven* → iPhone stays
native). The strategy is identical: use the Mac/PDT clock, align once while muted, then prioritize
continuity.

The shipped config (`web/listener.html`) is:

```js
const cfg = {
  lowLatencyMode: true,
  liveSyncDuration: 7,
  liveMaxLatencyDuration: 12,
  maxLiveSyncPlaybackRate: 1.0,
  liveSyncOnStallIncrease: 0,
  liveDurationInfinity: true,
  backBufferLength: 30,
  manifestLoadPolicy / playlistLoadPolicy / fragLoadPolicy:
    { retryDelayMs: 500, maxRetryDelayMs: 2000, maxNumRetry: 1e9 },
};
```

Fatal-error recovery must be per-type: `MEDIA_ERROR → hls.recoverMediaError()` (plus
`swapAudioCodec()` on repeat) — `startLoad()` cannot rebuild a broken MediaSource and left
Androids permanently silent after a decode error. Keep gesture-start, Media Session,
`visibilitychange` resume (gated on a `userPaused` flag so a deliberate pause is never
overridden), vendored hls.min.js, and the no-PWA posture. A stale or failed player may reattach itself;
that recovery never changes room state or an already healthy listener.

## iOS 26 / 27 and macOS 26 baseline

- The shipped 1s-part/2s-segment profile has been materially more stable than
  the earlier sub-500ms experiments. Keep it until device soaks justify a change.
- Native Safari `<audio>` and Media Session remain load-bearing for locked and
  background playback; do not replace them with Web Audio or a PWA path.
- iOS 26 and 27 can choose different native startup positions. The fixed PDT
  deadline and muted bidirectional correction absorb that difference without
  changing audible playback.
- **macOS: pin to 26.1+.** Free capture-quality win (Tahoe dropped the system-wide capture low-pass
  filter; fixed pro-interface/sample-rate bugs as of 26.1; 26.0 had two capture regressions). No latency
  change. Keep ScreenCaptureKit (Core Audio Process Taps = a future permission-UX refactor, 0 latency).

## Event Hub (subordinate — additive, never complicates go-live)

The Mac also *gathers*: opt-in nickname + comments/reactions + photos/videos ("AirPlay for the event"),
local & offline-native, optional cloud "party album" later. New `internal/hub` package; rides the
existing heartbeat/poll loop; touches zero lines of `/api/start`. **Two non-optional invariants:**
(A) **audio outranks media** — one upload in flight, health-gated admission (reject under strain), size
cap; statistical airtime priority (MediaMTX serves audio on a separate process — do not proxy it).
(B) **moderation + consent** — media defaults to approve-before-show, DJ-token-gated delete/clear/hide,
one-line consent before first post. **Listeners panel:** nickname (opt-in, default "Guest"), device
*type* from User-Agent (a class like "iPhone · Safari" — **never** a personal name; browsers don't expose
one), measured latency, health, join time.

## Must-verify-on-hardware (single OS, priority order)

1. **Locked-screen survival:** tap-to-start → lock 30+ min → multi-hour soak with DJ live on current
   iOS 26 and 27 devices.
2. **The pocket test:** lock phone, attenuate Wi-Fi behind a body 3–10 s, confirm native HLS recovers
   near-live with zero interaction (validates the whole HLS-over-progressive choice).
3. **Settled iPhone latency around the 7s deadline** and the raw startup error before correction.
4. **Inter-device spread** across iOS 26, iOS 27, and Android Chrome, including delayed joins.
5. **Continuity after Wi-Fi impairment:** a struggling device must never move a healthy listener.
6. **`EXT-X-PROGRAM-DATE-TIME` present in the LL-HLS *part* playlist** (`curl ... | grep PROGRAM-DATE-TIME`)
   — the wall-clock anchor for any latency telemetry.
7. **`getStartDate()` validity** on the iOS native element (else show no per-listener number on iOS).
8. **Negative control:** confirm a plain tab, never a PWA.

## Current synchronization contract

The shipped path is HTTPS LL-HLS, a fixed 7s Mac/PDT deadline, a bounded
ten-second muted join transaction, and no audible control loop. Future latency
work must preserve locked playback, sub-second inter-listener spread, and the
rule that one unhealthy device cannot change another listener's playback.
