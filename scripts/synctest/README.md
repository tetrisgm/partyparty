# Physical device-to-device sync test

Browser telemetry (the `lat`/`spread` numbers in the session log) measures the
**media clock**, which cannot see the speaker/DAC/Bluetooth output path — a
Bluetooth speaker alone adds 150–300ms invisibly. The only ground truth for
"are the phones actually in sync in the room" is a microphone. This kit plays a
click track through partyparty, records the room with one mic, and reports the
device-to-device spread in milliseconds.

## Run it

```bash
# 1. Make the click track (60s: 1kHz impulse every 2s, triple-burst marker /10s)
scripts/synctest/make-clicktrack.sh

# 2. Go Live in partyparty, then play scripts/synctest/clicktrack.wav on the DJ Mac
#    through the output partyparty captures (Mac output source). Join every test
#    device on its BUILT-IN SPEAKER at matched volume, ~equidistant from one mic.

# 3. Record the room (default 45s from the built-in mic; list devices with
#    `assets/ffmpeg -f avfoundation -list_devices true -i ""`)
scripts/synctest/record-room.sh 45 1

# 4. Measure
python3 scripts/synctest/measure-sync.py
```

Output is a per-click spread plus a verdict:

```
=== device-to-device spread: median 180 ms | p95 240 ms | max 310 ms ===
=== VERDICT: GREAT (<250ms) ===
```

## Reading it

- **`<250ms` GREAT / `<500ms` OK / `>500ms` TOO WIDE** — the product bar.
- **"LATE OUTLIER"** on a click = one device landed a separate cohort far from
  the rest (the failure the field logs showed on the iOS 27 phone).
- Keep every device on **built-in speaker**. A phone on AirPods next to a phone
  on speaker will read ~200ms apart with perfect media-clock sync — that gap is
  the Bluetooth output path, which no sync scheme can remove.

## Why it matters here

The `stream-e2e.mjs` harness can measure media-clock spread on the hls.js
(Chromium) path only — it has no native-HLS engine, so it cannot validate the
iOS/Safari path at all. This mic test is how the **native** path (the one that
regressed in the field) gets validated. See `docs/sync-redesign.md`.
