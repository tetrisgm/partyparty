# PartyParty.party handoff

## THE SPLIT (2026-08-11): partyparty is the broadcast app again

**What the journal era taught THIS app (ported knowledge - the era's 75
commits touched no broadcast code, verified by path diff, but three findings
matter here):**

1. **CORRECTED 2026-08-11, later the same night: live recognition WORKS.**
   The dev-signed build (Mac Development profile, below) caught two real
   tracks off the Mac's own output during testing - "Come As You Are (Live)"
   by Post Malone and "Canada" by CoLD SToRAGE, the second with catalog
   artwork, which only Apple's Shazam catalog supplies - and `shazamd` was
   running. So SHSession catalog matching is fine with a real profile. What
   is broken is only `SHLibrary`, the READ of the user's own library, which
   returns empty; that is clubclub's problem, not this app's. Now Playing and
   the track list work here today. The paragraph that follows was written
   before that evidence and is kept because its facts about the entitlement
   are still true - they just do not stop recognition.

   **The entitlement facts, unchanged.** The
   journal era proved (2026-08-10): the App ID carries SHAZAM_KIT
   (`asc bundle-ids capabilities list --bundle YPMR3HYD9L`) but NO
   provisioning profile generated from it - fresh MAC_APP_DEVELOPMENT and
   MAC_APP_STORE both checked, byte-identical entitlement lists - carries a
   ShazamKit entitlement, and a binary claiming
   `com.apple.developer.shazamkit` is SIGKILLed at launch. So "recognition
   proven only in provisioned builds" understates it: the entitlement may
   not be obtainable at all until resolved with Apple. Now Playing during
   sets depends on this. Nobody has ever verified live recognition in the
   field.
2. **Ad-hoc desk builds never reach Shazam at all** - shazamd does not even
   launch, zero log lines. To test recognition on a desk build, sign it:
   `PP_SIGN_ID="Apple Development: Created via API (PNPRMWUDTD)"` plus
   `APP_STORE_PROVISIONING_PROFILE` pointing at the "PartyParty Mac Dev"
   profile (asc profile id 76G3BZ3ULT, expires 2027-08-10; re-download with
   `asc profiles download --id 76G3BZ3ULT`). The installed
   /Applications/PartyParty.app is built exactly this way now.
3. **The dialect seam.** This Build-269 app speaks the GROUP-flavored
   /api/v1 dialect; partyparty.party production runs the journal-era
   PERSON-flavored worker (see the deploy freeze below). cloudsync fails
   soft by design, so streaming is unaffected - but the cloud extras (wall
   sync, party bind, profile) may quietly no-op until clubclub migrates the
   journal off this domain. Known, accepted, resolves at migration.



Owner: two products were fighting for one codebase. PartyParty
(partyparty.party) is the Mac app that broadcasts a party to the room's
phones via QR - and ONLY that. The check-in journal (venues, nights, tracks,
people, inference) moved to its own product: **clubclub**
(clubclub.app, repo github.com/tetrisgm/clubclub, checkout ~/dev/clubclub) -
a full clone of this repo at the split point, history included.

This tree is main reverted to ed02579 ("Build 269") - the exact commit of
the TestFlight build - in one restorative commit. The 75 journal-era commits
remain in history here and live on in clubclub.

**DEPLOY FREEZE - cloudflare/app.** partyparty.party PRODUCTION still runs
the journal-era `partyparty-app` worker, and its D1 holds real data (21
nights, ~550 tracks). That deployment now belongs to the clubclub repo. From
THIS repo, `wrangler deploy` in `cloudflare/app` would destroy the live
journal - do not run it, ever. (The site broker in `cloudflare/` is
unaffected: it did not change during the journal era and stays deployable.)
The freeze lifts when clubclub.app stands up and the journal migrates off
this domain; unwinding partyparty.party's journal routes happens then, as
clubclub work.

Do not rebuild journal features here. If a task smells like check-in,
venues, Shazam, calendars or suggestions, it belongs in ~/dev/clubclub.

## Current position (2026-08-08): the web is a personal party record

The web half changed shape. It was a place to PUBLISH a night, reached from the
Mac. It is now first a place to KEEP one, and it is useful with nobody else on
PartyParty at all - none of it needs the other people to have accounts.

