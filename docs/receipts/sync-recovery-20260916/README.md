# Low-delay synchronization and bounded recovery — 2026-09-16

These tests exercise the real Go guest server and HLS media, with ephemeral
loopback HTTPS. Native clients are macOS WKWebView/AVPlayer; mixed runs also use
Chromium/hls.js. They use synthetic audio, silent output, and disabled gesture
restrictions. They do not establish physical phone, speaker, Bluetooth, or
lock-screen synchronization.

The fixed room deadline is two seconds. The normal segment/part geometry stays
500/150 ms; the hold-back floor is 600 ms. Recovery is measured separately from
normal delay. Each injected media-clock freeze lasts 1.2 seconds. Only that fault
plus two seconds is excluded for the affected listener, with a separate recovery
assertion. All healthy listeners remain under continuous measurement.

| Run | Result |
| --- | --- |
| [1.5-second candidate](rejected-1500ms/summary.json) | Rejected: native seekable range could not consistently reach the deadline |
| [Overly tight repair landing](rejected-tight-repair/summary.json) | Rejected: a second seek to remove a small residual error starved the decoder |
| [Mixed engines with old hls.js](rejected-old-hls/summary.json) | Rejected: Chromium's time mapping moved and repairs interrupted playback |
| [Publisher clock, mixed engines, 90 seconds](mixed-source-clock-90s/summary.json) | Passed source-timeline consistency, shared deadline, continuity, and three recoveries under two seconds |
| [Final mixed engines, 600 seconds](mixed-final-600s/summary.json) | Passed: 30 ms native/native p95, 14 ms native/Chromium p95; all three recoveries 1.57 s after fault end |

The final ten-minute run kept median delays at 1.997 / 1.968 seconds for the
native players and 2.006 seconds for Chromium. All measured clocks were precise;
there were no unexpected mutes, stalls, backward movement, audible seeks, speed
changes, or new attachments outside the explicit fault windows. Each 1.2-second
freeze recovered in 1.567–1.569 seconds **after the freeze ended**, about 2.77
seconds from fault onset. The affected listener was muted for about one second
while aligning. The healthy listeners were never interrupted. Across 120
playlist checks, timestamp progression matched media duration exactly.
[All three pairings](mixed-final-600s/all-pairs.json) were also calculated from
the retained raw samples with the same nearest-source-time pairing rule: p95
spread was 30 / 14 / 44 ms, and the worst observed spread was 65 ms. The third
pairing assertion was added to the harness after this run; this supplementary
analysis checks the same recorded data, without rerunning or replacing it.

The 90-second publisher-clock run measured 26 ms p95 native-to-Chromium spread.
Its playlist timestamp increments matched the intervening media duration exactly.
The reader checks this invariant independently: stable reported player clocks
alone cannot prove that the source maps the same audio to the same time.

The [older 11.34-second recovery](../sync-20260916/native-fault-90s/summary.json)
was rejected by the owner. Its old gate excluded a 20-second interval; it cannot
pass the current two-second recovery requirement.

Raw `native.jsonl.gz`, optional `chromium.jsonl.gz`, and `playlists.json.gz` retain
all observations, including startup and fault intervals. Each `listener.html.gz`
was extracted from that run's Go binary and checked against its recorded SHA-256.
Historical failed runs keep their original summaries and source fingerprints.
The implementation and reproduction commands are in
[synchronization.md](../../synchronization.md).

[Go/npm checks](checks.log) passed. The final [Chromium recovery check](chromium-recovery.log)
proved nonzero decoded audio, delayed joins, recovery from injected drift, and
recovery 1.367 seconds after a 2.5-second media-response hold ended. The latter
caused a real rebuffer; repair retained the HLS attachment and performed no
audible seek. The healthy peer continued without a wait or seek.
