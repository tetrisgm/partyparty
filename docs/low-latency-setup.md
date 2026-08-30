# Production playback contract

PartyParty serves HTTPS LL-HLS from the Mac in direct and local modes and from
the relay origin in relay mode. A broker-managed hostname and publicly trusted
certificate let an iPhone join without installing a profile or accepting a
certificate warning.

The production stream has one fixed profile:

| Setting | Value |
|---|---:|
| Codec | AAC-LC |
| Bitrate | 320 kbps stereo |
| Segment duration | 500 ms |
| Part duration | 150 ms |
| Retained segments | 48 |
| `PART-HOLD-BACK` floor | 0.9 seconds |
| Room target | 3 seconds |

Apple devices use native `<audio>`/AVPlayer. It is the supported iPhone engine
because it plays smoothly and survives Safari backgrounding and screen lock.
hls.js remains the non-Apple fallback; hls.js/ManagedMediaSource is not a
production iPhone path.

`internal/schedule` owns the room-wide target. The multivariant playlist carries
`EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES`, while media playlists retain a
modest 0.9-second part hold-back. Direct, local, and relay publish the same
three-second target. It is fixed: listener health, network quality, mode, and
room size never adapt it.

Healthy native playback is passive. PartyParty does not seek or rate-steer it.
Program Date Time and the Mac/phone clock estimate are telemetry. If a visible
phone remains at least 750 ms beyond the room target for three measurements,
the page gives that phone a fresh native HLS attachment. Corrections remain
available for the whole set; the cooldown is only the mechanical time needed to
reattach and re-measure, and expands temporarily only while corrections fail.
Nothing corrects playback while Safari is hidden or the phone is locked, and
missing timing telemetry alone never interrupts audio.

`/api/status.latencyTarget`, peer state, listener telemetry, the session-log
analyzer, and the streaming end-to-end test all consume the same
`schedule.Delay` value. Any change to the room delay, attachment pin,
part hold-back, segment duration, or part duration requires the real-AVPlayer
pre-upload soak and supervised physical test described in `AGENTS.md`. Unit,
contract, WebKit, and proxy tests are necessary but cannot prove audible native
playback.

The venue supplies Wi-Fi. PartyParty does not create a hotspot, captive portal,
or DNS hijack. Direct and local guests fetch from the Mac; relay guests fetch
the same timeline from `cmd/pporigin`, after the Mac contributes each live item
once. Relay media has priority, photos use a capped secondary path, and videos
are unavailable while relayed.

The only transport exception is the deliberately degraded offline emergency
link. It is exposed on the exact current LAN IP only when there is no internet
relay and the local resolver is proven unable to resolve the secure hostname.
It does not promise native locked-screen playback and is not a substitute for
the normal HTTPS contract.

An unresolved field measurement is recorded in `docs/HANDOFF.md`: on
2026-08-11 a real AVPlayer measured the direct path near 1.17 seconds and the
relay path near 3.33 seconds despite the declared three-second target. The bench
playlist proxy produced roughly three seconds regardless of the manifest and
cannot validate attachment position. Do not change geometry to chase those
numbers without the required supervised set.
