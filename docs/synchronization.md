# Music synchronization

## Playback schedule

A source sample captured at time `T` should play on every listener at `T + D`.
`D` is one fixed room buffer, currently two seconds. Arrival time is not the
playback deadline. Wi-Fi variation consumes that buffer; a struggling device
must not move the deadline for everyone else. The part hold-back floor is
600 ms, while segment/part geometry remains 500/150 ms.

Publishing `EXT-X-START` and `PART-HOLD-BACK` alone does not make AVPlayer choose
the same media position as hls.js. Both engines now use the source clock to
position a muted attachment before opening audio. iPhone still uses native HLS.

The controller measures seek completion cost and compensates the next requested
position. A seek is not considered settled until source delay stays stable for
200 ms, at least 350 ms after the seek. Startup aims within 25 ms of the deadline,
with at most eight positioning attempts and a 12-second timeout. Six seconds
without usable clock metadata permits uncalibrated playback, visibly marked
“Sync timing unavailable”; a measured alignment failure requires Retry.

Healthy playback is passive and stays at normal speed. A visible listener more
than 150 ms off target, after subtracting timing uncertainty, is checked three
times at 250 ms intervals. It then gets a muted correction in the same attachment,
retaining clock mapping and measured seek cost. Recovery accepts a stable landing
within 75 ms rather than resetting the decoder again to remove a few tens of
milliseconds. The test separately requires recovery within two seconds of the
fault ending, including detection. The controller itself aborts a repair after
two seconds and shows Retry instead of silently releasing out-of-sync audio.
There is no session quota or escalating cooldown.

Pause, tab takeover, transport replacement, and playback failure cancel pending
alignment. On hiding the page, playback is released before JavaScript timers can
be suspended. Previously heard source samples provide a lower bound for any
correction, including an early player's return to the deadline. Broken media
sessions can still reattach; a reliable but late clock no longer requires one.
Missing timing alone never interrupts ongoing audio. Hidden/locked players stay
passive, so foreground tests cannot establish background synchronization.

## Clock implementation

1. MediaMTX uses `useAbsoluteTimestamp: true` to preserve the publisher's
   RTCP sample clock instead of stamping packet arrival time. Source
   `PROGRAM-DATE-TIME` is retained on direct and relay paths. Media
   playlists also contain sparse `X-PP-TIME` date-range cues, authored by
   `internal/schedule/clock.go`, pairing source time with native media time.
2. The listener calibrates a monotonic browser clock against `/api/time` using
   four timestamps. Estimates expire and include network and upstream clock
   uncertainty. An old DJ's in-flight request cannot overwrite a new estimate.
   Sleep or a wall-clock discontinuity invalidates the estimate.
3. Relayed guests receive source time, not relay wall time or a cached timestamp.
   Each contribution cycle calibrates the relay/source offset through the
   authenticated `__pp/time` endpoint. The relay advances that estimate with its
   monotonic clock and expires it after 15 seconds. Guests do not round-trip to
   the Mac. An older relay can continue serving media without this capability;
   its clock remains unavailable until both ends support the protocol.
4. WebKit rounds `getStartDate()` to a whole second, introducing up to 500 ms of
   uncertainty. Native HLS date-range `DataCue.startTime` retains fractional
   timing. The reader requires at least two agreeing cues and checks them
   against the rounded origin. Missing/inconsistent cues fall back to explicitly
   coarse timing. A validated mapping can bridge
   up to six seconds of missing cues during a seek, checked against the native
   rounded origin and discarded on attachment/discontinuity.
5. Missing clock telemetry never interrupts ongoing playback. The visible-only
   late-device recovery subtracts measurement uncertainty before deciding that a
   device is more than 150 ms off target. Hidden/locked playback remains passive.

