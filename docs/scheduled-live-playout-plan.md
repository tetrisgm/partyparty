# Native HLS scheduled playout: comparison and shipping plan

Status: revised architecture proposal, 2026-07-13. This incorporates the
`fader91` packed-party evidence and the permanent product requirement that an
iPhone keeps playing while locked or while Safari is backgrounded.

## Non-negotiable invariant

Native HLS playback through the iPhone `<audio>` element remains the production
player. Lock-screen and background playback are never traded for synchronization
precision.

The following are therefore out of scope as listener replacements:

- Web Audio and AudioWorklet;
- JavaScript-fed Media Source or Managed Media Source;
- a PWA execution model;
- a required native guest app;
- any transport whose continued playback depends on foreground page JavaScript.

The scheduled-playout idea must be expressed through the pipeline that already
survives a locked phone: AAC-LC, LL-HLS, and AVPlayer.

## Reframe

For a live source, "play media stamped P at wall time T" is equivalent to "hold
one constant room delay D," where `T = P + D`.

Party Party already contains the main pieces:

| Scheduled-playout concept | Native HLS mechanism | Current status |
|---|---|---|
| Identical immutable chunks | One MediaMTX AAC/fMP4 part stream | Shipped |
| Authoritative media timestamp | `EXT-X-PROGRAM-DATE-TIME` | Shipped |
| Shared room clock | Mac `/api/time` calibration | Shipped |
| Future presentation point | Fixed room target behind the Mac | Shipped |
| Preferred start position | `EXT-X-START:TIME-OFFSET=-D,PRECISE=YES` | Shipped, imperfectly honored |
| Stable playout after start | AVPlayer at rate 1.0 | Field-proven |
| Gross-drift recovery | Per-phone reattach watchdog | Shipped, awaiting packed-party validation |

This is already a continuously authored scheduled timeline. The next work is
not a new player or media plane. It is making native AVPlayer's initial draw
from that timeline narrower and rejecting a bad draw while playback is still
muted.

## What the packed party established

The Seth Mac session (`fader91`, v53.61, 8 phones, 85 minutes) is the control:

- 26 of 26 opens became audible.
- Most opens landed in about 3.0-4.5 seconds.
- A simultaneous cohort spread about 0.69 seconds.
- No native startup seeks.
- Publisher restarts recovered automatically.
- One externally scrubbed phone remained about 34 seconds late until the end;
  the subsequently shipped drift watchdog now reattaches that class of client.

The production system is robust. "Precise" must tighten the startup distribution
without reintroducing silent phones, startup seeks, or lock/background failures.

## The two remaining startup levers

### 1. Shape the playlist geometry

Current geometry:

```text
segment target: 2 seconds
part target:    1 second
room pin:      -3 seconds in the current Balanced profile
```

Candidate Precise geometry:

```text
segment target: 1 second
part target:    500 milliseconds
room pin:      -3 seconds
```

RFC 8216 says a live `EXT-X-START` offset should not be within three target
durations of the playlist end. With two-second segments, a three-second pin is
inside that discouraged zone. With one-second segments, the same pin reaches
the three-target-duration boundary.

`PRECISE=YES` asks the client not to render samples before the requested offset.
It remains a preferred start instruction, not a hard real-time guarantee.

The expected benefit is a finer natural-start distribution. It is not correct
to claim that AVPlayer can only seek on chunk boundaries; native media seeks can
be finer than that. The relevant behavior here is the no-seek natural startup
position chosen by AVPlayer from the live playlist.

Halving part duration, rather than segment duration alone, is what principally
raises LL-HLS playlist and media-object request cadence. Apple recommends a
one-second part target and requires the part target to cover expected RTT, so
500ms is an experiment that must earn its place on physical venue Wi-Fi.

### 2. Re-roll a bad natural start while still muted

The native no-seek path currently verifies its achieved latency but opens audio
even when the result is outside the strict alignment tolerance. That rule was
correct for eliminating silent-forever joins.

Precise may make one bounded second draw:

1. Attach only after the stream generation is ready.
2. Start the existing user-blessed `<audio>` element muted.
3. Prove playback is advancing and latch program time.
4. Measure achieved latency against the frozen room target.
5. If error is at most one second, open audio.
6. If error exceeds one second and at least four seconds remain in the startup
   budget, reattach the **same** element once and repeat.
7. After the second progressing draw, open audio regardless of measured error.
8. If no draw progresses, retain the existing visible Retry Sync state.

Safety properties:

- no native seek;
- no playback-rate change;
- no replacement audio element and no loss of the user's audio blessing;
- never more than one automatic re-roll;
- never remain muted merely because timing is imperfect;
- no audible correction after the gate opens.

The re-roll must have its own telemetry (`start-reroll`, first error, second
error, elapsed budget, generation) so the field test can prove whether it
actually improves the tail rather than simply adding join time.

