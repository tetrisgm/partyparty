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
- Healthy native playback is passive: PartyParty never seeks or rate-steers it.
  A visible phone that remains at least 750 ms beyond the one-second room
  target for three measurements gets one bounded fresh HLS attachment. Missing
  timing telemetry alone never interrupts audio. Nothing runs while Safari is
  hidden or the phone is locked.
- Venue Wi-Fi is the supported network topology. macOS Internet Sharing,
  personal hotspots, captive portals, and DNS hijacking remain retired.
- The Mac chooses one connection mode for the whole room. A public bootstrap
  probes the real phone-to-Mac HTTPS path. A successful probe uses direct mode;
  a failed probe uses the ephemeral reverse relay so client-isolated venue
  networks still work. The audio encoding and native HLS playback path do not
  change between modes.
- Relay mode gives `/live/` traffic priority. Guest photos use a capped,
  throttled secondary path, while videos do not enter the relay. Direct mode
  retains the full local media experience. This is an intentional music-first
  boundary.
