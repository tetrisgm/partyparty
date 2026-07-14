# Scheduled live playout: comparison and shipping plan

Status: architecture proposal, 2026-07-13. This evaluates the proposed
"continuously authored audio timeline" against Party Party's shipped LL-HLS
system and the `fader91` packed-party evidence. It is a plan for a measured
replacement, not authorization to remove the production path.

## Decision

Build a **foreground scheduled-playout laboratory**, but do not replace native
HLS yet.

The proposal is directionally right: arrival time should not decide playback
time. However, Party Party already implements most of that idea through LL-HLS:
the Mac emits immutable ordered media parts, `EXT-X-PROGRAM-DATE-TIME` maps them
to the Mac clock, `/api/time` estimates client clock offset, and
`EXT-X-START` asks every player to begin at one room position. The missing
capability is receiver-controlled, sample-accurate rendering at an external
deadline.

That missing capability is easy in a foreground `AudioContext` and is not yet a
proven browser primitive for a locked iPhone. Party Party's majority path must
keep playing with the screen locked, Safari backgrounded, and page JavaScript
throttled or suspended. A Web Audio or JavaScript-fed media pipeline cannot
become the default until it survives those conditions on physical iOS 26 and 27
devices for a full party-length soak.

The safe strategy is therefore:

1. Keep native LL-HLS as the production control.
2. Reuse its existing AAC/fMP4 output to test scheduled rendering without first
   changing capture or encoding.
3. Compare native HLS, Managed Media Source, and Web Audio on the same media and
   clock.
4. Promote a new path only after it beats HLS on synchronization **and** matches
   its lock/background/recovery behavior.

## What the packed party established

The Seth Mac session (`fader91`, v53.61, 8 phones, 85 minutes) materially changes
the starting point for this decision:

- 26 of 26 opens became audible; the old silent-phone failure did not recur.
- Startup used no native seeks and most opens landed in about 3.0-4.5 seconds.
- The simultaneous-join cohort spread was about 0.69 seconds.
- Publisher restarts recovered automatically.
- One externally scrubbed phone remained about 34 seconds late while otherwise
  looking healthy. The shipped post-party watchdog now reattaches a client that
  remains more than 8 seconds beyond the room target; it does not seek or alter
  a healthy listener.

This means scheduled playout is no longer a rescue from a generally broken
system. It is a candidate for tightening the remaining sub-second spread and
making drift behavior more deterministic. It must beat a robust baseline.

## Current system versus the proposal

| Concern | Shipped LL-HLS | Proposed scheduled chunks | Actual difference |
|---|---|---|---|
| Immutable media | AAC in ordered fMP4 parts/segments | Opus/AAC packet groups | Already present |
| Stream identity | `streamSync.generation` and playlist URIs | Explicit epoch ID | Already present, different envelope |
| Media clock | HLS media time plus program date/time | Presentation timestamp per chunk | Already present at part granularity |
| Shared host clock | Six-sample `/api/time` calibration | NTP-like ping exchange | Already present |
| Future buffer | HLS holdback plus room target | Explicit rolling commit horizon | Same principle |
| Join boundary | `EXT-X-START`, then bounded startup verification | Sequence plus future start time | More explicit in proposal |
| Playback owner | Native AVPlayer/hls.js chooses rendering | Client scheduler chooses exact deadline | Genuinely new |
| Drift handling | Native rate 1.0; gross-late client reattaches | PLL/rate trim or boundary resync | Genuinely new, but audible rate control is risky |
| Late media | Native HLS recovery policy | Explicit skip/conceal/resync policy | Genuinely new |
| Lock/background | Proven native `<audio>` path | Unproven JS-fed path | Blocking product constraint |
| Guest install | Scan and listen in browser | Browser if viable; native app otherwise | Must remain browser-first |

The proposal should therefore be described as a **custom playout engine**, not a
new chunking scheme. HLS is already the scheduled media plane; the experiment is
whether taking rendering control away from AVPlayer produces a better complete
product on iOS.

## Feasibility constraints

### 1. Web Audio is the precise path, but the risky background path

`AudioBufferSourceNode.start(when)` can schedule against the audio rendering
clock, and an `AudioWorklet` ring buffer can provide sample-accurate network
playout. This is the cleanest implementation of the proposal in a foreground
tab.

