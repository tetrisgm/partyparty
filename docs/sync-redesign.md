# Room-synchronized startup: critique and corrected design

Status: design review, 2026-07-09. Grounded in the shipped v47.59 code
(`web/listener.html`, `internal/server/server.go`, `internal/mediamtx/mediamtx.go`),
the fader91 field log (1 Mac, 2 iPhones, 2 iPads), a live probe of the bundled
MediaMTX v1.19.2's actual playlists, WebKit source, and RFC 8216 / LL-HLS spec.
This replaces the "room playout epoch" proposal — most of its *discipline* is
adopted; several of its *mechanisms* are rejected with evidence.

---

## 1. Verdict on the diagnosis

**Correct and confirmed:**
- Startup phase alignment is the whole problem. Steady state is perfect: every
  device held rate=1.0, stalls ≤102ms, spreads stable to ±30ms *within cohorts*
  for minutes. Nothing post-startup needs control.
- `currentTime` readback is not proof a seek committed. Per the HTML spec,
  reads echo the pending seek target until the seek resolves. The `.144`
  iPhone's `align-settled lat=6.201` while actually 22s behind is exactly this
  artifact, amplified by `anchorMediaClock(wanted)` (listener.html:1226)
  anchoring the projected clock to the *requested* position.
- `getStartDate()` can vanish mid-startup. The iPads logged `ref=none` at the
  final-correction instant, then `ref=pdt` in every later health sample — a
  transient flap during AVPlayer's timeline rebuild, at precisely the moment
  the algorithm had a single-instant dependency on it.
- A failed final correction still opens audio, mislabeled: `openAudioGate(gen,
  result !== null)` reports `aligned=true` off the *first* seek even when the
  final correction never ran (iPads: `corrected=false ref=none` →
  `audio-open aligned=true`, no `lat` field at all).
- The fixed 0.8s `NATIVE_UNMUTE_LEAD` cannot cover device variance — worse, it
  *manufactures* spread: post-refresh, iPhone A landed 6.223 (AVPlayer held
  position; the lead never materialized) and iPhone B landed 6.754 (AVPlayer
  drifted ~0.55s back, partially consuming the lead). The 529ms healthy-pair
  gap is the open-loop hack itself.
- Refresh rerolls AVPlayer state → nondeterminism. Confirmed: same model, same
  Safari 27, same build — one iPhone 6.2s, its sibling 22.1s, refresh moved it
  15.4s.

**Wrong or missing in the diagnosis:**
- **"1-second parts impose coarse native seek boundaries" is false.** WebKit's
  `currentTime` setter → `HTMLMediaElement::seek()` → zero-tolerance
  `seekToTime:` — sample-accurate (~1 AAC frame, ~23ms). Part duration affects
  the *natural start position* granularity, hold-back distance, and edge-
  mapping precision — never committed seek accuracy. Do not shrink parts
  hoping for finer seeks.
- **The diagnosis missed the dominant root cause: pre-live attach.** All three
  broken joins came from tabs opened ~30s before Go Live. They attached and
  prebuffered against a playlist that was empty/GAP-filled (MediaMTX backfills
  a new muxer's window with `EXT-X-GAP gap.mp4` entries — verified by live
  probe), so AVPlayer parked at a stale origin, the muted element did NOT
  advance during the setup window (the log shows join-frozen intervals ≈ the
  entire 8.8s hold), and every second of muted waiting leaked 1:1 into final
  delay: 7s target + ~9.4s frozen ≈ the observed 16.4s. The 22s iPhone is the
  same pathology plus two uncommitted seeks.
- **The waiting-leaks-into-delay mechanism was misattributed.** It is not
  "fixed delay treated as sync logic" in the abstract; it is concretely:
  seek to a fixed *position*, then wait wall-clock time while the player is
  not advancing, with no re-measurement before unmute. A moving target
  (`desired latency` re-evaluated at unmute time) or a verified-advancing
  precondition each kill it; the shipped code had neither on the failure path.

---

## 2. Ruthless critique of the proposed redesign

**FATAL — "on verification failure, remain muted and retry/recreate":**
unbounded silence is strictly worse than late audio, and the trigger is
*common* (the getStartDate flap hit 2 of 4 devices in one party). This
converts "guest 16s late" into "guest silent forever," recreating the exact
bug class (silent guard bail-out) that cost weeks. Every failure tier must be
time-boxed inside the join budget and terminate in *audible* audio with an
honest badge, or a visible broken-state UI. No third state.

