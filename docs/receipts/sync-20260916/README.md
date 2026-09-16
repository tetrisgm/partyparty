# Synchronization receipts — 2026-09-16

All native runs used real macOS WKWebView/AVPlayer, the Go guest server, synthetic
audio, and loopback HTTPS. The host reported macOS 27.0 (26A5425a). Certificate
trust was confined to the test process. Audio output was silent, and user-gesture
requirements were disabled. These are media-clock tests, not physical iPhone,
speaker, Bluetooth, or lock-screen validation.

| Run | Duration | Median delays | p95 peer spread | Result |
| --- | ---: | ---: | ---: | --- |
| [Clock fixes, original attachment](native-clock-600s/summary.json) | 600 s | 1.165 / 1.326 s | 162 ms | Clock/continuity passed; 3 s deadline not met |
| [Uncompensated positioning](candidate-passive/summary.json) | 90 s | 1.185 / 3.453 s | 2269 ms | Rejected |
| [Predictive prototype](candidate-predictive-600s/summary.json) | 600 s | 2.996 / 2.927 s | 70 ms | Passed |
| [Integrated native startup](native-integrated-600s/summary.json) | 600 s | 3.024 / 3.004 s | 21 ms | Passed |
| [One interrupted native listener](native-fault-90s/summary.json) | 90 s | 2.981 / 3.004 s | 24 ms | Rejected: recovery gate was too permissive |

The integrated ten-minute run had 100% precise timing coverage after startup,
normal playback rate throughout, no observed stalls, and no backward movement.
The fault run introduced a 1.2 s media-clock freeze at 30.24 s. Delay peaked at
4.285 s and returned to the room target at 41.58 s. The healthy peer remained
continuous; neither listener performed an audible seek. The deliberately
disturbed listener's 30–50 s interval is excluded from steady-state statistics,
with fault detection and recovery checked separately.
The owner rejected this recovery time. The previous pass label did not establish
acceptable recovery: it allowed a 20-second exclusion. The current test permits
only the actual interruption plus two seconds, and preserves this trace as a
regression reference.

`native.jsonl.gz` contains complete raw telemetry, including startup and the
fault interval. `listener.html.gz` is the exact guest page recovered from each
test binary; where `source-sha256.json` is present, its fingerprint was verified.
The archived injected controllers and setup scripts belong to their respective
experiments and are not application code. In the oldest summary, `metadata:
false` means the extra lab proxy was disabled, not that production clock cues
were absent.

The fault run includes the stale-attachment positioning and visibility lifecycle
fixes added after the integrated soak. The final relay clock quality selection
does not change direct samples with zero upstream uncertainty; it has separate
unit coverage. See [the implementation report](../../synchronization.md) for the
current runtime and reproduction commands.

[Chromium sync](chromium-sync.log) passed the tightened 100 ms gate, including a
650 ms drift injection and isolation from a guest without timing telemetry.
Its measured p90 spread was 10 ms after delayed joining and 44 ms after the
injected drift. [Go, npm, and clock race checks](checks.log) also passed.
