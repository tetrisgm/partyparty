# PartyParty

PartyParty is a macOS menu-bar app that broadcasts a DJ set to phones on the
same venue Wi-Fi. Guests scan the in-app QR code, open the HTTPS player, and
keep listening when Safari is backgrounded or the phone is locked.

## Product contract

- Live audio, photos, videos, comments, reactions, and requests originate on
  the Mac and are never stored as a cloud party or replay. Photos and videos
  remain available in direct mode.
- Guests need no account. Normal Wi-Fi and offline travel-router parties use
  the direct mode and need no internet.
- The normal guest link is HTTPS and the stream is LL-HLS. A narrowly gated
  HTTP emergency link exists only when there is no internet relay and the local
  resolver is proven unable to resolve the secure hostname; locked-screen
  playback is not promised on that degraded path.
- iPhones use native HLS/AVPlayer. This is the only supported Apple playback
  engine because it is smooth and survives screen lock.
- The venue provides Wi-Fi. PartyParty does not create a hotspot, captive portal,
  or Internet Sharing configuration.
- The Mac selects one room-wide connection mode. Wi-Fi only is the default, so
  direct mode keeps traffic at the venue. If the DJ enables Wi-Fi + cloud and a
  phone proves that the Wi-Fi isolates nearby devices, relay mode contributes
  one copy of the stream to the relay origin for fan-out. HLS traffic has strict
  priority. Guest photos use a capped, throttled secondary path, and videos are
  disabled in relay mode. The relay does not create public event pages or retain
  party content.

## Run from source

Requirements: macOS 26+, Apple Silicon, Go 1.26+, Xcode command-line tools, and
MediaMTX for source builds. Release bundles include FFmpeg, MediaMTX, and the
capture helper.

```sh
make run
```

Open `http://localhost:8000/dj`, choose a capture source, and press
Go Live. Guests use the HTTPS QR shown in the console.

The production stream profile is fixed at 320 kbps stereo AAC-LC, 500 ms LL-HLS
segments, 150 ms parts, and 48 retained segments. Do not add alternate playback
engines or "safe" stream presets without new physical field evidence.

## Permissions

The App Store build requests only what the selected workflow needs:

- Local Network, to serve guests on venue Wi-Fi.
- System Audio Recording, when capturing the Mac's output.
- Microphone, when capturing a microphone, controller, or line input.
- Login Item, only if the DJ explicitly enables launch at login.

It does not request an administrator password, install privileged helpers, alter
network settings, or require Screen Recording.

## Build and verify

```sh
go build ./...
go vet ./...
go test ./...
cd app && swift build
cd cloudflare && node test/smoke.mjs
scripts/build-app.sh
scripts/build-standalone.sh
```

`scripts/build-app.sh` creates the sandboxed Mac App Store app.
`scripts/build-standalone.sh` creates the separate Developer ID beta. See
`docs/DISTRIBUTION.md`.
