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
| Room target | 3 seconds |

Apple devices always use native `<audio>`/AVPlayer. Native playback is required
for smooth audio and lock-screen/background continuity. The same-origin playlist
proxy adds `EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES` to the multivariant
playlist and enforces `PART-HOLD-BACK >= 3 * PART-TARGET` on media playlists.
That gives every native player the same server-authored starting deadline without
a client startup seek.

A forward-only governor may correct sustained latency above the three-second
target while the page is visible. It only seeks into already buffered media and
never seeks backward. No correction runs while the page is hidden or the phone
is locked; native AVPlayer continues uninterrupted there.

Non-Apple browsers use hls.js with one stable configuration. There are no
aggressive/proven, precise/balanced, stable, mono, quality, room-delay, or drift
settings in the product.

`/api/status.latencyTarget`, listener telemetry, the session-log analyzer, and
the streaming E2E all use the same three-second contract. Session acceptance
fails when a simultaneous startup cohort or a comparable steady-state health
window exceeds one second of phone-to-phone spread.

The venue provides Wi-Fi. partyparty does not configure a hotspot, Internet
Sharing, DNS hijacking, or a captive portal. If the HTTPS LAN path is not
reachable, the console reports that honestly and guests cannot join until the
network path is fixed.
