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
4. **Anything else** → **plain HTTP HLS (~3s)**, Mac's IP in the QR. *Universal safety net — no cert,
   no DNS, works on any network offline, still plays locked. Guests always get audio; latency adapts.*

---

## Build order

1. **Cert / Activate control plane** — hub + ACME (DNS-01) + per-install key-on-device + offline
   validation test on real iPhone/Android. (Zero hardware risk; it's the product-defining promise.)
2. **Router auto-config (generic OpenWrt `uci`/SSH)** + the manual one-line path for non-OpenWrt
   routers + LL-HLS serving + **end-to-end on real hardware** (open SSID → resolve → valid HTTPS →
   audio on a real iPhone; load-test dozens of clients). Validate against ≥1 reference OpenWrt device.
3. **Self-test + auto-fallback ladder**, including the plain-HTTP safety net (the any-hardware guarantee).
4. **Optional:** Mac-as-AP bonus mode (run the Tahoe Internet-Sharing experiment; ship only if reliable).

## To verify on hardware (don't assume)
- The generic OpenWrt `uci` recipe on ≥2 different OpenWrt travel routers (confirm wireless iface name
  + dnsmasq list index are discovered, not hard-coded) so it's not accidentally one-model-specific.
- Real iPhone end-to-end on the open SSID; client-count + LL-HLS throughput ceiling.
- Mac↔router over Wi-Fi (no Ethernet adapter) quality vs. the 2.5GbE path.
- iOS captive/Private-Relay behavior resolving a `.app` name on the offline LAN.
- A "compatibility self-check" the app can run against an unknown router (can it SSH/uci? else fall to
  manual/plain-HTTP) so support degrades gracefully across arbitrary gear.

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
| hls.js (Android/desktop, LAN) | **~0.8–1.2 s** | near the LL-HLS structural floor |
| **iPhone Safari native** (the majority) | **~2–3 s realistic** (best ~1.4 s, non-deterministic spikes) | `PART-HOLD-BACK` is the only lever; native parks ~1:1 at it. iOS 26 did **not** change this (no LL-HLS changes in WWDC 2025 / Safari 26 notes). The old "3–5 s / spikes to 10 s" was config-driven (#2317, 6 s segments) and **no longer applies** to our 200 ms-part / ~500 ms-hold-back config. |

Latency budget: capture→ffmpeg→RTSP→MediaMTX sums to **<150 ms** (≈30–50 ms recoverable — a rounding
error). The dominant terms are **part assembly (~200 ms) + part-hold-back (~500 ms, hardcoded 2.5× in
gohlslib, not tunable)**, and on iPhone the **native player's own buffer (seconds)**. *VERIFY:* settled
iPhone live-edge at part=200 ms / hold-back≈500 ms; sweep hold-back (400/500/750 ms) to confirm ~1:1
tracking.

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
- **Real changes worth doing:** (a) **Fix the no-op latency control** — the DJ's low/balanced/stable mode
  only feeds the plain-HTTP fallback `hls_time`; it never reaches LL-HLS (`main.go` hardcodes
  `SegDur:"1s", PartDur:"200ms", SegCount:7`). Wire it to MediaMTX. (b) **Default bitrate 256k → 128–160k**
  (transparent for music, ~half the airtime; robustness, not latency). (c) Add free ffmpeg hygiene flags
  (`-fflags +nobuffer -flags +low_delay -probesize 32 -analyzeduration 0`) to the f32le/mac branch only —
  ~0 perceptible but harmless.
- **Native Swift LL-HLS rewrite: not worth it for latency** (~30–120 ms saved, ~0 on iPhone; high
  effort/risk). ffmpeg-emits-LL-HLS is *verified impossible* (no EXT-X-PART support). Keep MediaMTX.

## Inter-listener sync — the mechanism that actually fits the constraints

The naïve approach (per-device JS measures each playhead and nudges it) is **dead on arrival on iPhone**:
iOS gives no live-playhead write, live HLS is non-seekable, `playbackRate` smears music, and — fatally —
**iOS freezes all JavaScript when the phone locks/backgrounds**, which is exactly the required state. So
per-device active correction cannot run when it's needed.

**The mechanism that works is passive and lock-safe:** every device keys off the **same server-advertised
`PART-HOLD-BACK`**, and the native player **parks ~1:1 at it** — so all devices sit at the *same distance
from live* with **no per-device JS at all**. That survives lock by construction. Inter-device spread then
= (parking variance across devices) + (drift). Drift is tiny ongoing (~0.3 s/hour, clock crystals); the
real enemy is **rebuffer events** (Wi-Fi blips), each of which shifts a device's offset and may not snap
back.

So the strategy — and it *uses* the cheap glass-to-glass budget:
1. **One uniform target latency T for everyone**, set via the server hold-back (the only lock-safe lever).
2. **Spend latency on a generous, stable buffer** to (a) make every device park at the same padded live
   edge and (b) make rebuffers rare — killing the drift that spreads devices. ("iPhone: optimize for
   stability over minimum latency" directly serves sync.)
3. **Pick T with an outlier-robust solver** (so one terrible phone doesn't drag the whole room up):
   measure per-device latency where available (`hls.latency` on hls.js; `getStartDate()+currentTime` on
   iOS, telemetry-only and `Invalid Date`-guarded), trim slow outliers with **median + MAD** (not
   mean/std — outliers poison those), set **T = max(survivors) + ~250 ms margin** (≈P90 fallback), clamp
   T ≤ ~5 s, with **hysteresis** and **asymmetry** (raise T promptly = smooth added buffer; lower T slowly
   = an audible forward skip). Auto-**engage when the spread is bad enough to justify the latency cost**,
   not always-on.

Realistic outcome: **sub-second inter-device is plausibly reachable lock-safe** when the config is kept
stable; ~200 ms is the aspirational upside, **iPhone-bound and *VERIFY*-gated**. Whole-room reaction sync
within a fraction of a beat is a massive improvement over today's 1–5 s spread.

Per-platform reality:

| | Align precisely? | Holds while locked? | Inter-device spread |
|---|---|---|---|
| hls.js (Android/desktop) | yes (JS control, foregrounded) | coasts; JS throttled when backgrounded | ~200–500 ms |
| iPhone native | no per-device write — relies on uniform hold-back parking | yes (no JS needed) | parking-variance + rebuffer drift; *VERIFY* — likely sub-second if stable, worse with rebuffers |

A mixed locked crowd is **bounded by iPhone.** Side-by-side phones playing *out loud* will still
comb-filter (<25 ms unreachable) — tell users that case is physically out of reach.

**Room/PA sync (composes):** once phones share T, the venue PA is ~T ahead, so delay the *PA* to T (an
`adelay` on a forked Mac monitor output) — only when the Mac drives the PA, the DJ monitors **pre-delay**
(or can't beatmatch), and the delay ramps (never steps). When a mixer drives the PA, just **display the
number** ("Set PA delay = NNN ms").

## Parity: one strategy + two thin player adapters

iPhone-first. **Not a literal single code path** (Chrome has no native HLS → needs hls.js; iPhone native
`<audio>` is the lock-safe path; hls.js-over-Managed-MSE surviving lock is *unproven* → iPhone stays
native). But the **strategy is identical**: read the server `PART-HOLD-BACK`, no rate convergence, no
per-device loop. Configure hls.js to *behave like the native player* — neuter Android, don't smarten it:

> **CORRECTED 2026-07-01 (pipeline audit):** the block previously recommended here —
> `liveMaxLatencyDuration: 6` **without** `liveSyncDuration` — is an **illegal hls.js config**:
> the vendored 1.5.17 constructor **throws** (`"liveMaxLatencyDuration" must be greater than
> "liveSyncDuration"`), which killed ALL Android/desktop playback (the exception surfaced as a
> silent unhandled rejection — the listen button did nothing). Also verified: any user-set
> `liveSyncDuration`/`liveSyncDurationCount` **overrides the playlist PART-HOLD-BACK** (user
> config wins in hls.js), so that pair is only legal/harmless in **plain-HLS** mode.

The shipped config (`web/listener.html`) is:

```js
const cfg = {
  lowLatencyMode: ll,                 // LL-HLS: parks at the server PART-HOLD-BACK (== native)
  maxLiveSyncPlaybackRate: 1.05,      // gentle pitch-preserved catch-up: kills the post-stall ratchet
  liveDurationInfinity: true,
  backBufferLength: 30,
  manifestLoadPolicy / playlistLoadPolicy / fragLoadPolicy:
    { retryDelayMs: 500, maxRetryDelayMs: 2000, maxNumRetry: 1e9 },  // fast bounded retries
};
if (!ll) {          // plain HLS ONLY (no PART-HOLD-BACK exists, so the override is harmless)
  cfg.liveSyncDuration = 3;           // park 3 target-durations back — native parity
  cfg.liveMaxLatencyDuration = 6;     // legal ONLY together with liveSyncDuration
}
// LL-HLS backstop is MANUAL (in the heartbeat interval):
//   if (hls.latency > 6 && hls.liveSyncPosition != null) player.currentTime = hls.liveSyncPosition;
```

Fatal-error recovery must be per-type: `MEDIA_ERROR → hls.recoverMediaError()` (plus
`swapAudioCodec()` on repeat) — `startLoad()` cannot rebuild a broken MediaSource and left
Androids permanently silent after a decode error. Keep gesture-start, Media Session,
`visibilitychange` resume (gated on a `userPaused` flag so a deliberate pause is never
overridden), vendored hls.min.js, and the no-PWA posture.

**On `maxLiveSyncPlaybackRate: 1.05` (supersedes the earlier "OFF" advice):** Chrome's
`preservesPitch` defaults to true, so 5% catch-up is inaudible time-stretch, and it converges a
post-stall Android back to the SAME hold-back target iPhones park at — better inter-listener
spread with fewer audible backstop skips, not worse. This is a deliberate, narrow deviation
from the "behave exactly like native" doctrine.

**Correction folded in:** an earlier pass claimed "deleting the latency ceiling has no penalty" — *wrong*.
hls.js #6350 documents `targetLatency` drifting 1.4 s → 4.4 s over ~1 hour after stalls with no
auto-recovery (and rate-sync is *not* the fix). Over a 1–4 hour party on flaky Wi-Fi, stalls are
guaranteed, so the neutered hls.js needs the coarse `liveMaxLatencyDuration: 6` backstop (one rare
skip-to-live, exactly like native recovering) or Android ends up *worse* than native after stalls.

**Honest tradeoff:** this deliberately degrades Android (loses tight-to-live + auto-catch-up) in exchange
for whole-room uniformity. Parity is only as tight as the *worst* platform's stability: if iPhone 200 ms
parts stall (below), 350 ms parts raise the hold-back floor and Android is dragged up to match — never
the reverse.

## iOS 26 / macOS 26 baseline

- **Collapses the verification matrix to one OS.** iOS 26 did **not** lower the iPhone latency floor.
- **iPhone stability risk at 200 ms parts:** field reports (WINK) saw iPhone-only stalls over 20–60 min at
  200 ms parts; recommended **350 ms parts for iPhone**. Audio-only is lighter (should help) but *VERIFY*.
  If 200 ms stalls, 350 ms parts → higher hold-back floor → higher T for everyone.
- **Locked playback very likely holds — but UNVERIFIED; this gates the entire product.** The iOS 26 audio
  regressions are **PWA-scoped and Web-Audio-scoped** (the two paths we deliberately avoid); plain
  Safari-tab `<audio>` is unaffected in the release notes. Load-bearing practices already correct in
  `web/listener.html`. **One tightening:** call `mediaSession()` *synchronously within the click gesture*
  (before `await player.play()`), so the session registers even if the first `play()` rejects. **Never
  ship a PWA manifest / `apple-mobile-web-app-capable`** — that's exactly the surface iOS 26 broke.
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

1. **Locked-screen survival (THE GATE):** tap-to-start → lock 30+ min → multi-hour soak with DJ live, on
   a real iOS 26 iPhone. Currently pure inference; gates the product.
2. **The pocket test:** lock phone, attenuate Wi-Fi behind a body 3–10 s, confirm native HLS recovers
   near-live with zero interaction (validates the whole HLS-over-progressive choice).
3. **Settled iPhone live-edge latency** at 200 ms/500 ms (lands in 1.4–3 s, not silently 3 s+); hold-back
   sweep confirms ~1:1.
4. **iPhone 200 ms-part stability** over 30–60 min; fall to 350 ms if it stalls.
5. **Inter-device spread** across 2–3 iPhones side by side (the 10/10 metric) — how tight does uniform
   hold-back parking actually get, and how much do rebuffers spread it.
6. **`EXT-X-PROGRAM-DATE-TIME` present in the LL-HLS *part* playlist** (`curl ... | grep PROGRAM-DATE-TIME`)
   — the wall-clock anchor for any latency telemetry.
7. **`getStartDate()` validity** on the iOS native element (else show no per-listener number on iOS).
8. **Negative control:** confirm a plain tab, never a PWA.

## Prioritized build list (smallest-first)

1. Auto-open the DJ console on launch (`main.go`, ~2 lines). Rename "Start broadcast" → "Go Live".
2. Default bitrate 256k → 128–160k (`config.go`, `dj.html`).
3. **Force plain `hls` unless `Domain && CertFile && KeyFile`; remove the Mode dropdown from the UI**
   (extend `main.go`; delete `dj.html` Mode select). Kills the out-of-box trap where the llhls default +
   self-signed-on-IP cert = a stream iOS guests cannot play. Keep `/api/delivery` + `--delivery`.
4. Collapse the DJ panel to one screen (source line + Go Live + big QR; everything else behind "Advanced").
5. Apply the parity hls.js config + the `mediaSession()`-in-gesture tightening (`web/listener.html`).
6. Precise Screen-Recording flow (read the helper's `exit(3)`; first-run explainer; "Open Settings &
   Retry"). Silence detection + [Play test tone]. Empty-LAN/0-listener blocking banner.
7. Wire the latency mode to LL-HLS (`main.go`/`mediamtx`); add ffmpeg low-delay flags (mac branch).
8. `GET /api/time` + client NTP estimator (min-RTT) + per-listener latency telemetry on the heartbeat →
   DJ spread readout.
9. **"Synced" mode:** the outlier-robust solver picks T; apply via uniform server hold-back (lock-safe);
   auto-engage when spread warrants; DJ sees spread + cost. Gate to llhls (the `-f hls` fallback emits no
   PDT). Then PA inverse-delay (`adelay`) with the pre-delay-monitor rule.
10. Activate control plane (pure-Go ACME DNS-01, on-device key, fullchain cache) + guest-perspective
    self-test + auto-fallback ladder + one honest badge carrying *measured* latency. Largest; gated on
    hardware confirming iPhone LL-HLS is worth the cert vs plain ~3 s HLS.
11. Event Hub (`internal/hub`) — strictly after the two priorities land.
