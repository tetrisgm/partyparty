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

Apple devices always use native `<audio>`/AVPlayer. Native playback is required
for smooth audio and lock-screen/background continuity. It attaches at the live
edge, and a forward-only governor may correct material drift while the page is
visible. No correction runs while the page is hidden or the phone is locked.

Non-Apple browsers use hls.js with one stable configuration. There are no
aggressive/proven, precise/balanced, stable, mono, quality, room-delay, or drift
settings in the product.

The venue provides Wi-Fi. partyparty does not configure a hotspot, Internet
Sharing, DNS hijacking, or a captive portal. If the HTTPS LAN path is not
reachable, the console reports that honestly and guests cannot join until the
network path is fixed.