`/home` is your parties, upcoming and past. A party page carries your own record
of it: went or not, a private note, who played, who you saw, and a note about
each of them from THAT night. People are reused by name, so typing "Seth" twice
is one Seth; `/people` and `/people/<id>` are the list and one person's whole
history. Everything private is keyed by the owner's verified address, and a
party page shows a signed-out visitor none of it.

Three things worth knowing before changing any of it:

- **Upcoming / on tonight / past is read off the clock** (`partyPhase`), never
  a field somebody flips. Six hours is a night.
- **"Playing right now" is a heartbeat, not a flag.** The Mac's timeline sync
  already ran every 20s while live and stopped when it was not, so it now
  carries the guest link and stamps `events.live_ms`; the page offers Listen
  for 90s past the last one and then stops on its own. A flag would still be
  saying "listen now" the next morning. The web LISTENS and never transmits -
  there is a test that fails on the word.
- **One party, two clients.** The web edit form and the Mac's `/api/party/edit`
  are the same `updateParty` on the same row. Renaming in the booth now carries
  up to the platform in the background (`pushPartyEdit`): it used to change
  only the Mac's copy, so a party with a page ended the night under two names.

Migrations `0009_people.sql` (people, party_people, party_notes) and
`0010_party_details.sql` (events.links, live_url, live_ms), both applied to
production D1 on 2026-08-08. There is no scripted deploy for `cloudflare/app`,
so migrations do not ride along with one: `wrangler d1 migrations apply
partyparty-app --remote` has to run BEFORE `wrangler deploy` in that directory,
or the home page and every party page fail on their first query.

DEPLOYED 2026-08-08: partyparty-app version 5a5ff09d, partyparty-site version
235ea835, and TestFlight build 268 (125.47), which is IN_BETA_TESTING for the
internal group.

