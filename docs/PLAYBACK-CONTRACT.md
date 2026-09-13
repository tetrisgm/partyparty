# Playback contract

- Production: 500 ms segments, 150 ms parts, 48-segment window. Bounded capture buffering and nonblocking ffmpeg tees prevent backpressure; audio-core changes require supervised go-live testing.
- Fixed room target: `schedule.Delay = 3s`. MULTIVARIANT playlist: `EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES`; `PART-HOLD-BACK=0.9`. Never adaptive/per-phone. Do not use hold-back 2.9 or MEDIA-playlist EXT-X-START without PRECISE; both failed on real AVPlayer.
- Before uploading any playlist-geometry/positioning change, pass `scripts/soak-playback.sh`: ten minutes of real muted AVPlayer proving attachment, progression, declared target, and no backward movement. Use `scripts/bench-playlist-proxy.py` for unshipped candidate manifests. Keep the log. Unit/contract tests and post-upload soaks do not replace this check.
- Healthy playback is passive: no seeks or rate steering. A visible phone ≥750 ms behind target for three measurements gets a fresh HLS attachment. Corrections remain available throughout the session; spacing is the mechanical minimum to attach/measure, briefly increased only if corrections do not stick. No per-session cap.
- Missing timing telemetry alone never interrupts audio. No corrections while Safari is hidden or the phone locked. Backward playback is unacceptable.
