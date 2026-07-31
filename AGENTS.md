# PartyParty.party agent contract

PartyParty is a macOS menu-bar app that turns a DJ's Mac into a live party
server. Guests scan a secure QR code and use HTTPS LL-HLS plus the active-room
feed.

Load the shared `workshop-delivery` skill. Use:

```sh
workshop rules audit partyparty
workshop delivery audit partyparty
```

`.workshop.json` owns portable Go and Worker checks. The registered standalone
controller and explicit Apple lane are the only delivery paths.

## Architecture

The Mac chooses one room-wide mode from guest reachability and internet
reachability: direct, local, relay, or no path. In relay mode the Mac pushes one
copy of its LL-HLS stream to `cmd/pporigin`, which fans out the original
playlists. The Cloudflare Worker handles bootstrap and anonymous LAN
certificate coordination but never carries media. See
`docs/relay-architecture.md`.

## Product Invariants

1. Guests join, listen, and post on the LAN without accounts or internet.
2. The paid App Store download is the purchase boundary. Do not add product
   login, licensing, profiles, or network checks before Go Live.
3. Guest playback is HTTPS LL-HLS only. Do not restore plain HTTP.
4. Cloud relay state is ephemeral. Do not add public party pages, replays,
   recordings, archives, or cloud feeds.
5. Do not modify `internal/broadcast/` autonomously. It owns ffmpeg, tee, and
   MediaMTX behavior.
6. Do not add an authentication email service.
7. Do not restore hotspots, Internet Sharing, captive portals, DNS hijacking,
   or automatic network reconfiguration.
8. Apple guests use native HLS/AVPlayer for background and lock-screen audio.
9. Room delay never tracks listener count; correction is per device.
10. Store and standalone builds are isolated. Store builds are sandboxed and
    Apple-updated; standalone builds use a separate bundle ID and Sparkle.

## Verify

- Go: `go build ./...`, `go vet ./...`, `gofmt -l .`, and `go test ./...`.
- Worker: `cd cloudflare && node test/smoke.mjs`.
- Swift: `cd app && swift build`.
- Run the checks relevant to the touched files. `gofmt -l .` must be empty.

## Apple

- Build Store packages only on an Apple-released macOS host.
- `scripts/package-app-store.sh` owns archive, export, and package verification.
- Use `workshop apple doctor|status|builds|review|validate|upload` for App Store
  Connect. Upload never implies review submission.
- Before changing code after an Apple rejection, inspect the exact review
  message and classify whether it concerns binary, metadata, review notes, or
  account state.
- Never mix Sparkle, Developer ID entitlements, or standalone update metadata
  into the Store target.

Current product work is listed in `PLAN.md`. Historical investigations are
available in Git history, not binding handoff files.