Two App Store Connect facts worth not rediscovering: `asc builds upload` wants
the NUMERIC app id (6794880742), not the bundle id, and refuses a build number
already on the record - 267 was up, so the package had to be rebuilt as 268.
And an internal group cannot be added to a build at all ("Cannot add internal
group to a build"): internal testers get every processed build automatically,
so a VALID build with autoNotifyEnabled is already delivered. Only external
groups need `add-groups`, and those need a beta review submission.

A TRAP THIS SESSION WALKED INTO, now guarded: two workers share the zone, and
which paths belong to the platform is declared in `cloudflare/app/wrangler.jsonc`
rather than in the code that serves them. `/people` and `/parties/new` were
served by the app worker with no route pointing at them - which works perfectly
on localhost and 404s on partyparty.party, because the request is answered by
partyparty-site instead. Nothing request-level can see it; the tests call the
worker directly. A test now reads the two files against each other, and the
development doors must have NO route.

## Current position (2026-08-06, end): every step of the plan has code

`docs/plan.md` is the single plan, written from the person throwing the party.
Every numbered step in it now exists behind tests in the merge gate: 30 platform
tests, 10 broker tests, the Go suites and the Playwright pages.

- **1. The join link follows the party** (574fca3). Presence per live member
  under `broker/party/<id>/<install>`; the join page probes them all. No new
  DNS - live Macs already publish their own machine records.
- **3 and 3b. The platform** (a0306aa, 4556365, 8249c79, dcdd3c0): groups,
  nights, two-level membership, Apple and Google sign-in, invitations, the
  day-of reminder, the group thread with per-member volume, and calendars.
- **4. One link** (c8344b3, 8cc4908, f41c1a3): a party binds itself to
  tonight's night, and the wall and the event page are one timeline.
- **5. Tips** (259ddb4, f3ac560): the DJ's own link, and Stripe behind it.
- **6. The door** (7d917e3): capacity, entry codes, a list that needs no signal.
- **7. Merch** (652aeff). **8. Pro** (fdc8bca).
- **ppmail** (c7084b3) drains the outbox through MXroute from the origin box.

WHAT IS NOT BUILT, and why:

- **Step 2, the field tests.** A real iPhone on a wildcard cert, and a venue
  whose Wi-Fi cannot carry the room. Needs a venue and real phones.
- **The App Store half of Pro.** StoreKit in the Mac app and an auto-renewable
  subscription in App Store Connect - there is now NO in-app purchase product
  on the app at all: the non-consumable one was deleted on 2026-08-07 (owner),
  because Pro is a subscription and a lifetime unlock is not coming back. The
  entitlement row the App Store will write, and the union that reads it, are
  done and tested.
- **Media on merged posts.** A web post carrying a photo is not put on the LAN
  wall: the file lives in the cloud and this Mac cannot serve it to a guest on
  the venue network. It is on the event page.

SIGN IN WITH APPLE IS CONFIGURED (2026-08-07). Services ID fm.partyparty.web
against primary App ID fm.partyparty.app, domain partyparty.party, return URL
/auth/apple/callback; key 9DLLL4UAR8, whose .p8 the owner holds and Apple will
not reissue. Two things were missing that would each have failed silently: the
App ID had no APPLE_ID_AUTH capability, so PartyParty was not even offered as a
primary app; and no email source was registered, which means mail to a member
who hides their address behind Apple's relay would have bounced with nothing to
see. partyparty.party is now a registered source, verified by SPF. The key was
proven by signing a real client secret through the Worker's own
appleClientSecret path - ES256, correct kid, iss, sub and aud.

A correction to an earlier assumption of mine: the
.well-known/apple-developer-domain-association.txt file is NOT required for
Sign in with Apple web auth. The route is harmless and stays for other Apple
flows, and the check script now reports its absence rather than failing.

NOTHING IS DEPLOYED. No D1 database exists, `database_id` is blank on purpose,
no secrets are set, ppmail has no unit, and no Stripe account is connected.
Bringing it up is the owner's call and needs, in order: `wrangler d1 create`,
the five migrations, a Sign in with Apple Services ID and key, a Google OAuth
web client, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, `OUTBOX_KEY`, and
a systemd unit for ppmail.

A LIVE BUG WAS FIXED ON THE WAY (8d4564d): every profile save in the DJ console
went through `button.click()`, and the click handler disabled the button for the
length of the fetch - so moving from the name field to the bio fired a save
carrying only the name, the bio's own save found the button disabled and was
DROPPED, and then the first save's reply overwrote the bio on screen. Type a
name, tab, type a bio, click away: gone, and never sent. Saves now serialize
through one queueing function, and hydration leaves alone any field whose value
has moved away from what the server last wrote. It surfaced as a "flaky" test on
the build runner; the runner was just slow enough to land in the window.

## Current position (2026-08-06): parties replace event folders; 125.47 (267)

The event model is gone. A PARTY is one night: `parties/<id>/`, resumed while
current, new after eight idle hours, empty ones reused so launching twice
leaves no litter. Its folder is a keepsake - guest uploads plus a static
`index.html` of the wall (posts, comments, media, setlist), with the journal,
guest names, thumbs and set reports hidden in `.state`. Old `events/<date>/`
folders migrate in with every byte kept. Set recording is REMOVED (owner:
the app should not keep a copy of the music); nothing had set RecordPath since
the LL-HLS rewrite, so it was dead capability, and a test now fails if an ADTS
tee leg reappears.

ONE PARTY PER WI-FI: peers advertise their party (id, name, cover, join link)
over the existing Bonjour + /api/peer probe, and a Mac going live adopts a live
peer's party instead of starting a rival - taking its id, folder, name and
cover, keeping its own DJ name and photo, and showing the HOST'S join link, so
the second DJ's QR is the first DJ's. A party with posts is never abandoned to
join another. The shared wall needed nothing: mergeRoomFeed already merged peer
posts and rewrote media URLs to the owning Mac.

Guests are no longer stranded when a Mac leaves: after ~20s of failed polls the
page re-homes to another member from the DJ reel it already holds.

Telemetry: every listener carries its own stall count and worst latency for the
set, shown in the console - "my phone or the stream?" is now answered by the
screen. Settings also shows the three permissions honestly (microphone has a
real API; system audio has none, so it offers Check, which attempts a tap; local
network has neither, so it offers only the pane).

NEW TEST GUARDS (both in `npm test`): `test-dj-console-saves.mjs` types into the
console and fails if a save never reaches the server;
`test-guest-page-taps.mjs` taps play, the sheets, the QR, a comment and a poll
outage on the guest page and fails on any console error. Both were verified
against the real bug before landing. Note for whoever writes the next one: the
stub's `appVersion` MUST match the served page or the page reloads itself
mid-test (its own stale-page refresh), which reads as a mystery timeout.

DELIBERATELY NOT DONE: the broker publishing an A record per live member so the
party link survives the host leaving. It rewrites production DNS for the live
domain, and getting it wrong points guests at the wrong Mac - it needs its own
pass with the Worker smoke test extended, not the tail of a long batch. Until
then a host who leaves keeps serving nobody new; guests already in are covered
by re-homing.


## Current position (2026-08-05, close): TestFlight 125.42 build 262

On top of the benched 3s buffer (below): 261 made the DJ profile stick
(auto-saves disarmed until hydration; /api/dj-profile is nil-means-keep) and
made track changes latch in ~15-20s via incumbent-veto matching. 262 adds
PARTY REACH in Settings - Wi-Fi only is the DEFAULT (owner decision: nothing
leaves the room until deliberately switched); Wi-Fi + cloud pushes the relay
whenever live+internet (relay.Manager Config.OnPush drives
contribute.SetEnabled; mode stays DIRECT for LAN guests), and an isolated
venue under Wi-Fi only reads NO PATH reason wifi_only instead of relaying
against the DJ's choice. The join bootstrap (Cloudflare Worker, DEPLOYED
ed831a0c) now health-checks the relay before handoff, shows an honest
"join the Wi-Fi" page, and re-probes every 8s + on online/visibility - a
phone that regains Wi-Fi converges alone. The QR is brand pink on both
renders with the DJ avatar badged center on the console (correction H).
Remote-listen test protocol: Settings -> Party reach -> Wi-Fi + cloud, go
live, open the join link on 5G.