## Important implementation constraint

The existing sync picker changes only target, pin, and startup-seek policy. It
does **not** change MediaMTX segment or part geometry. Those values are written
to `mediamtx.yml` when the app starts.

Therefore Precise cannot honestly be implemented as one more in-memory preset
that instantly changes geometry. The implementation needs two layers:

1. A stream profile (`balanced` or `precise`) that owns part duration, segment
   duration, segment count, target, pin, and native re-roll policy as one
   coherent configuration.
2. A controlled profile transition that stops the current publisher, rewrites
   MediaMTX configuration, restarts MediaMTX, starts a new stream generation,
   and lets every phone reattach through the existing generation-change path.

The UI must say that changing stream profile briefly restarts the room. A failed
Precise start must automatically restore the previous known-good MediaMTX
configuration and leave Balanced available.

This transition changes Go/runtime behavior and requires a full native release.
It must not be delivered as payload-only.

## Proposed Precise profile

Initial values, frozen for the first A/B:

| Setting | Balanced control | Precise candidate |
|---|---:|---:|
| Segment duration | 2s | 1s |
| Part duration | 1s | 500ms |
| Playlist window | 32s | 32s (32 segments) |
| Room target | Same frozen target | Same frozen target |
| `EXT-X-START` | On | On |
| Native startup seek | Off | Off |
| Muted natural-start re-roll | Off | Once if error >1s |
| Audible correction | Never | Never |

Keep the same room target in both profiles for the first comparison. Lowering
latency and changing geometry simultaneously would make the result
uninterpretable.

The 32-second window is held constant in wall-clock duration. Using 16 one-second
segments would silently halve recovery history and confound the test. The
current OTA allowlist caps `segCount` at 30, so the integrated profile must
either raise that validated bound to 32 with tests or use a documented 30-second
window; it must not silently accept a shorter window.

## Implementation sequence

### Phase 1: geometry-only startup test

Use the existing startup-time OTA server overrides to run 1s/500ms geometry on
the test Mac, with the production listener unchanged.

Verify before adding re-roll logic:

- actual `TARGETDURATION`, `PART-TARGET`, `PART-HOLD-BACK`, real history, and GAP
  history from a live generated playlist;
- readiness still waits for enough real, non-GAP history;
- the three-second `EXT-X-START` is present on the multivariant playlist;
- 8 simultaneous physical iPhone joins, including iOS 26.4 and iOS 27;
- 60-minute lock test and 30-minute Safari-background test;
- publisher restart and Wi-Fi attenuation recovery;
- playlist/part request cadence and compressed bytes from the part-cadence
  telemetry already shipped.

Exit gate: 100% audible opens, no startup seeks, no lock/background regression,
and a startup spread materially tighter than the 0.69-second control.

### Phase 2: bounded muted re-roll

Add one native re-roll behind an explicit experiment flag. Test it first against
the production 2s/1s geometry, then against 1s/500ms. This separates the value of
the stream shape from the value of taking a second draw.

Exit gate: the re-roll must improve p95 startup error without increasing silent
opens, manual retries, or tap-to-audio beyond the bounded startup budget.

### Phase 3: integrated Precise profile

Add the coherent stream profile and controlled MediaMTX rebuild. The profile
switch must:

- be DJ-only;
- reject concurrent transitions;
- report transitioning/success/failure in `/api/status`;
- produce a fresh generation;
- preserve the same audio capture permission and source selection;
- roll back to the previous config if MediaMTX readiness fails;
- never fall back to plain HTTP HLS.

Automated verification must cover configuration writing, profile validation,
restart serialization, rollback, status contracts, pin injection, readiness,
and listener reattachment telemetry.

### Phase 4: physical A/B

Run this order with built-in speakers:

```text
Balanced -> Precise geometry -> Precise + re-roll -> Balanced
```

For every dwell, capture:

- attempted and audible opens;
- tap-to-audio median/p95;
- simultaneous cohort media-clock spread;
- microphone-measured acoustic spread;
- startup error before and after any re-roll;
- lock/background continuity;
- stalls, rebuffers, reconnects, drift reattachments, and publisher recovery;
- per-client playlist/part cadence;
- Mac CPU and LAN traffic at 8 physical and 32 simulated listeners.

Acceptance for promotion:

- 100% eventual audible opens;
- no silent-forever or repeated re-roll loop;
- p95 acoustic spread at most 500ms and materially better than Balanced;
- no gross late client lasting beyond the watchdog recovery bound;
- no lock-screen, background, Control Center, camera-return, or pocket-test
  regression;
- no venue-Wi-Fi starvation attributable to doubled part cadence;
- one unhealthy phone never changes healthy listeners.

### Phase 5: canary and default