**FATAL — "attach muted immediately" (pre-tap autoplay):** the muted-autoplay
exemption is a *video* policy; iOS Safari refuses un-gestured `<audio>`
playback, Low Power Mode blocks autoplay entirely, and an element not blessed
by an in-gesture `play()` may be refused the later programmatic unmute.
Worse, pre-live attach is the proven freeze factory (§1). Keep the shipped
gesture order: tap → muted `play()` inside the handler → align → auto-unmute.
The blessing is per-element and permanent, so recovery MUST reuse the same
element (a replacement element starts unblessed).

**WRONG PRIORITY — playlist-parse primary / getStartDate secondary:** on the
native path the element's media-timeline origin is arbitrary; a page-fetched
playlist cannot tell you where `currentTime` sits in program time.
`getStartDate()` *is* Apple's only supported bridge. The fix for its flakiness
is not demotion but **latching**: it is constant per attachment, so capture it
once when valid (poll across startup, 3–5 samples over ~1s), never re-poll at
a single gating instant. Page-fetched playlist data (PDT at edge, PART-INF,
PART-HOLD-BACK, media-sequence, the `<hash>_audio1_*` filename prefix) serves
as cross-check, hold-back source, and generation detector — not the bridge.

**OVER-BUILT — the T0/P0 epoch:** MediaMTX stamps PDT from an ingest-time
anchor on the *same Mac clock* `/api/time` serves. Program time and Mac wall
time are already one axis; the epoch equation collapses to
`desiredProgramTime(now) = calibratedMacNow − D` with a single constant `D`.
Publishing T0/P0/jitter as first-class state adds failure modes (epoch fetch
offline, generation mismatch loops) for zero precision gain. The existing
`latencyTarget` field IS the epoch, minus honesty about how D is derived.
Caveat discovered in verification: PDT can drift from wall clock (anchored at
first packet, extrapolated by publisher PTS, silently re-anchored) — this is
common-mode across listeners so it cancels for device-to-device sync, but it
means `lat` is *relative to the PDT anchor*, not true glass-to-glass.

**MISREAD DECREE — "one seek":** the product decree bans *audible*
corrections. Muted seeks are invisible to the room. A one-seek dogma forbids
the cheap correct move (one more muted, verified seek) and forces the
expensive one (player recreation — which on iOS risks losing the audio
blessing). Right constraint: a time budget (~10s from tap) and a loop-guard
(≤4 muted seeks), each gated on a fresh progression-verified measurement.

**REGRESSION RISK — "require seeking+seeked before unmute":** waiting after
the final assignment is precisely what commit 2836092 removed, citing a
measured, repeatable Safari 27 +1.3–1.6s cohort offset (AVPlayer holds its
program clock 0.6–1.0s after a muted seek). The reconciliation that makes the
wait safe: **verify-then-unmute**. The verification samples themselves absorb
the hold (it elapses while muted), which is also exactly what makes deleting
the 0.8 lead safe. But this reverses a field-derived fix, so it ships behind a
flag and gets re-validated on a Safari 27 device before default-on.

**UNQUALIFIED — performance.now() anchoring:** performance.now() freezes
across WebKit process suspension, and suspension-during-lock is this product's
foundational scenario. Anchor to `Date.now()` (as shipped), detect suspension
by dual-clock divergence (`ΔDate.now − Δperformance.now > 500ms` → resumed →
recalibrate + reverify before trusting any measurement), and mandatory
recalibration on `visibilitychange→visible` and after audio interruptions.

**WEAK — 4 concurrent clock samples:** concurrent samples share one Wi-Fi
airtime/AP queue wake — min-of-4-correlated ≈ one sample. The 300ms accept
gate allows ±150ms offset error per device (±RTT/2 asymmetry bound), which
alone can exceed the entire sync budget. Use 6–8 *sequential* samples spaced
~100–150ms, keep the min-RTT sample, accept only RTT < 100ms on LAN (retry
soon otherwise), and continue the existing 30s refresh.

