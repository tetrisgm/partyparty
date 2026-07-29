# Production playback architecture

partyparty serves HTTPS LL-HLS from the Mac. A broker-managed hostname resolves
to the Mac's private venue-Wi-Fi address and uses a publicly trusted certificate,
so default iPhones can connect without installing a profile or accepting a
certificate warning.

The production stream is one fixed profile:

| Setting | Value |
|---|---:|
| Codec | AAC-LC |
| Bitrate | 320 kbps stereo |
| Segment duration | 500 ms |
| Part duration | 150 ms |
| Retained segments | 48 |
| Room target | 1 second |

Apple devices always use native `<audio>`/AVPlayer. Native playback is required
for smooth audio and lock-screen/background continuity. The same-origin playlist
proxy passes MediaMTX's LL-HLS playlists through unchanged, so it adds no
server-authored start delay or hold-back inflation.

Healthy native playback is passive. partyparty never seeks or rate-steers
AVPlayer. Program Date Time plus a small Mac/phone clock-offset estimate measures
the phone's media position but does not control playback. A visible phone that
remains at least 750 ms beyond the one-second target for three consecutive
measurements receives one fresh native HLS attachment. Recovery has a 30-second
cooldown and a two-attempt ceiling per stream generation. Missing timing
telemetry alone never interrupts audio. No recovery runs while the page is
hidden or the phone is locked.

Non-Apple browsers use hls.js with one stable configuration. There are no
aggressive/proven, precise/balanced, stable, mono, quality, room-delay, or drift
settings in the product.

`/api/status.latencyTarget`, listener telemetry, the session-log analyzer, and
the streaming E2E all use the same one-second contract. Session acceptance fails
when an individual open reaches two seconds, or when a simultaneous startup
cohort or comparable steady-state health window reaches one second of
phone-to-phone spread.

The venue provides Wi-Fi. partyparty does not configure a hotspot, Internet
Sharing, DNS hijacking, or a captive portal. The Mac selects direct mode when
the HTTPS LAN path works and relay mode when a phone proves that client
isolation blocks it. Both modes expose the same MediaMTX playlist and audio
bytes to the same native player. Relay mode gives `/live/` responses priority
and places capped, throttled guest photos on the secondary queue. Videos are
disabled while relayed. Relay mode can increase DJ-to-listener delay because it
adds an internet path, but it does not create a second timeline or mix direct
and relayed listeners. The phone-to-phone spread target remains below one
second.
