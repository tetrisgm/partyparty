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

A forward-only governor may correct sustained latency above the one-second target
while the page is visible. It only seeks into already buffered media and
never seeks backward. No correction runs while the page is hidden or the phone
is locked; native AVPlayer continues uninterrupted there.

Non-Apple browsers use hls.js with one stable configuration. There are no
aggressive/proven, precise/balanced, stable, mono, quality, room-delay, or drift
settings in the product.

`/api/status.latencyTarget`, listener telemetry, the session-log analyzer, and
the streaming E2E all use the same one-second contract. Session acceptance fails
when an individual open reaches two seconds, or when a simultaneous startup
cohort or comparable steady-state health window reaches one second of
phone-to-phone spread.

The venue provides Wi-Fi. partyparty does not configure a hotspot, Internet
Sharing, DNS hijacking, or a captive portal. If the HTTPS LAN path is not
reachable, the console reports that honestly and guests cannot join until the
network path is fixed.