**MISSING — the physical output floor:** no media-clock scheme can see the
audio output path. Built-in speaker ≈ 15–40ms; Bluetooth ≈ 150–300ms+, and
Safari exposes no outputLatency for media elements. A speaker phone next to an
AirPods phone will be ~200ms apart with *perfect* media-clock sync. Target
media-clock pair error <150ms; accept that mixed-output pairs land ≤500ms.
This consumes most of the 250ms ambition — set expectations accordingly.

**MISSING — plain-HLS mode:** the ffmpeg-direct fallback (no real cert) emits
NO PROGRAM-DATE-TIME. Every PDT mechanism silently doesn't exist there.
Either add `program_date_time` to its hls_flags (small, separate, owner-
supervised change) or explicitly badge plain-HLS guests as unsynced. Never
silent.

---

## 3. Corrected architecture

### 3.1 Room clock (server)

- Keep `/api/time` (Cristian midpoint) and `/api/status.latencyTarget` as the
  transport. `D = latencyTarget`, **frozen per stream generation**, derived
  once at go-live from geometry, not adapted (the room-health test that pins
  this is correct):

  ```
  D = PART_HOLD_BACK          (~2.507s measured from the live playlist)
    + 1 part duration          (1.0s — natural-start / landing granularity)
    + client fetch+settle      (1.5s)
    + safety margin            (1.0–2.0s)
    ≈ 6.0–7.0s  → keep the shipped 7.0
  ```

- **Serialize the stream generation.** `broadcast.Broadcaster` already keeps
  an internal `gen` guard; expose it as `/api/status.gen` (int, bumps on every
  ffmpeg (re)start). Clients hard re-attach on change. (The
  `<hash>_audio1_*` URI prefix already leaks this — the field is just honest.)
- Optional pilot, behind a config flag: inject `EXT-X-START:TIME-OFFSET=-D,
  PRECISE=YES` into the **multivariant** playlist in the existing Go
  `/live/*` reverse proxy (server.go already fronts all guest HLS; the
  multivariant is fetched exactly once per join and mints the session).
  Spec-legal; iOS likely honors it; macOS "mixed"; PRECISE is a SHOULD; and
  spec wants |offset| ≥ 3×TARGETDURATION = 6s — the 7s profile clears it by
  only 1s. So: pilot in the device test as a *coarse initial positioning
  assist* (shrinks first-seek distance to ~0 and stops early parking), but the
  verified muted seek remains the precision mechanism. Drop the pilot without
  regret if devices misbehave.

### 3.2 Client startup (native path; hls.js analogous)

State machine, all states time-boxed against `BUDGET = 10s` from tap:

```
IDLE            "Waiting for DJ" — no attach. NEVER attach before
                /api/status says live AND the playlist is publishing
                (streamHealth/PathPublishing already verifies this).
                A tab that attached anyway (or predates go-live, or sees
                gen change) MUST re-attach: same <audio> element, fresh
                index.m3u8 fetch (new MediaMTX session).
READY           live + prebuffer conditions met → button becomes "Tap to
                listen". (Room-level gating only — never per-device
                alignment gating on the button.)
TAP             (user gesture) → el.muted = true; el.play() INSIDE the
                handler (blesses the element; covers Low Power Mode).
                joinStartedAt = now.
CALIBRATING     ensure fresh clock (6–8 sequential samples, min-RTT,
                accept RTT < 100ms; reuse if <30s old). Runs concurrent
                with buffering.
SETTLING        wait until: playing, readyState ≥ 3, bufferedAhead ≥ 2.5s,
                AND progression proven (raw currentTime advanced ≥ 0.8×
                wall over ≥ 600ms). Latch getStartDate() when valid
                (poll; it is constant per attachment). Progress watchdog:
                frozen ≥ 2s with buffer present → re-attach same element
                (max 2 per join).
ALIGNING        err = lat_now − D, where lat_now = (serverNow −
                (startDateMs + rawCurrentTime·1000))/1000, sample valid
                only if progressAge < 500ms.
                |err| ≤ 0.35s → VERIFYING.
                Else ONE muted zero-tolerance seek:
                  target = currentTime + err   (moving-target form —
                  recompute err at assignment time, never reuse a stale
                  measurement)
                  clamped ≥ 0.5s inside seekable, ≥ 3s from edge.
                Await seeking → seeked (1.5s timeout) → back to SETTLING's
                progression proof → re-measure. Loop-guard: ≤ 4 seeks.
VERIFYING       3 consecutive valid samples spanning ≥ 600ms:
                |err| ≤ 0.35s, progression 0.9–1.1×, buffer ≥ 2.5s.
                (The Safari 27 post-seek hold elapses HERE, muted —
                this is what obsoletes NATIVE_UNMUTE_LEAD.)
LIVE            el.muted = false (element already blessed). Watch for the
                'pause' event / NotAllowedError → re-show tap UI (the
                honest failure signal). Log audio-open with the MEASURED
                lat, requested/landed/settled per seek, and
                aligned = (verification passed), never (a seek happened).
DEGRADED        budget exhausted before VERIFYING passes → unmute ANYWAY.
                |err| ≤ 1s or unmeasurable-but-progressing: no badge,
                log align-skip honestly. |err| > 1s: badge "syncing…",
                schedule ONE background muted re-align attempt via
                re-attach (rate-limited) only while foreground; else
                leave it — an out-of-sync guest is a guest.
BROKEN          not progressing at all at budget end → visible error UI
                + reload affordance. Watchdog invariant: within 15s of
                tap the guest HEARS AUDIO or SEES A BROKEN STATE. A
                muted player >15s post-tap emits a named blackbox event
                unconditionally.
```