## Current position (2026-08-05, end of night): 125.40 build 260 - the buffer, benched

The 3s cushion SHIPPED on the third attempt, done the way the contract now
demands. The July D=3 implementation was read as it actually shipped (commit
affebd3): EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES in the MULTIVARIANT
playlist, PART-HOLD-BACK at the honest 0.9 floor - both details load-bearing
(the same tag in the MEDIA playlist without PRECISE measures 25.00s from the
edge; AVPlayer applies the offset from the wrong end). Proven BEFORE upload
with the bench that is now the standard for any geometry change: a local
rewriting proxy (scratchpad/benchproxy.py) serves the candidate manifest
from the LIVE stream to a muted headless AVPlayer (scratchpad/soak.swift -
note the setvbuf: Swift print buffers into pipes, which hid the 258 verdict
once); ten minutes, 120 samples, 3.11s flat, zero backward movement; receipt
at build/soak-125.40-260.log. TestFlight: 260 is the only live build,
internal active, external submitted. Owner-side: update, one permission
prompt, and every phone should join at 3s and hold - venue blips inaudible.


## Current position (2026-08-05 night): TestFlight 125.39 build 259 - proven geometry restored

The evening's 3s-cushion attempt is REVERTED. Sequence: the owner decided
stability over immediacy (a fixed 3s room instead of the ~1s knife edge,
justified by the Shack15 A/B - a phone at ~2.6s heard none of the venue
bursts a ~1s phone heard). Implementation One (125.37, PART-HOLD-BACK=2.9)
was self-contradictory - parts only exist ~1.4s from the edge - and AVPlayer
audibly ROLLED A LISTENER BACKWARD, then parked it 24.8s deep. Implementation
Two (125.38, EXT-X-START:-3) left the owner's phone 27s behind; its exact
mechanism is UNDIAGNOSED (the muted-AVPlayer soak harness produced no output
before the phone found the bug - the harness itself needs a shakedown).
125.39 restores hold-back 0.9 / D=1.0 exactly as the successful afternoon
ran. Root failure, named in the reflection the owner demanded: geometry
changes shipped at app-fix tempo on green unit tests, which cannot hear
AVPlayer - the same lesson the sandbox/TCC/Shazam sagas taught earlier the
SAME DAY. AGENTS.md now requires a PASSING pre-upload soak (muted headless
AVPlayer, >=10 min, zero backward movement, stable at target, log kept) for
any playlist-geometry or positioning change; a soak after upload is theater.

The 3s decision STANDS as owner intent. Bench work owed: shake down
scratchpad/soak.swift (compile + attach never verified), read the JULY D=3
implementation as it actually shipped instead of paraphrasing it from
memory, find the mechanism AVPlayer respects for deep attachment, pass the
soak, then ONE build. Also parked: per-phone stall counters into /api/status
(proposed, owner receptive) - would have made tonight's phone-vs-stream
attribution instant.


## Current position (2026-08-05 evening): TestFlight 125.36 build 256

