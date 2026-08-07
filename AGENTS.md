# PartyParty.party agent contract

PartyParty is a macOS menu-bar app that turns a DJ's Mac into a live party
server. Guests scan a secure QR code and use HTTPS LL-HLS plus the active-room
feed.

## Architecture

The Mac chooses one room-wide mode from guest reachability and internet
reachability: direct, local, relay, or no path. In relay mode the Mac pushes one
copy of its LL-HLS stream to `cmd/pporigin`, which fans out the original
playlists. The Cloudflare Worker handles bootstrap and anonymous LAN
certificate coordination but never carries media. See
`docs/relay-architecture.md`.

## Audio and playback

Native HLS/AVPlayer is the proven iPhone engine: smooth, low latency, and it
continues while the phone is locked. hls.js/ManagedMediaSource on iPhone caused
repeated audible seek skips and is not a production option.

The stable production geometry is 500 ms segments, 150 ms parts, and a
48-segment window. Capture backpressure is held off by bounded capture buffering
and non-blocking ffmpeg tee outputs; the audio core must not change without a
supervised go-live test.

The room target is a FIXED three seconds (schedule.Delay), delivered as
EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES in the MULTIVARIANT playlist with
PART-HOLD-BACK at the modest 0.9 floor - the exact form the July D=3 era ran
live (commit affebd3), re-proven on the soak harness at 3.11s flat before
upload. Stability over immediacy (owner decision, 2026-08-05): the cushion is
sized so ordinary Wi-Fi stalls pass silently instead of reaching ears. The
two failed forms are never-again: PART-HOLD-BACK stretched to 2.9 (points
outside the parts region; AVPlayer snapped a listener to the window's oldest
edge), and EXT-X-START in the MEDIA playlist without PRECISE (measured 25.00s
from the edge - the offset applied from the wrong end). The target is one
declared number for every phone on every path - never adaptive, never
per-phone, never tracking listener conditions.

Any change to playlist geometry or playback positioning (hold-back,
EXT-X-START, the room delay, segment/part shape) requires a real-AVPlayer
soak that PASSES BEFORE THE BUILD IS UPLOADED anywhere:
`scripts/soak-playback.sh` attaches a muted headless AVPlayer to the live
stream for ten minutes and PASSES ONLY IF it proves it attached, advanced,
sat at the declared target, and never moved backward - the first version of
that harness reported PASS for a run where the player never connected, which
is the same theater in a smaller box. To soak a candidate manifest without
shipping it, serve it through `scripts/bench-playlist-proxy.py` and soak
that. Keep the log as the receipt. A soak run after upload is theater. Unit and contract tests
cannot hear AVPlayer: two green-tested geometry builds failed on real phones
within minutes on 2026-08-05. Playback moving backward is never acceptable.

Healthy native playback is passive — PartyParty never seeks or rate-steers it.
Unbounded drift is still not tolerated: a visible phone that stays at least
750 ms beyond the room target for three measurements gets a fresh HLS
attachment, and corrections stay available for the whole set — spacing between
them is only the mechanical minimum for an attachment to land and re-measure,
stretching briefly only while corrections fail to stick. Never a per-session
cap: one shipped once and left a phone 16.7 s behind at a live test
(2026-08-04). Missing timing telemetry alone never interrupts audio, and
nothing runs while Safari is hidden or the phone is locked.

Relay mode gives `/live/` traffic priority: guest photos take a capped,
throttled secondary path and videos do not enter the relay at all. Direct mode
keeps the full local media experience. This is an intentional music-first
boundary.

## Look

There is no design document, and the one that existed was deleted on
2026-08-07: it described an aspiration nobody built, and following it produced
pages that did not match the product. `web/listener.html` is the reference -
Geist, `#ff2d55`, a warm grey canvas with white cards and soft depth, pill
buttons at weight 800. Read the CSS that ships, copy the values, and if the
look should change, change it there first.

## Product Invariants

1. Guests join, listen, and post on the LAN without accounts or internet.
2. Accounts belong to DJs, never to guests at a party. A DJ signs in to run a
   group; a member may sign in if they want one identity across groups, but
   every member action also works from a link in an email. Go Live is never
   gated on sign-in, a purchase, or a network check.
3. Guest playback is HTTPS LL-HLS. The single exception is the OFFLINE
   EMERGENCY LINK, which is intended and supported: when a party has no
   internet and this Wi-Fi's resolver will not answer for the secure hostname,
   there is no way to obtain or validate a certificate, so the QR offers a
   plain-HTTP link to the Mac's LAN IP. It is narrowly gated in
   `Srv.AllowHTTPFallback`: the request must be non-TLS, the Host must equal the
   CURRENT LAN IP exactly, DNS must not be published, the internet must be
   unreachable, and the room mode must be NO PATH for reason resolver_bad. Every
   other plaintext request still redirects to HTTPS, and a stale IP never
   becomes a second way into the room. Do not widen these conditions, and do not
   restore plain HTTP for any online path.
4. Groups and events are durable public pages and their timelines persist -
   that is the platform. The MUSIC of a night is not: no replays, no
   recordings, no set archives, and relay state stays ephemeral. Photos and
   posts belong to the group that collected them and are never made public or
   mailed out except by the DJ's own act.