Deletions this enables: `NATIVE_UNMUTE_LEAD` (0.8), `STARTUP_MIN_MS` (7s fixed
hold — readiness is verified, not timed; typical tap-to-audio drops from ~8.8s
to ~2–4s), the `anchorMediaClock(wanted)` optimistic anchor (anchor only on
`seeked`/`playing` with progression), and the 2-seek hard cap (→ budget + 4).

Post-unmute (unchanged decree): no app seeks, no rate control ever
(`maxLiveSyncPlaybackRate` stays 1.0 on hls.js). Recovery remains re-attach
through the muted gate. Extend stale-session re-attach triggers to
401/400/404/500 (401 is the dominant real code; 410 never occurs on MediaMTX
v1.19.2), always re-entering via `index.m3u8` on the SAME element.

### 3.3 Error budget (device-to-device, media clock)

| Term | Size | Notes |
|---|---|---|
| Clock calibration (per device) | ±15–50ms | sequential min-RTT, RTT<100ms gate |
| PDT anchor skew | ~0 pairwise | common-mode across listeners, cancels |
| Seek landing | ±23ms | zero-tolerance currentTime, 1 AAC frame |
| Verification tolerance | ±350ms | the knob; ±150ms is reachable on quiet LANs |
| getStartDate quantization | ±10–50ms | latched once, constant |
| **Media-clock pair total** | **≲400ms; typ. 100–300ms** | |
| Output path (speaker) | +15–40ms | uncorrectable |
| Output path (Bluetooth) | +150–300ms | uncorrectable, invisible to JS |

Speaker-to-speaker pairs: 250ms is achievable. Mixed BT pairs: ≤500ms is the
honest promise. Tightening `tol` below 0.35 buys nothing until the physical
test says the media clock is the limiting term.

---

## 4. Answers to the open design questions

1. **seekable.end ↔ playlist-edge mapping?** No — unfit as a primary frame.
   seekable updates on AVPlayer's internal refresh (effectively per 2s
   segment), lags the true edge 0–2s nondeterministically, and differs across
   Safari versions. Use seekable only as seek-target bounds.
2. **Browser playlist parsing vs Mac endpoint?** Neither as primary. The Mac
   already publishes the two numbers that matter (`latencyTarget`, and now
   `gen`); the getStartDate bridge does the rest. Client playlist fetch is a
   cheap *cross-check + gap/generation detector*, not a second clock.
3. **P0/headroom derivation?** §3.1 formula; computed once at go-live, frozen.
   The Mac selects it — never each listener (per-listener derivation would
   recreate exactly the current chaos).
4. **Epoch fixed per generation?** Yes. `D` and `gen` freeze at go-live.
5. **Discontinuities/resets?** Every ffmpeg (re)start = new generation: bump
   `gen`, clients hard re-attach (new session, new timeline, re-latch
   startDate). MediaMTX invalidates old sessions with 401/400/404/500 —
   treat any of them as generation-changed.
