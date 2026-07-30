# Session handoff, 2026-07-28 to 07-29

What changed, why, what is proven, and what is not. Written for an investigator
picking this up cold. Companion doc: `testflight-install-500-handoff.md` covers
the one unresolved item in detail.

Shipped during this stretch: **125.0 through 125.7** (standalone), **125.5
build 222** (Mac App Store). Public right now: **125.7 build 223**.

---

## 1. Audio latency and choppiness (start of the stretch, closed)

**Symptom.** Latency was mostly ~1s but randomly settled at 2s or 4s, and
audio "cut off all the time" on iPhone.

**Two independent causes, both fixed:**

1. A **latency ratchet** (4.5s climbing to 5.6s). The ffmpeg `tee` legs used
   `use_fifo=1` *without* `drop_pkts_on_overflow`, so a slow leg back-pressured
   the shared tee and dragged the whole pipeline. Fixed with
   `drop_pkts_on_overflow=1` on every leg plus PCM ring 8s to 0.5s. Note the
   bundled ffmpeg mis-parses `fifo_options` containing an internal `:` — found
   by smoke test, worth remembering.
2. **Choppiness was an engine problem, not a buffer problem.** The iPhone
   default was ManagedMediaSource/hls.js, which seek-storms at a tight live
   edge (~1 audible skip/sec). Default switched to **native AVPlayer**: smooth
   at ~1s and lock-safe. MMS is now opt-in via `?mode=aggressive`.

Owner confirmed "excellent now" and "perfect when locked". Then: added a
**STABLE SETTINGS** toggle and removed the auto-publish-replay, mono,
room-sync-delay and drift-correction settings.

**Durable facts** (do not relitigate without new evidence): gohlslib rounds
`EXT-X-TARGETDURATION` to an integer second, so segDur 500ms and 1s are
identical; segDur below 500ms is spec-invalid; `partDur` is the only real
segment lever.

---

## 2. The relay rebuild (the bulk of the work)

### Why

The old relay put a **Cloudflare Worker plus Durable Object in the path of
every guest LL-HLS request**: roughly **48,000 Worker invocations per listener
hour**, hitting the free tier at about **two listener-hours**. Architecturally
wrong, not a tuning problem.

### The design the owner drove

Requirements he set explicitly, and which the code now enforces:

- Must scale to **500 listeners in one room** ("limiting a room to forty people
  is idiotic").
- **"Just do what is the normal solution"** — contribution, origin, fan-out.
  Not a reverse tunnel.
- **Every audio chunk carries the time it should play**, so everyone hears the
  same moment — *in direct mode too*.
- **No guess-and-check tuning per network**, no measure-then-decide phases.
- **Hard constraint:** a slow device, or many, must **never** drag out latency
  for everyone else.
- Three network situations must all work: offline/travel-router, venue Wi-Fi
  without client isolation, venue Wi-Fi with isolation. Automatic detection
  plus a settings override.
- The healthy wildcard DNS estate stays; only relayed media moves off it.

### What was built

**`internal/relay/mode.go`** — the room mode as a pure function `decide(Evidence)`,
so the whole state machine is table-testable. Modes: `checking`, `local`,
`direct`, `relay`, `no_path`. The two axes are "can guests reach the Mac here"
(resolver + guest probe) and "is the internet reachable" (broker registration).
Overrides: auto/direct/relay/local, all with honest fallback.

**`internal/schedule/`** — the declared schedule. `PartHoldBack = 0.9`,
`Delay = 1.0`. Every chunk carries `EXT-X-PROGRAM-DATE-TIME`; the contract is
"a chunk stamped T plays at T + D". **D is declared, never discovered.** It
lives in its own package because both the direct serve path and the
contribution path must author the identical value.

`TestRoomDelayNeverRespondsToConditions` sweeps every broadcast state, health
value, bitrate and listener count and asserts the published delay never moves.
`latencyTarget(_ broadcast.Status, _ string)` discards both arguments
deliberately — that is the hard constraint above, enforced by a test.

**`internal/contribute/`** — pushes the Mac's own LL-HLS byte for byte over
HTTP to the origin. It does *not* hand the origin a stream to re-package; an
origin that re-packaged would stamp its own ingest time and desynchronise
relayed guests from direct ones.

**`internal/origin/` + `cmd/pporigin/`** — the origin service. Accepts
authenticated PUTs, serves guests with no credential, implements blocking
playlist reloads (`_HLS_msn`/`_HLS_part`), drops everything when the party ends.
Deployed on the existing Oracle box (us-sanjose-1, ~39 ms from the owner's Mac)
alongside chiptunes.app, with systemd weights giving partyparty roughly 25:1
CPU share under contention **without ever restarting the 24/7 radio**
(`systemctl set-property`, not `reload-or-restart` — that distinction matters).

**`internal/roomplane/`** — origin-side read replica and aggregator. Guest
reads served from memory; heartbeats aggregated into one digest for the Mac;
writes queued for the Mac to drain. This is the change that makes 500
listeners cost the Mac the same as 5.

The old relay was **deleted**, not deprecated: Durable Object, Worker media
proxy, WebSocket connect endpoint, Mac socket data plane, loopback origin. The
owner explicitly accepted stranding fielded installs.

### Five wiring gaps found the first time a phone was pointed at it

Each half passed its own tests. None of these were visible to unit tests. The
shape is the lesson: **two components each honouring their own contract, with
nobody proving the joint.**

1. **The Mac could not read its own stream.** Contribution fetched
   `/party/stream.m3u8`, a path MediaMTX does not serve → 401 forever.
2. **The session cookie.** MediaMTX hands out a session on the *multivariant*
   playlist and **requires** it on the media playlist. Reading the stream is a
   two-step conversation; the client needs a cookie jar.
3. **Relayed guests were on a different schedule.** The declared hold-back was
   authored only on the direct path, so relayed listeners would have run on the
   muxer's raw `0.42750` while direct listeners ran on `0.90000`. Both look
   correct alone; they disagree only when two people stand together.
4. **The origin refused every real install.** It validated publish credentials
   against a static JSON file while the broker *mints* one per install. Now the
   origin asks the broker to **verify a presented token** rather than fetch the
   correct one, so no publish credential is ever handed out and the box stores
   nothing that can publish.
5. **`RunPlane` was never called**, and the origin served **no guest page**.

### Round two, found by driving it with a real phone

6. **Live-window eviction deleted the two files uploaded once per set.** The
   guest page and the `EXT-X-MAP` init segment are the *oldest* objects in the
   room by definition, so oldest-first eviction dropped both about three
   minutes in. Every guest joining after that got a 404 page and an undecodable
   stream while the room looked healthy. Playlist PUTs now **pin** their
   `EXT-X-MAP` names plus `index.html`.
7. **Heartbeats are sent as GET** (a `fetch` with no method); the origin counted
   POST only. A phone that was audibly playing counted as nobody, all night.
   The page's actual wire format is the contract.
8. **The feed long-poll became a hot loop.** The listener page breathes 150 ms
   between answers because on the Mac the parked request *is* the pacing. The
   origin answered instantly from its snapshot → ~7 requests/second per guest.
   Room snapshots now carry content versions, the origin parks a `wait=1` poll
   on `If-None-Match`, and the page backs off against any instantly-answering
   server. Measured: **3 requests in 35 s** where the old page would have made
   ~230.
9. **Origin restarts** are now detected by an `X-PP-Room-Epoch` header on every
   PUT response; the contributor resets its dedupe state and re-sends the
   fixed-name assets. This happened for real during verification, on my own
   deploy.
10. **`RELAY` is only claimed after `/__pp/health` answers** (reason
    `origin_unreachable` otherwise). The mode used to prove the Mac's side and
    simply assume the relay's.
11. **Offline `LOCAL` was unreachable** on exactly the network it exists for.
    The cached-certificate path never observed the venue resolver, leaving
    `ResolverMatches` at its zero value, which downstream read as "mismatch".
    `Result.ResolverObserved` now gates consumers so a pre-observation failure
    cannot stomp real evidence.

### Verified in production

- Live set pushed Mac → Oracle origin: health went `rooms 0, mediaFiles 0` to
  `rooms 1, mediaFiles 512`.
- Guest fetch of `stream.m3u8` returns `PART-HOLD-BACK=0.90000` with the init
  segment and parts intact.
- `PROGRAM-DATE-TIME` reads **1.0 s behind wall clock** — the declared delay,
  exactly.
- Init plus a segment decode to **AAC-LC 48 kHz stereo 320 kb/s** of audible
  audio.
- **A real iPhone (iOS simulator, Safari) played the relayed stream from the
  origin**, and the DJ console read **"1 listening (1 via relay)"**.
- `LOCAL` proven with an unreachable broker: settles on `local/offline_local`
  with the direct URL in the QR.

### Not verified

**A party with more phones than one simulator, on a venue network nobody
controls.** Also untested: locked-iPhone behaviour on the relay path (the
simulator cannot truly test lock), and the 500-listener claim — which is the
whole point of the design and has never been load-tested. A synthetic
load test of 300 to 500 guests against the live origin is queued and cheap;
it was deferred by owner instruction ("we will do 1-2 later").

---

## 3. Release pipeline (was the single worst source of wasted time)

Three separate defects each shipped a release that passed every gate and was
broken in the field:

1. **125.0 auto-update 404'd.** The Worker served downloads from a hardcoded
   `STANDALONE_FILES` map the ship script never updated.
2. **Regressing build numbers.** `BUILD` defaulted to a hardcoded `216`, so
   125.2 published as build 216 against an installed 218. Sparkle compares
   build numbers, so it was **undeliverable from the moment it landed** while
   the ship reported success.
3. **Version/build disagreement.** The ship derived a build number into a local
   variable it never exported, so `build-standalone.sh` fell back to its own
   default and stamped a different number.

**The fixes are structural:**

- The Worker resolves versioned downloads **from R2 by name** (strict regex) and
  derives `/api/version` from the **published appcast**. A ship now edits no
  source and deploys no Worker — there is nothing to forget to register.
- Version and build are both **derived from what is published**; a regressing
  build refuses to publish.
- Every ship writes a **machine-readable receipt** (`dist/receipts/latest.json`)
  with the failing stage. Reading outcomes from log tails produced false
  reports twice in one night.
- **`net.ramine.partyparty.autoship`** — a launchd agent (`StartInterval 120`)
  that watches `main` from a dedicated clone, debounces bursts, ships via the
  standard script under `run-capped` with stdin closed, judges by receipt,
  holds a commit after 3 failed paid builds, and pauses via a state-dir `off`
  file. Lock is a stale-safe pid **directory** mutex (macOS has no `flock`).
  **Commit and push to main IS the ship now.** Never foreground `ship-standalone.sh`.
- `PP_BUILD=0` marks dev builds and **disables Sparkle auto-check**, because a
  dev build used to replace itself with the public release seconds after
  launch, silently substituting the code under verification.

Traps worth knowing: `bash -n` cannot see inside heredocs, so embedded Python
must be extracted and compiled (a patcher turned `\n` into real newlines inside
two heredocs and only the daemon's live run caught it); and piping ffmpeg
listings straight into `grep -q` under `pipefail` reports failure for a check
that *matched*, because grep exits early and ffmpeg dies on SIGPIPE.

---

## 4. Observability and safety added

- **Post-set report.** Every set over two minutes writes
  `set-report-*.json` into the event folder: peak listeners (direct and relay),
  spread, deviation against the declared delay, and a mode timeline. Real one
  on disk from verification: 4.4 min, peak 1 relay listener.
- **Relay canary.** The Worker cron probes the origin every minute and keeps
  `sickSince`/`lastHealthyAt` in R2, served at `/api/relay-canary`.
- **Origin deploy gate.** `deploy-origin.sh` refuses to restart while a room is
  live (`PPORIGIN_FORCE=1` overrides), because a mid-party deploy kicks every
  relayed listener. This happened during verification.
- **Real-binary integration test.** `internal/origin/realmtx_test.go` boots the
  actual bundled MediaMTX with the app's real generated config, publishes real
  audio through the bundled ffmpeg, and runs the real contributor. Every fake
  this repo wrote for MediaMTX was more permissive than the real thing, which
  is how the 401 shipped. The fakes now refuse what MediaMTX refuses.
- **Origin gzips text** (page, playlists, room JSON), never media. Relayed
  guests were downloading a 200 KB page raw.
- **Test isolation.** `relay.New` loads the saved connection-mode override and
  network verdicts from the real per-user state dir, so tests touching it must
  isolate `HOME` or they read the developer's machine. One test was passing or
  failing based on how the app had last been used by hand.

---

## 5. App Store and TestFlight

Full detail in **`docs/testflight-install-500-handoff.md`**. Summary:

**Fixed, all real:**
- Nested capture helper claimed the **parent's bundle identity**, which put the
  parent's provisioning profile inside the nested bundle. Two `verify-app-store.sh`
  checks **asserted this defect**; both inverted.
- **GPL ffmpeg** (`--enable-gpl --enable-libx264 --enable-libx265`) shipped
  inside a closed-source App Store app — a licensing violation in every lane
  and the likely cause of the `116.87` rejection. Replaced with a source-built
  **LGPL** binary (`scripts/build-ffmpeg-lgpl.sh`), 51 MB to 21 MB, verified
  against the real production tee shape.
- **Review metadata described a deleted product** (demo account required, notes
  telling the reviewer to sign in — the account system was removed 2026-07-26).
- **Store record was jammed** by the rejected `116.87`; now `125.5 /
  PREPARE_FOR_SUBMISSION` with build 222 attached.
- `scripts/asc-api.py` — ASC API client for all of this.

**Unresolved and now isolated to Apple's install-data backend:** TestFlight
install fails with **HTTP 500 from Apple's own service** at
`ProcessingInstallInitiateResponse`, across four builds and three package
structures. Build `125.8 (224)` uses Apple's documented plain inherited helper
layout and is `VALID` and `APP_STORE_ELIGIBLE`. The owner confirmed other
TestFlight apps install on this Mac. Through the App Store Connect API we
populated the build localization, updated the beta license, successfully
submitted beta review, aligned the macOS version to `125.8`, attached build
224, and verified availability and tester state. The install endpoint still
returns 500 before issuing a download URL. Final correlation key:
`SNBYNKQ42G3MMOCDBIFFTPON5Y`.

Apple DTS case **20000120924076** needs a follow-up asking Apple to inspect or
reprovision app `6794880742` / numeric build `225731682` in the private
install-data service. Do not upload more package variants without new
server-side evidence.

A stripped control then removed every PartyParty helper and independently
packaged a 1.5 MB, single-app payload as `125.10 (226)`. It was correctly
signed, uploaded with no warnings, processed as `VALID`, appeared in
TestFlight, and failed at the identical install-initiate endpoint before any
download URL was returned. Numeric build ID `225733993`, correlation key
`MKQIR2EDGFM3CSLHV3TDHFS7SE`. This rules out the production package contents,
helper graph, package size, local PartyParty copies, and release scripts.

Also: the owner's Mac is on **macOS 27.0 seed `26A5388g`**, and every
documented TestFlight-install regression found was on a macOS seed.

**Later App Review diagnosis:** Apple invalidated `125.8 (224)` with
`ITMS-90301: Apple is not currently accepting applications built with this
version of the OS.` The package recorded `BuildMachineOSBuild=26A5388g`, proving
that it was built on the owner's macOS 27 seed. Xcode 26.6 and its macOS 26.5
SDK are accepted, so the host OS is the specific defect. App Store builds now
run on GitHub's released `macos-26` image, and the local packaging script refuses
prerelease macOS hosts. The replacement is `125.9 (228)`.

---

## 6. Repo state

- `main` clean, nothing unpushed, single worktree, no unmerged branches.
- Autoship daemon resident and shipping (last: `125.7 build 223` from `9b47604`).
- Origin and Worker deployed; canary green.
- Docs: `docs/relay-architecture.md` (v3, with a dated addendum recording the
  five wiring gaps), `docs/testflight-install-500-handoff.md`, this file.

## 7. Standing owner doctrine that shaped these decisions

- Build the **whole** correct solution, including refactors; never partial
  band-aids.
- **Always ship the latest**; never ask whether to release. Batch into one
  coherent commit and one deploy.
- Forward progress is mandatory; **waiting is not a task state**. Any pipeline
  relied upon must have a launchd-resident, model-free driver.
- Never babysit a build or ship. Fix a *cause*, never a symptom; if a pipeline
  fails, make the pipeline self-healing once.
- MXroute SMTP for all transactional email, never a paid email API.
- Account-free product, Mac App Store distribution. Do not restore product
  auth, cloud party pages, or direct installers.