125.36 (256) is the only live build: recognition moved into the APP process
(the one ShazamKit-authenticatable identity - proven working live at Shack15
with real matches and artwork), match switching requires a 15s-apart repeat
so sound-alikes can't flap mid-song, plus the player polish round (waves
before chevron; sheet: no heading, no solo-DJ card, 128px cover row,
"N listening" pill by the play button). Shack15 re-test verdict: two 15-min
telemetry windows with ZERO stream gaps - the cutoff era is closed; the only
audible events were the permission-toggle rebuild and one phone-side Wi-Fi
rebuffer. Below, the 255-era record:

## Previous position: TestFlight 125.35 build 255

The sandboxed-capture saga is SOLVED, in three layers, each proven on this
Mac before shipping:

1. TOPOLOGY (the crash): an own-profile sandboxed child cannot be
   posix_spawn'd from a sandboxed parent — libsecinit SIGTRAPs before main()
   (crash reports land in ~/Library/Logs/DiagnosticReports and are whisked
   into Retired/ within a second). Builds 251-253 killed ppcapture this way
   on EVERY Go Live; the desk dev loop never showed it because its parent
   chain is unsandboxed. ppcapture is now app-sandbox + inherit exactly like
   the other helpers (verify-app-store.sh enforces it), keeps its own bundle
   id for LaunchServices hygiene, and its TCC identity is the app's.
2. PROMPT (the silence): a sandboxed process's tap NEVER raises the System
   Audio Recording prompt — fresh TCC state, tap runs with zero device
   cycles, no AUTHREQ ever reaches tccd, room goes "live" streaming filler
   silence. Go Live on Mac output now sends primeSystemAudio over the shell
   bridge first: the APP creates a momentary CATap in its own name (the shape
   macOS prompts for), the grant covers the helper via process
   responsibility, and a denied prime stops Go Live with the honest Settings
   path. Proven end to end on the sandboxed store-dev build: prompt appeared,
   Allow, guests' segment measured -5.8 dB mean (real music).
3. HONESTY (the gaslighting): capture-failure copy no longer tells the DJ to
   play music or flip permissions when the fault is ours.

125.35 (255) carries all of it; versions now MOVE for every build a Mac can
receive (the owner had 125.34-as-253-and-254 side by side and could not tell
them apart — never reuse a visible version across lanes again).

Shazam: 202 on dev builds is EXPECTED forever (no provisioning). 255 is the
first fair test of recognition under the inherit design; if it still 202s
there, the inherited profile isn't carrying the shazamd lookup for ShazamKit
and recognition needs its own home (likely the app process) — a designed
follow-up, not a hotfix.

Menu bar decoder: 🕺 ⚠ N = live but health "strain"/"congested" (real alarm,
not noise); 🕺 🔴 = capture dead. Xcode builds on the DJ Mac while
broadcasting CAUSE strain and audible cutoffs — never compile during a set.