Ship Precise as an opt-in profile first. Keep Balanced as the immediate rollback.
Promote Precise only after two packed parties on both iOS generations pass the
acceptance criteria.

Do not delete Balanced, the drift watchdog, or the native no-seek fallback in the
first default release. The fallback remains for one full release and until field
telemetry shows no platform cohort needs it.

## Kill criteria

Do not promote 1s/500ms if it:

- increases silent starts or manual retries;
- loses playback while locked or backgrounded;
- causes playlist/part starvation on packed venue Wi-Fi;
- fails to materially improve acoustic spread;
- needs audible seeks or rate changes to hold the result;
- requires less recovery history than the room currently has.

If finer geometry fails, retain native HLS and the current 2s/1s profile. The
bounded muted re-roll can still be judged independently. Lock-screen playback is
not an optimization variable.

## Verification results (2026-07-13, Claude)

Independent checks of this plan's load-bearing claims:

**RFC 8216 three-target-duration rule — CORRECT, with one sharpening.** The
verbatim rule: "If the Playlist does not contain the EXT-X-ENDLIST tag, the
TIME-OFFSET SHOULD NOT be within three target durations of the end of the
Playlist file." At TARGETDURATION=1 a -3s pin lands EXACTLY at the boundary —
marginally compliant under the tag-side "within" (inclusive reading), while the
client-side rule (§6.3.3, "less than three target durations") permits it.
More useful: RFC 8216bis (draft-22, current) changed the client live-edge rule
to defer to HOLD-BACK/PART-HOLD-BACK for LL-HLS clients. What governs AVPlayer's
willingness to start at the pin is therefore the pin-to-PART-HOLD-BACK margin,
and that is where Precise geometry wins decisively (measured below).

**Apple part-target guidance — the caution inverts on a LAN.** Apple's rules
verbatim: 14.2a part target MUST be ≥ P95 RTT; 14.2b SHOULD be ≥ 3× P95 RTT;
14.2c RECOMMENDED is one second; 14.3 PART-HOLD-BACK MUST be ≥ 3× part target.
On this product's LAN (measured phone RTT 2-15ms at the packed party), 500ms
parts clear the MUST by ~33x and the SHOULD by ~11x; Apple's own canonical
LL-HLS example uses 333ms parts. The 1s recommendation exists for CDN/internet
scale. The doubled request cadence (~4 req/s per client) is the real cost and
lands on a local Go binary. Rule 14.3 predicts the benefit: halving the part
target halves the minimum hold-back. So on LAN the spec math cuts in FAVOR of
500ms parts; what still needs the physical test is AVPlayer behavior, not spec
compliance.

**Geometry pre-validated against the real engine (bundled MediaMTX v1.19.2,
bundled ffmpeg AAC test tone, loopback).** With `1s / 500ms / segCount 32` the
engine accepted the config unmodified and produced:

```text
#EXT-X-TARGETDURATION:1
#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.28000,CAN-SKIP-UNTIL=6.00000
#EXT-X-PART-INF:PART-TARGET=0.51200
32 full segments retained (32s window), parts INDEPENDENT=YES, PDT present, 0 GAP after startup
```

Key numbers: **PART-HOLD-BACK drops 2.507s → 1.280s**, so the -3s pin's margin
behind the minimum hold-back grows **0.5s → 1.7s** — the strongest quantitative
reason to expect AVPlayer to honor the pin more precisely. The readiness parser's
math applied to the captured playlist yields realHistory 34.09s / gap 0 /
streamReady at a 3s target — readiness logic survives 1s units. (Note in
passing: MediaMTX's PART-HOLD-BACK factor is 2.5× part target, below Apple's
3× authoring rule at ANY geometry — pre-existing, field-tolerated by AVPlayer,
not a Precise regression.)

**Phase 1 needs zero code.** Geometry env vars already exist
(`PARTYPARTY_SEG_DUR`, `PARTYPARTY_PART_DUR`, `PARTYPARTY_SEG_COUNT` —
config.go flags), so the test Mac can run Precise geometry locally by launching
the app binary from a terminal with those set, while every other install stays
on Balanced geometry. The OTA `segCount ≤ 30` cap only binds the Phase 3
integrated profile (the env/flag path is uncapped); Phase 3 should raise it to
32 with tests as planned.

## References

- [RFC 8216 `EXT-X-START`](https://datatracker.ietf.org/doc/html/rfc8216#section-4.3.5.2):
  preferred start point, `PRECISE`, and the three-target-duration guidance.
- [Apple HLS authoring specification](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/):
  LL-HLS part-target RTT guidance and recommended one-second part target.
- [Apple LL-HLS documentation](https://developer.apple.com/documentation/http-live-streaming/enabling-low-latency-http-live-streaming-hls):
  partial segments, blocking reloads, and playlist request behavior.
