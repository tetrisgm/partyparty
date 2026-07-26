# Current field findings

- Native HLS/AVPlayer is the proven iPhone engine. It is smooth, low latency, and
  continues while the phone is locked.
- hls.js/ManagedMediaSource on iPhone caused repeated audible seek skips and is
  not a production option.
- The stable production geometry is 500 ms segments, 150 ms parts, and a
  48-segment window.
- Capture backpressure was eliminated by bounded capture buffering and
  non-blocking FFmpeg tee outputs. The audio core must not be changed without a
  supervised go-live test.
- Healthy native playback is passive: partyparty never seeks or rate-steers it.
  A visible phone that remains at least 750 ms beyond the one-second room
  target for three measurements gets one bounded fresh HLS attachment. Missing
  timing telemetry alone never interrupts audio. Nothing runs while Safari is
  hidden or the phone is locked.
- Venue Wi-Fi is the only supported network topology. macOS Internet Sharing,
  personal hotspots, captive portals, and cloud live relays are retired.