Seth: leadman.seth.finkin@gmail.com (the bare seth.finkin record was deleted
from ASC on owner's order). Team member (Marketing), internal group, tester
state INSTALLED — but what he installed today was a broken-capture build;
he needs the 125.35 (255) update for anything to work.

## Workflow + build lane facts (2026-08-05)

- This repo now lands ONLY via worktree + branch + merge-gate
  (~/dev/stack/runbooks/workflow.md); a pre-commit hook blocks canonical-main
  commits. Standing worktree: ~/dev/partyparty--work (merge-gate --keep).
- GitHub Actions is dead fleet-wide (workflow file + all eight repo secrets
  deleted). The login keychain holds both distribution identities and is the
  ONLY signing home; the CI-era stash (custom partyparty-app-store keychain,
  p12s, raw key) was archived to NAS /volume3/backups/ci-era-signing-20260805/
  and deleted from this Mac (infra session, 2026-08-05). Never recreate it.
- Local TestFlight packaging: scripts/package-app-store.sh with
  APP_STORE_PROVISIONING_PROFILE (build/partyparty-mas.provisionprofile, or
  re-download: asc profiles view --id W6PS27X4YK), PP_SIGN_ID "Apple
  Distribution: Ramine Darabiha (52WM463HR2)", APP_STORE_INSTALLER_ID "3rd
  Party Mac Developer Installer: ...", PP_TESTFLIGHT_ONLY=1. Upload:
  asc builds upload --app 6794880742 --pkg dist/PartyParty-app-store.pkg
  --version <v> --build-number <n> --wait.
- First merge-gate runs on this repo surfaced two runner facts: (1) the WSL
  runner's network stack can ACCEPT on a "closed" loopback port, so readiness
  timeout tests must dial a TEST-NET-1 blackhole, never a freed local port
  (internal/mediamtx tests fixed); (2) Playwright browsers are provisioned
  once on the runner as root (npx playwright install --with-deps chromium;
  cache /root/.cache/ms-playwright survives across runner builds).
- Debugging gotchas that each cost real time today: `log` is a zsh BUILTIN —
  unified-log reads silently do nothing unless you call /usr/bin/log; tccd
  redacts identities as <private> (grep for AUTHREQ/service names, or dump a
  tight window unfiltered); the broadcast log ring (ppcapture/ffmpeg/mediamtx
  output) is served as the `log` field of /api/status — no FDA needed, the
  fastest capture-debug channel there is; inherit-entitled helper binaries
  SIGTRAP when run standalone from a shell (rc=133, not a build defect — use
  the unsigned copies in assets/ for desk experiments); the standing worktree
  needs assets/ffmpeg + assets/mediamtx copied in once from canonical.

## The Shack15 cutoff fix (reference)

THE SHACK15 CUTOFF CAUSE IS FIXED AND PROVEN. The 2026-08-04 silence keepalive
in swift/ppcapture.swift fired 120ms after the last real frame - inside normal
HAL callback jitter - so on a loaded venue Mac it repeatedly spliced zeros into
PLAYING audio and every listener heard the same hole at the same instant. The
replacement is a two-clock design: real audio rides the device clock
exclusively (per-cycle mSampleTime accounting; a real-frames meter separates
real from synthesized so a wedged/hogged tap still looks wedged to the health
monitor), and dead air is wall-clock-filled only after 1.5s of no real frames -
strictly beyond what the 0.5s ring + 0.9s hold-back absorb, so the filler is
structurally incapable of touching playing audio - with a 5ms fade-in when
music returns. Empirical facts baked into an every-launch "clock report" diag
line: on a silent Mac the aggregate's IO cycle stops COMPLETELY (cycles=0 over
10s, measured 2026-08-05), so device-clocked silence is impossible on this API
and the wall-clock filler is not optional. Verified live on this Mac: silent
go-live in 4s (was 34.5s/forever), silence->music transition with zero
gapHistory growth. Installed and running (125.33-dev stamp).

## Shazam verdict (2026-08-05 02:30)

Track recognition died 2026-07-31 for TWO stacked reasons, both now resolved
as far as code can: (1) the rename flattened ppcapture to a bare inherit-
signed binary, losing the shazamd mach exception AND the bundle identity TCC
needs - restored on the branch (ppcapture.app, app's bundle id, capture
entitlements, verify-app-store.sh asserts all of it). (2) With that fixed, a
clean-room probe proved the remainder: ShazamKit 202 = "Missing entitlements"
wrapping HTTP 401 from api.shazam.apple.com - catalog matching requires
signing/provisioning that carries the App ID's ShazamKit service. Desk builds
embed no profile and are refused by Apple's server, always. Recognition is
therefore PROVEN only in provisioned builds: the next TestFlight build (with
this branch merged) is the verification vehicle. Desk-build recognition would
need a Mac Development profile embedded (app + capture bundle) - optional
follow-up, not a gate.

## Blockers

None recorded.

## Ruled out