6. **Can one authoritative seek be reliable?** One *verified* seek usually
   suffices; reliability comes from the verify-reseek loop (≤4), not from
   making seek #1 sacred. Seeks are sample-accurate; landings get perturbed
   by edge clamping and the Safari 27 hold — both absorbed muted.
7. **Validating seek completion beyond `seeked`?** Progression proof: raw
   currentTime advancing 0.9–1.1× wall across ≥600ms with progressAge <500ms,
   and the err measurement stable. `seeked` alone acknowledges the request;
   only advancement proves a live pipeline.
8. **getStartDate — secondary or avoided?** Neither: PRIMARY but LATCHED.
   It is the only supported bridge from program time to the element timeline;
   its flaw is single-instant availability, fixed by capture-once semantics.
9. **Smaller parts (200–500ms)?** Not for sync. Seeks are already
   sample-accurate; parts only quantize the *natural* start position, which
   the aligned seek overrides anyway. Smaller parts = 2–5× request rate on
   party Wi-Fi and shorter hold-back (closer to edge = riskier). Keep 1s/2s.
10. **Better protocol under the lock-screen constraint?** No. WebRTC loses
    lock-screen/Now-Playing and burns battery; MSE (ManagedMediaSource on
    iOS 17.1+) stalls when JS suspends under lock. Native HLS + verified
    startup is the correct architecture. (Plain-HLS fallback: badge unsynced
    or add PDT to ffmpeg flags.)
11. **Failure behavior?** The tiered ladder in §3.2. Audible-with-badge beats
    muted-retry; muted-forever is forbidden by watchdog invariant.
12. **Weakest remaining assumptions?** (a) verify-then-unmute genuinely
    neutralizes the Safari 27 hold — flag-gated until a Safari 27 device test
    passes; (b) EXT-X-START behavior in LL-HLS mode on device; (c) the freeze
    watchdog's re-attach actually unfreezes a parked AVPlayer (vs needing a
    cache-busted URL) — covered by the pre-live-attach fix but verify; (d) BT
    output latency spread at a real party (measure, don't model).

---

## 5. Test plan

**Bench (automatable, extend `scripts/stream-e2e.mjs`):**
- Repro A — pre-live freeze: attach a listener 30s before publishing starts;
  assert the client re-attaches at go-live and reaches verified-aligned.
- Repro B — uncommitted seek: fault-inject a seek that never fires `seeked`
  (mock/pause); assert no unmute until progression-verified, then DEGRADED
  path with honest telemetry, never `aligned=true`.
- Repro C — generation change: kill+restart the publisher mid-listen; assert
  re-attach on 401 and re-alignment on the new timeline.
- Assert-never: `audio-open` with `aligned=true` but no measured `lat`;
  muted >15s post-tap without the watchdog event.

**Physical (the only ground truth):**
- Click-track source through the EXACT tee: `aevalsrc` impulse pattern (1kHz,
  10ms burst every 2s, distinctive double-click every 10s for unambiguous
  correlation) as a selectable test source.
- 4+ devices on speaker at matched volume, one mic (ffmpeg avfoundation
  capture on the Mac), 60s recording → numpy cross-correlation → pairwise
  offset matrix.
- Acceptance: all speaker pairs <250ms (target <150ms); document BT pairs
  separately; repeat ×10 with per-run refresh of one device — every rejoin
  lands within tolerance (kills the refresh-roulette bug class).
- Chaos matrix: join pre-live / at go-live / mid-set; lock+unlock during
  startup and during steady state; Wi-Fi micro-dropout; publisher rebuild
  (device change); Safari 26 vs 27; Low Power Mode.

**Field telemetry acceptance (blackbox already exists):**
- p95 verified |err| at unmute ≤ 350ms; DEGRADED joins <5%; BROKEN <1%;
  zero watchdog silent-join events; `ua-seek` (seeks not issued by app code)
  and startDate-flap counts logged per join — the two Safari behaviors the
  current telemetry cannot distinguish from app action.

**Rollout order (the false-live lesson: manifest health ≠ audible):**
1. Telemetry-only OTA: honest measurement, requested/landed/settled seek
   logging, watchdog event, `gen` field — zero behavior change.
2. Bench repros green.
3. Behavior change behind an OTA config flag; physical mic pass on Safari 26
   + 27 devices; flip at the owner's own party first, then default-on.