The WebKit rounding and date-range conversion are visible in
[`getStartDate` and `metadataGroupDidArrive` in WebKit](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/avfoundation/objc/MediaPlayerPrivateAVFoundationObjC.mm).
These are implementation details, so cue availability is checked at runtime.
MediaMTX documents its arrival-time default and the publisher-clock option in
[Route absolute timestamps](https://mediamtx.org/docs/features/absolute-timestamps).
The native/mixed lab checks that successive playlist timestamps differ by the
intervening media duration, within 2 ms. Agreement between two reported player
clocks is insufficient if the source playlist itself describes inconsistent time.

The bundled hls.js is 1.7.3; its exact distribution and license are recorded in
[the vendor notes](../web/vendor/README.md). Playback speed and per-stall target
growth are disabled because the shared source deadline owns recovery.

## HTTPS and latency

HTTPS remains necessary for the supported secure guest path. Encryption itself
does not synchronize players. HTTP transport capabilities can affect whether
Apple's low-latency HLS path is used; an HTTP-only loopback experiment is not an
adequate substitute for testing the actual HTTPS guest path. Apple's HLS author
describes the HTTP/2 requirement and later HTTP/3 support in
[this HLS protocol discussion](https://mailarchive.ietf.org/arch/msg/hls-interest/RcZ2SG8Sz_zZEcjWnDKzcM_-TJk/).

The September 11 HTTP-only hold-back experiments remain useful evidence about
those configurations, not a guarantee of three-second HTTPS playback.

## Reproducing validation

```sh
go test ./...
npm test
node scripts/stream-e2e.mjs --scenario=sync
PP_SYNC_CHROMIUM=1 PP_SYNC_SECONDS=600 node scripts/native-sync-lab.mjs
```

The native lab runs the actual guest page in two isolated macOS WKWebViews with
staggered joins, real HLS, and loopback HTTPS. Test-certificate trust exists only
inside that process; no Keychain changes are made. It asserts native playback,
precise clock coverage, continuity, absence of backward movement after startup,
and 100 ms bounds on p95 deadline error and peer spread.
The test deliberately bypasses user-gesture requirements and mutes output; it
cannot validate iPhone autoplay, lock-screen behavior, or speaker timing.

`PP_SYNC_CHROMIUM=1 PP_SYNC_DRIFT=1 PP_SYNC_SECONDS=90 node scripts/native-sync-lab.mjs`
adds a Chromium listener and introduces three 1.2-second media-clock freezes into
one native listener. Only each actual fault plus two seconds of recovery is
excluded for that listener. Recovery must stay within 100 ms for a full second,
without a new attachment or audible seek. Unexpected muting outside those bounded
windows fails. Healthy native and Chromium listeners are checked throughout,
including their agreement with each other.

`PP_SYNC_CLOCK_ONLY=1` explicitly disables the deadline assertion for baseline
investigation. `PP_NATIVE_HTTP=1` is an explicitly different transport experiment.
Neither mode establishes synchronized production playback. Rejected experiments
and the passing predictive prototype are retained with their exact guest page,
injected source, and raw measurements in the receipts, outside the runtime.

Keep raw measurements, summary, transport, source fingerprints, and the exact
candidate source with each receipt under `docs/receipts/`. The older
`scripts/soak-playback.sh` release check and supervised physical-device test in
[the playback contract](PLAYBACK-CONTRACT.md) still apply. The microphone procedure
is in [scripts/synctest](../scripts/synctest/README.md).

## Physical validation still required

[Earlier recorded comparisons](receipts/sync-20260916/README.md) preserve the
three-second implementation and rejected recovery result. Its “pass” admitted
11.34 seconds from fault onset to measured recovery because the gate excluded
20 seconds; the owner rejected that result. It is not evidence for the current
recovery requirement. Candidate reductions to 1.5 seconds also failed repeat
runs when AVPlayer's seekable range could not reach the deadline.

The [final ten-minute mixed-engine run](receipts/sync-recovery-20260916/README.md)
passed at the two-second target: 30 ms p95 native/native spread, 14 ms p95
native/Chromium spread, and three recoveries of 1.567–1.569 seconds after each
1.2-second freeze ended. These are media-clock observations from one Mac, not
physical speaker guarantees. Healthy listeners remained continuous.

The release still requires supervised physical iPhone/Android tests with
staggered joins, sustained listening, a late device, foreground/background
transitions, real autoplay gestures, and measured acoustic spread.
Bluetooth/DAC output delay is separate from the media timeline and must be
measured or compensated before claiming synchronized sound.

No upload, deployment, or reinstall is part of this source change. The native
test exercises macOS WebKit/AVPlayer, not physical iPhones, Bluetooth devices,
or Safari's actual user-gesture policy.
