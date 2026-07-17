# Findings not fixed in this review

## Cloud live-audio relay is enabled by default

The current product still creates and serves a cloud HLS mirror, which conflicts
with the repository's explicit invariant that live audio stays on the Mac and the
cloud hosts completed MP3 replays only.

Failure scenario: with `PARTYPARTY_CLOUD_MIRROR` unset, `internal/config/config.go`
defaults `CloudMirror` on. `main.go` adds the mirror tee/uploader, the Worker accepts
`/api/broker/live-segment` and `/api/broker/live-playlist`, and an off-LAN visitor
to a live handle is sent to an event page whose `<audio>` source is the R2 mirror.
Live party audio therefore leaves the LAN under the default configuration.

This review did not change that path because a correct removal spans Go runtime
configuration, the autonomous-work-prohibited `internal/broadcast/` audio core,
the uploader, Worker routes/rendering, and their tests. It needs the supervised
go-live qualification required by `AGENTS.md`; disabling only the web player would
leave the Mac uploading live audio unnecessarily.