5. The cloud is a FALLBACK, never a broadcast. Relay exists so guests can reach
   the party in front of them when the venue's own network cannot carry it - AP
   isolation, a resolver that will not answer, a hostile guest network. A club
   does not want its night streamed to the world. Relay is infrastructure: it
   is never advertised, never sold, and "listen from anywhere" is not a product
   we offer.
6. The money is the DJ's and we never hold it. Tips and tickets route through
   the DJ's OWN PayPal or Stripe account - Ko-fi's structure - so PartyParty is
   never the merchant of record and never escrows, holds, schedules or pays out
   anyone's money. Refunds and disputes belong to the DJ. Do not build a
   balance, a payout, or a platform wallet.
7. Do not modify `internal/broadcast/` autonomously. It owns ffmpeg, tee, and
   MediaMTX behavior. The streaming path as a whole - capture,
   `internal/schedule`, and the player in `web/listener.html` - is FINISHED
   WORK (owner, 2026-08-06): platform and product work is built around it,
   never through it. Guest-page features may be added beside the player; the
   player's own code path is not where they land.
8. Email is MXroute SMTP. A member's address belongs to the group that
   collected it, is exportable by that group, and is never mailed for our own
   purposes. Every send carries a one-click unsubscribe honored platform-wide.
9. Do not restore hotspots, Internet Sharing, captive portals, DNS hijacking,
   or automatic network reconfiguration.
10. Apple guests use native HLS/AVPlayer for background and lock-screen audio.
11. Room delay never tracks listener count; correction is per device.
12. Store and standalone builds are isolated. Store builds are sandboxed and
    Apple-updated; standalone builds use a separate bundle ID and Sparkle.
13. A party is one night, not one calendar day: storage is `parties/<id>/`,
    resumed while it is current and started fresh once it has gone idle. The
    folder is a keepsake, not a database - guest uploads and one index.html of
    the wall, with the journal hidden in `.state`. The app does not record the
    music: the set-recording tee was removed 2026-08-06 at the owner's request
    and must not come back without one.
14. One party per Wi-Fi: a Mac going live where a DJ is already playing JOINS
    that party - same id, same wall, same link handed to guests - rather than
    starting a rival that splits the room. A party with posts on it is never
    abandoned to join another.

## Apple

- Uploading to TestFlight or App Store Connect happens ONLY when the owner asks
  for it. Never as a debugging probe, never because a fix looks ready. Six
  builds went up in five days that nobody requested; each one is permanent in
  App Store Connect, spends beta-review capacity, and notifies real testers.
  `APP_STORE_UPLOAD=1` and the manual workflow dispatch are the decision point,
  not a formality.
- No launchd job, cron, or watcher builds, publishes, deploys, or reinstalls
  this project on its own. Automation that fires on a commit turns ordinary
  development into unrequested releases. Releasing is a decision, not a trigger.
- TestFlight is how the app reaches people, BY INVITATION (owner, 2026-08-07).
  There is no public download: partyparty.party collects addresses to invite
  from later (`/api/waitlist`, read back with the admin key) and offers no file.
  The Mac App Store is the other active lane. The standalone Sparkle channel is
  DORMANT, not retired - `scripts/ship-standalone.sh`, the appcast and the
  versioned R2 downloads stay intact and served, because a Mac already carrying
  a standalone build would otherwise be stranded on its current version with no
  sign that anything was wrong. Do not delete them, and do not run them without
  being asked.
- Pro is a SUBSCRIPTION. There is no lifetime unlock and no non-consumable: an
  unlock that zeroes our cut forever is bought by exactly the DJs selling the
  most tickets. The non-consumable `fm.partyparty.app.pro.lifetime` was deleted
  from App Store Connect on 2026-08-07 at the owner's request; do not recreate
  it, and do not add a one-off purchase in its place.
- `asc` (App Store Connect CLI, `brew install asc`) is the tool for every App
  Store and TestFlight operation: `asc review doctor` before anything, then
  `asc review status`, `asc versions`, `asc builds`, `asc testflight`. It reads
  ASC_KEY_ID, ASC_ISSUER_ID and ASC_PRIVATE_KEY_PATH. Do not hand-roll API
  clients; `asc review doctor` names blockers directly and is the first thing to
  run when a submission will not go through.
- What App Review asks for outranks everything else. Read the reviewer's
  feedback on the App Review page FIRST and fix exactly that. Packaging,
  tooling and CI work are downstream of it and must never be done instead of it.
- Never flood App Store Connect. Every submission is permanent and visible;
  two of the three submissions on this app's record were made by an API key
  without anyone asking. A submission is a deliberate act by the owner.
- Build Store packages only on an Apple-released macOS host.
- `scripts/package-app-store.sh` owns archive, export, and package verification.
- Before changing code after an Apple rejection, inspect the exact review
  message and classify whether it concerns binary, metadata, review notes, or
  account state.
- Never mix Sparkle, Developer ID entitlements, or standalone update metadata
  into the Store target.

- GitHub Actions is never used in this repo: no workflow files, secrets, or runners. Verification is merge-gate on the PC Linux lane (stack/runbooks/workflow.md); GitHub is a git host only.
