# Music synchronization

## Playback schedule

A source sample captured at time `T` should play on every listener at `T + D`.
`D` is one fixed room buffer, currently three seconds. Arrival time is not the
playback deadline. Wi-Fi variation should consume that buffer; a struggling
device must not move the deadline for everyone else.

Publishing `EXT-X-START` and `PART-HOLD-BACK` alone does not make AVPlayer choose
the same media position as hls.js. Native startup now explicitly positions a
fresh attachment against source time while muted, then releases it to ordinary
playback. HTTPS, the native iPhone engine, encoded audio, and the fixed buffer
target are retained.

The controller accounts for the time a seek consumes: aiming at the position
appropriate before a seek leaves playback late when that seek completes. It
measures the resulting error and adjusts the next requested position. There are
at most eight positioning attempts, an 800 ms settling period, and a 12-second
overall startup deadline. Clock metadata can take several seconds to arrive;
six seconds without usable timing falls back to native playback. A device that
misses alignment is reported as such rather than changing the room target.

Only a fresh, muted attachment can be positioned. Pause, tab takeover, transport
replacement, and playback failure cancel that work. On hiding the page, native
playback is released before JavaScript timers can be suspended. Previously heard
source samples provide a lower bound for re-attachment positions.

Healthy native playback has no continuous seek or rate controller. The existing
visible-only recovery still requires three observations at least 750 ms late,
then reattaches only that listener; the new attachment is aligned again. Smaller
drift is not continuously corrected. The lab's 100 ms steady-state check is not
a guarantee under every interruption, device clock, or audio-output route.

## Clock implementation

1. Source `PROGRAM-DATE-TIME` is retained on direct and relay paths. Media
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
   coarse timing. The mapping is revalidated after attachment/discontinuity.
5. Missing clock telemetry never interrupts ongoing playback. The visible-only
   late-device recovery subtracts measurement uncertainty before deciding that a
   device is at least 750 ms late. Hidden/locked playback remains passive.

The WebKit rounding and date-range conversion are visible in
[`getStartDate` and `metadataGroupDidArrive` in WebKit](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/platform/graphics/avfoundation/objc/MediaPlayerPrivateAVFoundationObjC.mm).
These are implementation details, so cue availability is checked at runtime.

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
PP_SYNC_SECONDS=600 node scripts/native-sync-lab.mjs
```

The native lab runs the actual guest page in two isolated macOS WKWebViews with
staggered joins, real HLS, and loopback HTTPS. Test-certificate trust exists only
inside that process; no Keychain changes are made. It asserts native playback,
precise clock coverage, continuity, absence of backward movement after startup,
and 100 ms bounds on p95 deadline error and peer spread.
The test deliberately bypasses user-gesture requirements and mutes output; it
cannot validate iPhone autoplay, lock-screen behavior, or speaker timing.

`PP_SYNC_DRIFT=1 PP_SYNC_SECONDS=90 node scripts/native-sync-lab.mjs` introduces
a 1.2-second media-clock freeze into one listener. Its deliberately disturbed
30–50 second interval is excluded from steady-state statistics, but the test
separately requires an observed delay of at least 750 ms and recovery within that
interval. The healthy listener's continuity remains checked throughout.

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

[Recorded native comparisons and full traces](receipts/sync-20260916/README.md)
include the failed prototypes, the ten-minute integrated run, and recovery from
an injected late listener. The integrated run measured 21 ms p95 peer spread at
the fixed three-second target. This is a result from that Mac test, not a promise
of physical speaker alignment on every device.

The release still requires supervised physical iPhone/Android tests with
staggered joins, sustained listening, a late device, foreground/background
transitions, real autoplay gestures, and measured acoustic spread.
Bluetooth/DAC output delay is separate from the media timeline and must be
measured or compensated before claiming synchronized sound.

No upload, deployment, or reinstall is part of this source change. The native
test exercises macOS WebKit/AVPlayer, not physical iPhones, Bluetooth devices,
or Safari's actual user-gesture policy.
