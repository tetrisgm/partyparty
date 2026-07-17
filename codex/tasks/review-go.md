# Deep review + fix: the Go server (live-party + sync paths)

Review for REAL bugs, then fix. Read AGENTS.md first — SACRED rules bind you,
especially #5: internal/broadcast/ is OFF-LIMITS (read it for context, change
nothing in it). Do NOT ship, deploy, or release. Commit on the current branch
only; it gets pushed for owner review.

## Context — what changed recently (highest-risk surfaces)
- main.go liveCheckinLoop: 30s heartbeat POST /api/broker/live while
  broadcasting; now PARSES the response ({webListeners, webPosts}) and injects
  web posts into the room feed via events.AddWebPost + handler.SetWebListeners.
  Sends guest_port. Posts /api/broker/offline on the live→idle edge and quit.
- internal/event AddWebPost: dedupe by CID "web:<id>" (journal-persisted),
  NoPublish so the sync never echoes web posts back to the cloud.
- internal/sync + internal/server/sync_drain.go: the post/media mirror drain
  now ALSO runs while state=="live" (was idle-only); guest post/comment
  handlers kick it (triggerSyncDrain) for near-realtime sharing. A mid-run
  watchdog cancels during starting/stopping transitions.
- internal/server: urls() gained Public (the permanent link
  https://<handle>.partyparty.party/ when handle is plain + not captive);
  network_situation.go carries PublicURL; webListeners atomic + /api/status
  field; a PNA/OPTIONS preflight handler (Access-Control-Allow-Private-Network)
  at the top of ServeHTTP.
- internal/livemirror: R2 uploader (segment-before-playlist ordering).
- Domain flip: brokerBase()/activate defaults moved to partyparty.party.

## What to hunt (priority order)
1. Races/deadlocks: AddWebPost vs concurrent feed writes (store lock
   discipline), SetWebListeners lifecycle (stale non-zero after stop paths
   other than the clean edge — e.g. app quit vs postLiveOffline), sync-drain
   single-flight vs the new kicks, the check-in loop's response parsing on
   malformed/huge bodies.
2. The drain-while-live change: can a long media upload now degrade a live
   set (bandwidth/CPU), or upload a HALF-WRITTEN media file that a guest is
   still uploading to the Mac? Check what PendingBacklog considers "pending"
   vs in-flight guest uploads.
3. Offline sanctity (SACRED #1): every new code path must be a no-op offline —
   no new network call may block or delay guest join/listen/post or go-live.
4. Error handling: silent failures that should log, logs that would spam
   (the check-in runs every 30s forever).
5. Stale domain references anywhere in Go, docs strings, or web/*.html.
   web/listener.html has a known landmine: OUTER/INNER JS scope split — outer
   functions must not touch inner vars. If you touch listener/dj HTML, be
   surgical and syntax-check.

## Rules of engagement
- Every fix gets a test where the package has tests (internal/event,
  internal/server, internal/sync have suites).
- `go build ./... && go vet ./... && gofmt -l .` (must print nothing)
  `&& go test ./...` all pass.
- No refactors for taste; bug fixes only. Commit per finding; messages explain
  the failure scenario. End with FINDINGS.md for anything found-but-not-fixed.
