# partyparty

partyparty is a macOS menu-bar app that broadcasts a DJ set to phones on the
same venue Wi-Fi. Guests scan the in-app QR code, open the HTTPS player, and
keep listening when Safari is backgrounded or the phone is locked.

## Product contract

- Live audio, photos, videos, comments, reactions, and requests stay on the Mac.
- Guests need no account and no internet.
- The guest link is HTTPS and the stream is LL-HLS. There is no HTTP fallback.
- iPhones use native HLS/AVPlayer. This is the only supported Apple playback
  engine because it is smooth and survives screen lock.
- The venue provides Wi-Fi. partyparty does not create a hotspot, captive portal,
  or Internet Sharing configuration.
- The public Worker provides anonymous LAN hostname and certificate coordination
  plus the product website. It does not
  host event pages or relay party content.

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
```

`scripts/build-app.sh` creates the sandboxed Mac App Store app. See
`docs/DISTRIBUTION.md`.