- The 300-500 listener load test: the owner cancelled it, and a real party has since run successfully.
- Speaker mode (foreground Web Audio tight sync) — proposed as a sixth sync mode, never adopted. Web Audio, MSE, and rate-nudging are all proven dead on locked iPhones; do not relitigate without new iOS facts.
- hls.js/ManagedMediaSource as the iPhone default — caused an audible seek storm (~1 skip/sec). Native AVPlayer is the engine; MMS is opt-in only.
- Renaming bundle IDs, DNS hostnames, Bonjour service type, Go module/import path, helper binary name, R2 bucket/header keys, or the Workshop project id: these are installed-app and live-infrastructure compatibility identifiers, not product-facing old-name copy.
- Commit-on-snap for the DJ reel: selectDJ() rebuilds the HLS session, so a flick past four DJs would mean four rebuilds and four audible gaps. Snap moves focus; the switch fires on settle.
- Capping the cover with aspect-ratio + max-height: the browser shrinks the WIDTH to keep the ratio, which left the banner covering two thirds of a wide window. Use an explicit height with object-fit:cover on the img.
- Splitting a CSS selector list on commas without first excluding comments: a comma inside a comment stranded the closing */ in a fragment that was dropped as dead, turning the rest of the stylesheet into one runaway comment and silently killing ~21 rules.
- React + Tailwind for the console: the app is a single vanilla HTML file embedded in the Go binary and rendered in a WKWebView, with no bundler and no internet at runtime. Emitting React/Tailwind would be a framework migration plus an offline-vendored build step, and would discard ~1,400 lines of working JS driving the QR, status polling, capture permissions and the feed.
- A human-readable join address like party.local/sunset: guest playback is HTTPS and the certificate must validate for the hostname, and an mDNS .local name can never hold a public cert. The readable address already exists as the direct hostname; only relay mode shows the opaque r-<token> URL.
- A start/end chime: capture is Mac system output, so any UI sound plays through that output and lands in the guests' stream. 'Subtle sound' and 'never enters program audio' are mutually exclusive under system-output capture.
- "The container is empty" as evidence: a shell without Full Disk Access LISTS ~/Library/Containers/<id>/Data directories as empty and reads files as "Operation not permitted" (TCC). The 2026-08-03 session logs were "missing" all night while sitting exactly where diag.Open put them. Prove absence with a file read, never with ls; /api/status.diagPath now names the live path.
- Probing the r-<token>.partyparty.party URL with curl to judge room health: the Worker serves its relayBootstrap (a probe-then-redirect page) for EVERY path on r- hosts, so curl sees 4.4KB of HTML regardless of room state. The room lives at <token>.relay.partyparty.party; judge health there.
- Treating relay presence as proof the relay works: presence (RunPlane) and media push (Run) are separate planes with separate failure modes. Fresh presence proves only that snapshots flow.
- Counting HTML tags to prove structure: balanced totals do not prove nesting. </details></div> where </div></details> was meant balances perfectly and silently force-closes an ancestor, landing whole panes inside unrelated elements with no syntax error. The contract test now walks the stack in document order instead.
- Presence freshness as relay health: RunPlane and the media cycle are separate planes; presence stayed fresh for hours while the media push was dead
- Judging room health via the r-<token> URL with curl: the Worker serves its relayBootstrap for every path on r- hosts; judge at <token>.relay… or /__pp/health on the box
- Concluding files are missing from ls of ~/Library/Containers/...: TCC shows those dirs as empty to a no-FDA shell; prove absence by file read

## MEASURED 2026-08-11: the two paths do not agree, and direct misses D

A relay verification (the standing field debt below) turned up something
bigger than the thing it was checking. Both numbers are from
`scripts/soak-playback.sh`, a real muted AVPlayer, room live on the test tone,
two minutes each, receipts in `build/`:

| path | what the player fetches | EXT-X-START served | measured | verdict |
|---|---|---|---|---|
| direct `:8443/live/party/index.m3u8` | multivariant | `TIME-OFFSET=-3.000,PRECISE=YES` | **1.17s** | SOAK FAIL |
| relay `<token>.relay…/stream.m3u8` | media playlist | none at all | **3.33s** | SOAK PASS |

`latency` in that harness is `Date() - item.currentDate()`: wall clock minus
the PROGRAM-DATE-TIME under the playhead, so it is true end-to-end delay, not
a distance from the playlist edge.

**What the three seconds is for (owner, 2026-08-11).** It came out of a set at
the Shack 15 office where guests got constant random cutoffs, and the cure was
to buy buffer. It was never a sync target and was never meant to hold anybody
back from the room; sync is wanted as tight as it can be had. So read the
table with that in mind, because it changes which number is the bad news:

- 1.17s on the direct path is not "a declared number missed by a factor of
  2.5". It is the Shack-15 cushion NOT BEING THERE on the path essentially
  every guest uses. Whatever made those cutoffs stop is not in effect.
- The ~2.2s spread between a direct guest and a relayed one is bad on its own
  terms, because guests in one room should hear the same thing at the same
  time.
- A fix therefore has two jobs that do not automatically come together: put
  the cushion back where it stops dropouts, and make both paths land on the
  same number. Lowering D to match today's 1.17s would make the two agree and
  bring the cutoffs back.

Read it in that order, because it is the reverse of what everyone assumed:

- **Direct is the one that is wrong.** It carries the correct July D=3 pin, in
  the multivariant, with PRECISE - the exact form `AGENTS.md` records as
  re-proven at 3.11s flat before upload (affebd3) - and a real AVPlayer sits at
  1.17s anyway. 1.17s is about PART-HOLD-BACK (0.9) plus the packaging floor,
  which is where a player lands when it ignores the pin. The pin is being
  served and is not taking effect. Reproduced in forced-relay AND in clean
  auto/direct mode, so it is not an artifact of the override.
- **Relay is near 3.0 by accident, not by design.** Nothing authors an
  attachment point on that path: `contribute.cycle` fetches the multivariant
  only to learn the variant name and publishes the MEDIA playlist as
  `stream.m3u8`, and `schedule.RewritePlaylist` only adds the pin to a
  playlist containing `EXT-X-STREAM-INF`. A relayed guest is handed a media
  playlist with a hold-back and no pin. Its 3.33s is 1.17s of direct plus
  ~2.2s of relay hop.
- **So a room with both kinds of guest is ~2.2s out of sync with itself**,
  which is the one thing `internal/schedule` exists to prevent, and the
  comment in `contribute.cycle` claims it prevents.

NOT FIXED, deliberately. `AGENTS.md` gates any change to hold-back,
EXT-X-START, the room delay or segment shape on a real-AVPlayer soak that
passes BEFORE a build goes anywhere, and the audio core on a supervised
go-live test. Both belong to the owner's next real set, not to an unattended
session. What is done is the measurement and the receipts.

Worth knowing before touching it: `AGENTS.md`'s never-again list already
records that the offset interacts with the parts region - stretching
PART-HOLD-BACK to 2.9 put the pin outside it and AVPlayer snapped the listener
to the window's oldest edge. A -3.000 offset against a 0.9 hold-back and a
0.512s/0.171s window may be the same interaction seen from the other side.

## The LAN resolver caches a negative for half an hour (2026-08-11)

This Mac does not ask the internet for DNS. `scutil --dns` puts
**192.168.1.50 (the NAS)** first, and that resolver caches negative answers
for the zone's SOA minimum, which is 1800s.

The consequence, which cost real time tonight: look a name up BEFORE creating
it and the whole LAN cannot see it for the next half hour, while `dig @1.1.1.1`
and `dig` against Cloudflare's own nameservers answer correctly the whole
time. The symptom is split-brain - `dig` fine, `getaddrinfo` NXDOMAIN, the Go
app failing on an address family that should not have been chosen - and none
of it is a fault in the record.

So: create the record first, then look it up. If a name is already poisoned,
wait it out. Flushing the NAS is touching shared infrastructure and is not
worth it for a timer.

Second thing the same episode showed: **this Mac has no global IPv6.**
`ifconfig` has no `inet6 2…` address and the only default v6 routes point at
utun tunnels, so `ping6` to Cloudflare says "no route to host". A `curl -6`
that appears to succeed is reporting `::ffff:a.b.c.d` - an IPv4-mapped
address, i.e. IPv4. Do not read that as IPv6 working, which is exactly the
wrong turn taken here before checking `ifconfig`.

## Owed

- Correction to Apple DTS: an earlier support message said the host was
  "macOS 26.0". It is macOS 27.0 build `26A5388g`.
- Field tests no simulator can stand in for: a real-iPhone wildcard-cert join,
  and a relayed party with more phones than one simulator on venue Wi-Fi
  (`docs/relay-architecture.md`). The relay MEDIA path itself is no longer
  unverified - one AVPlayer played it end to end (see above) - what is still
  owed there is many phones on venue Wi-Fi.
- The direct path's 1.17s vs its declared 3.00s, and the ~2.2s split between
  direct and relayed guests in one room. Measured, reproduced, not fixed:
  it is audio-core work and needs a supervised set. The cushion is there to
  stop dropouts, not to hold listeners back - do not "fix" the disagreement by
  lowering D to the number direct happens to sit at today.
- Nothing on the web pages. The stacked layout eras are collapsed: dead rules
  removed and every selector declared more than once in the same context merged
  into one canonical rule (listener 500 -> 359 live rules, dj 438 -> 311), with
  computed-style equivalence proven against the pristine files at nine
  breakpoints. What remains of `.hero` and `.hero .artwork` across `@media`
  blocks is genuine responsive variation, not leftovers.