It also makes JavaScript and `AudioContext` lifecycle load-bearing. WebKit has
repeatedly fixed and regressed background/interruption behavior, including
contexts reporting `running` while their clock no longer advances. A laboratory
must treat lock, Control Center, phone calls, camera use, tab switches, and
Safari backgrounding as primary tests, not cleanup work.

### 2. Managed Media Source may preserve native playback, but weakens control

Managed Media Source can feed fMP4 bytes into an `<audio>` element while keeping
decode and output in the media stack. It is the most promising browser bridge
between custom delivery and lock-safe playback.

It does not itself expose "render this sample at Mac time T." JavaScript still
has to append data and establish the initial media position, and the media
element's hardware clock owns steady playback. If append callbacks stop while
locked, a two- or three-second rolling buffer empties almost immediately. This
path must be tested rather than assumed.

### 3. WebSocket is optional, not architectural

The protocol does not require one. Immutable parts should remain ordinary HTTPS
objects so retries, caching, and missing-part requests stay simple. A small
long-poll, SSE, or WebSocket control channel may announce epochs and newest
committed parts, but playback correctness must come from timestamps and object
identity, not message arrival order.

### 4. Smaller parts are not the first experiment

The current 1-second part / 2-second segment profile has stronger physical iOS
evidence than earlier sub-500ms profiles. The first prototype must consume the
existing fMP4 parts and isolate the player architecture. Only after that works
should an owner-supervised audio-core experiment compare 500, 250, and 100ms
units. Changing encoder geometry and playback architecture together would make
the result uninterpretable.

### 5. A native guest app is the escape hatch, not the initial answer

A native iOS client can combine background audio entitlement, local scheduling,
codec control, and a monotonic clock. It can probably realize the proposal most
fully. Requiring an app would damage Party Party's scan-and-listen advantage, so
it is acceptable only as an optional high-precision mode unless browser
platform limits make the product trade worthwhile.

## Proposed protocol for the laboratory

Use one room timeline and keep the current Mac clock authority:

```json
{
  "epoch": 184,
  "sequence": 9321,
  "mediaTime": 412.250,
  "programTimeMs": 1783992010250,
  "presentationTimeMs": 1783992013250,
  "durationMs": 1000,
  "codec": "mp4a.40.2",
  "sampleRate": 48000,
  "channels": 2,
  "url": "/live/party/part9321.mp4",
  "sha256": "..."
}
```

Rules:

- `epoch` is the existing stream generation. A change invalidates all queued
  media from the old epoch.
- `programTimeMs` is the part's current HLS program date/time.
- `presentationTimeMs = programTimeMs + frozenRoomTargetMs`.
- A published unit is immutable.
- A receiver begins only at an announced future sequence after clock calibration
  and minimum-buffer admission.
- A late unit is never played late. The client records `skip`, `conceal`, or
  `reattach` according to the experiment policy.
- The room target is frozen for the run. Do not lower latency while comparing
  player architectures.

For the first lab, derive this manifest from the existing LL-HLS playlist in a
new package outside `internal/broadcast/`. Do not add a second encoder.

## Delivery plan

### Phase 0: freeze the baseline and scoring

Add one analyzer report that produces the same scorecard for every transport:

- audible opens / attempted opens;
- tap-to-audio and simultaneous-join spread;
- measured media-clock spread and optional microphone acoustic spread;
- late/missing units, rebuffer time, reattach count, and recovery duration;
- lock/background duration and discontinuities;
- bytes per listener, Mac CPU, and browser memory where exposed;
- epoch-change recovery after publisher restart.

Archive the v53.61 Seth report as the control. Include the current drift-watchdog
release as a second control before judging the new path.

### Phase 1: static scheduled-playout lab

Build a hidden DJ-only `/labs/scheduled-playout` page and listener route using a
known local audio asset, not live capture.

Implement two experimental adapters behind explicit query flags:

- `engine=webaudio`: decode ahead, feed an `AudioWorklet` ring buffer, and render
  against the calibrated presentation clock;
- `engine=mms`: append the same timestamped fMP4 units to an audio-only Managed
  Media Source and use the media element for output.

Keep `engine=hls` as the control. Log clock samples, intended and achieved start,
render underruns, context/media state transitions, and visibility changes with
the same client/session IDs as production telemetry.

Exit gate: on built-in speakers, at least 8 physical phones must produce 100%
audible starts and a simultaneous-start p95 below 250ms in the foreground. A
desktop-only result does not advance the project.

### Phase 2: lock and interruption qualification

Run each surviving adapter on physical iOS 26.4 and iOS 27:

1. Lock for 60 minutes.
2. Put Safari in the background for 30 minutes.
3. Use camera/photo picker and return.
4. Open Control Center and scrub/pause/resume.
5. Attenuate Wi-Fi behind a body for 3, 10, and 20 seconds.
6. Trigger a publisher-equivalent epoch change.
7. Test built-in speaker and Bluetooth separately.

Exit gate: no silent-forever client, no manual recovery, no more than one second
of unexplained inter-listener spread after recovery, and continuity comparable
to native HLS. Any adapter that depends on foreground JavaScript is classified
as a foreground feature, not a production replacement.

### Phase 3: live media with the existing encoder

Only after Phase 2 passes, expose the current AAC/fMP4 LL-HLS parts through the
timeline manifest. Keep native HLS available per client and add a DJ-only room
A/B control. A transport selection is frozen per client epoch; never switch an
audible client silently between engines.

Test joins before go-live, simultaneous joins, mid-set joins, output-device
changes, DJ restart, and the 34-second external-scrub case. The new path must
recover one bad phone without touching any healthy listener.

Exit gate: two controlled multi-phone sessions and one packed-party session with
all of the following:

- 100% eventual audible opens;
- no gross late outlier lasting more than the recovery bound;
- p95 acoustic spread no worse than 500ms and materially better than HLS;
- no regression in lock/background continuity;
- no meaningful Mac CPU or LAN-airtime regression at 32 simulated listeners;
- guest join remains local, HTTPS-only, account-free, and internet-free.

### Phase 4: tune chunk size and loss policy

If the live experiment wins, then run the supervised audio-core matrix:

| Variable | Initial candidates |
|---|---|
| Unit duration | 1000ms control, 500ms, 250ms |
| Commit horizon | production target, then 2s, then 1s |
| Late policy | skip; short conceal then boundary reattach |
| Drift policy | no rate change; bounded rate trim; future-boundary restart |

Change one variable per run. Do not use audible seeks. A playback-rate controller
must first pass an acoustic artifact test on sustained tones, percussion, and
mixed music; otherwise use future-boundary reattachment.

### Phase 5: canary, default, retirement

Ship the winner as a canary while preserving native HLS as automatic fallback.
Record engine and fallback reason in every heartbeat. Promote it to default only
after two packed parties on both iOS generations meet the Phase 3 gates.

Retire old startup alignment code only after the new default has one full release
of fallback coverage and telemetry shows no platform cohort depending on HLS.
Removal of the existing broadcast path remains owner-supervised because it
touches the audio core and lock-safe product behavior.

## Explicit non-goals for the first implementation

- No prerecorded-song or source-aware distribution mode.
- No cloud media relay.
- No peer-to-peer or multicast protocol.
- No new codec or second encoder.
- No room-wide adaptation based on the slowest phone.
- No requirement for guests to install an app or sign in.
- No claim of sample-level acoustic phase lock; Bluetooth/output pipelines remain
  outside browser timing observability.

## Kill criteria

Stop pursuing a browser replacement and keep LL-HLS if either experimental
adapter:

- cannot survive a 60-minute locked iPhone test without page interaction;
- needs a buffer so deep that it offers no synchronization advantage over HLS;
- produces more silent starts or manual recoveries than the packed-party control;
- requires source-specific behavior for ordinary system-audio capture;
- cannot recover independently after packet loss or epoch change.

If Web Audio wins foreground precision but fails lock, retain it only as an
explicit foreground "speaker array" experiment. If MMS survives lock but cannot
tighten the start, its useful pieces may still improve observability without
replacing native HLS.

## References

- [Web Audio API 1.1](https://www.w3.org/TR/webaudio-1.1/): scheduled buffer
  starts and `AudioWorklet` guidance for sample-accurate network/disk playback.
- [WebKit bug 237878](https://bugs.webkit.org/show_bug.cgi?id=237878): iOS
  background `AudioContext` suspension history.
- [WebKit bug 276016](https://bugs.webkit.org/show_bug.cgi?id=276016): a later
  iOS regression where Web Audio stopped after focus/background transitions.
- [Safari 17.1 Managed Media Source](https://webkit.org/blog/14735/webkit-features-in-safari-17-1/):
  iPhone availability and the API's JavaScript-managed buffering model.
- [HTML media element timing](https://html.spec.whatwg.org/multipage/media.html):
  media timeline and playback-position semantics.
