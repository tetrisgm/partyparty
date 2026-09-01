# PartyParty.party handoff

This file contains current facts that are easy to lose between sessions. Git
history holds the old narrative; retired designs do not belong here.

## Product boundary

PartyParty is the macOS app that broadcasts one live DJ set to phones in the
room. A DJ runs the app, guests scan a QR code, and nobody signs in. There is no
account, profile, cloud-party, public-event, recording, replay, payment, or
remote-journal layer in this repository.

The anonymous install identity used by `internal/activate` is operational
authentication for hostname, certificate, DNS, and relay registration. It is
not a user account. `internal/contribute` is the live relay publisher, not the
deleted account-era cloud synchronization system.

Another product can answer account and journal paths on the shared
`partyparty.party` apex. It is maintained elsewhere and is not ours to deploy,
delete, or reconstruct. This repository owns the product site, anonymous LAN
broker, relay registration/bootstrap, machine namespace, and dormant
standalone-update plumbing represented in `cloudflare/`.

The codebase is intentionally simple at its outer edge:

- `main.go` wires the Go server, capture, event store, peer discovery,
  activation, room-mode manager, and relay contributor.
- `web/` contains the embedded vanilla HTML/CSS/JavaScript guest, wall, and DJ
  surfaces. They must work without a runtime internet dependency.
- `app/` is the native macOS shell and permission/menu-bar surface.
- `internal/contribute`, `internal/roomplane`, and `cmd/pporigin` form the
  transient relay path described in `docs/relay-architecture.md`.
- `cloudflare/` is the only Worker in this tree. It never carries media.

## Playback and capture invariants

Production audio is native HLS/AVPlayer on iPhone. hls.js is a non-Apple
fallback; hls.js/ManagedMediaSource caused repeated audible seeks on iPhone and
is not a production option.

The production geometry is fixed at 320 kbps stereo AAC-LC, 500 ms segments,
150 ms parts, 48 retained segments, a 0.9-second `PART-HOLD-BACK` floor, and
`schedule.Delay == 3s`. The multivariant playlist carries
`EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES`. Direct, local, and relay publish
one declared room target. It is never adaptive and never listener-specific.

Healthy native playback is passive. A visible phone at least 750 ms beyond the
target for three measurements receives a fresh HLS attachment. Corrections stay
available for the whole set; there is no per-session cap. They do not run while
Safari is hidden or the phone is locked, and missing telemetry alone never
interrupts audio.

Do not change delay, hold-back, attachment position, segment/part shape, or the
audio core without the pre-upload real-AVPlayer soak and supervised physical
test required by `AGENTS.md`. Unit tests, WebKit, computed browser state, and a
playlist proxy cannot prove audible native playback.

### Unresolved direct/relay measurement (2026-08-11)

A muted real AVPlayer measured the direct path at about **1.17 seconds** and the
relay path at about **3.33 seconds**, despite the declared three-second target.
This leaves the common direct path without the intended cushion and puts mixed
direct/relay guests roughly 2.2 seconds apart. It is reproduced and not fixed.

`scripts/bench-playlist-proxy.py` is not valid evidence for attachment position:
it produced roughly 3.1 seconds whether the pin was on the multivariant, also on
the media playlist, or absent. The synchronous proxy itself makes the player
fall behind. A candidate must be measured through the real guest path during a
supervised set. Do not lower the declared target to match the accidental direct
measurement; the cushion exists to absorb venue Wi-Fi stalls.

### Shack15 cutoff cause and fix

The 2026-08-04 silence keepalive fired 120 ms after the last real capture frame,
inside normal HAL jitter, and spliced zeros into live audio. The current
two-clock design leaves real audio exclusively on device sample time, starts
wall-clock filler only after 1.5 seconds without real frames, and fades real
audio back over 5 ms. On a silent Mac the aggregate device clock can stop
entirely, so delayed wall-clock filler is required. A silent-to-music test
produced no `gapHistory` growth after this change.

Compiling on the DJ Mac during a set has caused capture strain and audible
cutoffs. Do not build while it is broadcasting.

## Shazam status

A Mac Development-signed build matched two real tracks from system output,
including catalog artwork, so live `SHSession` catalog recognition works in a
properly provisioned development build. Ad-hoc builds do not reach Shazam and
are not a valid recognition test.

The App ID has the ShazamKit capability, but inspected Mac development and App
Store provisioning profiles did not expose a Shazam entitlement; a binary that
claims `com.apple.developer.shazamkit` is killed at launch. Do not add that
entitlement speculatively. Recognition in a fielded App Store/TestFlight build
has not been verified, and resolving that Apple-side ambiguity remains separate
from the already-proven development behavior.

## Network facts

Direct and local guests use the Mac's HTTPS server. Relay guests use the origin;
the Mac pushes each HLS object once and is not in their request path. Relay
photos are capped and throttled, and videos never enter the relay.

The LAN resolver used during the 2026-08-11 investigation cached negative
answers for the zone's 1,800-second SOA minimum. Looking up a name before its
record existed made system resolution fail for half an hour even while public
authoritative lookups succeeded. Create a record before testing it, and wait
out a poisoned cache. Flushing or reconfiguring the NAS resolver is shared
infrastructure work and is not part of a product task.

For offline use, a valid cached certificate is not enough: the venue resolver
must still map the secure hostname to the current LAN IP. The app observes that
resolver directly. Only when internet relay is unavailable and secure local
resolution is proven impossible may it expose the exact-IP HTTP emergency
link; locked-screen playback is not promised there.

Do not judge relay room health by fetching an `r-<token>` bootstrap hostname;
that endpoint intentionally returns the probe-and-redirect page. Media health
belongs to the room's `*.relay.partyparty.party` origin or the origin health
endpoint. Relay presence and relay media are separate planes, so one being
fresh does not prove the other works.

## Local party and multi-Mac state

Party data lives under the activation state directory in one folder per party.
The folder contains guest media and a static recap; journals, thumbnails,
identities, and reports live in its private state. The app does not retain a
recording of the music.

Macs on the same LAN advertise through Bonjour. A Mac going live can adopt an
active peer's party identity and join the same room instead of creating a rival
event. Peer posts remain owned by their source Mac and media URLs are rewritten
to that source. Guests can re-home to another member when one Mac disappears.

Event journals are compatibility surfaces. New fields must replay safely with
old lines, mutations must be written before being acknowledged, and remote
timestamps must never control a local logical clock.

## Distribution boundary

The active release lanes are the Mac App Store and public TestFlight beta.
Uploading a new build happens only when the owner explicitly asks. The standalone Sparkle
lane is dormant but intentionally retained for already-installed builds. No
commit, timer, launch agent, workflow, or watcher may publish or install a
release automatically.

Store and standalone artifacts are separate products of the same source commit.
Do not let Sparkle, Developer ID entitlements, or standalone update metadata
enter the Store target. App Store operations use `asc` and the repository's
packaging/verification scripts; no upload is a diagnostic step.

## Deep review record (2026-08-30)

The review landed as 43 small commits on `main`. Completed work includes:

- removed account-era tests, reconciliation/moderation APIs, duplicate reply
  handlers, unused UI assets/fonts, and stale ignore entries;
- bounded unauthenticated origin operations, Worker request bodies, idle HTTP
  connections, guest identities, listener telemetry, peer snapshots, queues,
  and relay photo work;
- serialized or coalesced listener status, wall polling/rendering, and native
  status refreshes; avoided deep-copying unchanged feed history;
- hardened DJ authorization, relay TLS, upload paths, malformed relay writes,
  origin restarts, track-deletion journaling, and immutable event snapshots;
- made relay mode transitions generation-aware and updated the web surfaces to
  avoid rapid polling and unnecessary DOM/QR reconstruction;
- made activation state and certificate generations atomic, bound broker
  results to immutable install generations, and prevented stale relay
  registrations from being committed;
- made relay contribution cancellation and target rotation generation-safe,
  with complete destination republishing before a playlist becomes visible;
- replaced cross-Mac wall-clock feed ordering with opaque source revisions,
  wakeable peer snapshots, and authoritative full-snapshot cursors, including
  peer disappearance, future-clock, deletion, restart, and room-switch cases;
- replaced the obsolete account, one-second playback, and Durable
  Object/WebSocket documentation with the system that ships.

The closing gate passed on 2026-08-30: all Go tests, `go vet`, the full Go race
suite, browser contract/render/interaction tests, 19 Worker smoke tests, and all
Swift tests and builds. Three independent focused reviews covered activation,
relay contribution, and cross-Mac feed concurrency. No release, deployment, or
playback-geometry change was made.

## Owed to physical reality

- Join through the wildcard certificate on a real iPhone.
- Run a relayed party with many real phones on venue Wi-Fi.
- Measure direct and relay playback together during a supervised set, then make
  any geometry decision from that evidence.
- Verify Shazam recognition in the actual App Store/TestFlight signing lane.

These are field-verification debts, not invitations to deploy, upload, alter
shared infrastructure, or claim native Safari behavior from simulation.

## Public-beta launch preparation (2026-09-01)

Launch preparation landed on `main` through commit `b3fca1a`. The repository
now has stranger-first beta onboarding, security and contribution guidance,
structured bug reports, a Hacker News/Product Hunt launch kit, exact-size
gallery/thumbnail/social assets, and the seven-second Remotion demo. GitHub has
accurate discovery topics, secret scanning, push protection, Dependabot
security updates, and zero open dependency alerts.

The product site was deployed from that work and most recently verified as
Cloudflare Worker version `30fcf1ff-a2c9-421f-9b70-8b0495c36cf1`. It serves the launch social card,
canonical `www` redirect, sitemap, product security headers, and first-party
TestFlight/GitHub redirect paths that can be counted in ordinary Worker request
analytics without cookies or cross-site tracking. Anonymous install
registration now passes through a 30-per-minute source-address Rate Limiting
binding before the existing short Cache API throttle.

Verification passed: all Go tests and vet, the full browser contract suite,
Swift build and tests, 24 Worker smoke tests and Wrangler dry-run, Remotion
render, npm audits, and live apex/header/redirect/sitemap/social-card checks.
No app binary was uploaded or submitted.

The direct/relay timing debt above remains launch-significant. The latest real
AVPlayer evidence still places direct playback near 1.17 seconds and relay near
3.33 seconds, and the current per-phone bootstrap permits both paths in one
Wi-Fi + cloud room. Public copy was therefore changed from “synchronized” and
an exact three-second promise to honest low-latency beta language. Do not
restore synchronized-playback claims until a candidate passes the required
pre-upload real-AVPlayer soak and supervised mixed-path field test.

The repository is source-visible under an explicit all-rights-reserved notice;
the owner may later replace it with an open-source license. Product Hunt video upload, final real-device
screenshots, actual Product Hunt/Hacker News posting, and any App Store action
remain owner-account decisions.

The public TestFlight link resolves to Apple's invitation for “partyparty: DJ
Wi-Fi Radio.” Build 271 (`125.49`) is assigned to the external `Party testing`
group, Apple-approved, valid through 2026-11-13, and reports
`IN_BETA_TESTING`; the public group limit is 10,000 testers. The tester-facing
description was updated in App Store Connect to the honest live-headphone-party
positioning and discloses the direct/relay delay difference. This proves the
public distribution configuration, not a fresh-device installation. The latter
still needs the release-day Mac walkthrough in `docs/LAUNCH.md`.

On 2026-09-01 the launch media and live discovery surface were rechecked. The
rendered demo is 7.061 seconds, 1920×1080 H.264 with AAC audio, and uses the
qualified “Playing live / Low-latency party audio” language. The Product Hunt
thumbnail is 240×240, all four gallery images are 1270×760, and its description
is within the current 260-character limit. The live Open Graph and Twitter-card
metadata resolves to the deployed 1200×630 image; the dancer favicon, canonical
redirect, TestFlight and GitHub redirects, sitemap, and security headers also
respond correctly. Actual social-network cache previews still need checking
from the owner's launch accounts.

Current Hacker News moderator guidance asks makers not to post LLM-written or
LLM-edited submission prose. `docs/LAUNCH.md` therefore treats its Hacker News
material as a fact bank rather than a finished title or first comment; the owner
must write both final elements independently in their own voice.

The product site previously presented automatic Shazam track recognition as an
unqualified shipping feature even though the distribution-signing result above
remains unverified. The launch page now labels recognition as part of the beta,
states that TestFlight validation is still open, and preserves the exact proven
boundary: development-signed recognition works. Do not remove that qualifier
until the fielded TestFlight/App Store build is tested.

The qualified recognition copy was deployed as Worker version
`dc7efff0-44d6-4a09-8d9d-4bb6dccc932b` and verified on the live apex. The
deployment uploaded only the changed `index.html`; Worker check, all 24 smoke
tests, and Wrangler dry-run passed before deployment.

The launch screenshot QR had been captured from a historical room rather than
made as inert demo art. macOS Vision decoded it as
`https://groovy-dance.partyparty.party/`, and that bootstrap was still live on
2026-09-01. The marketing source image was replaced with a visibly similar
but non-decodable generated pattern and the reserved display address
`demo-party.example`; the affected Product Hunt gallery image and video were
rebuilt from that sanitized source. macOS Vision reported `NO_BARCODE` for the
source image, gallery image, and a scan-scene frame from the final MP4. This
does not authorize deleting or revoking the
historical room. The Remotion render is also muted so a digital-silence AAC
stream does not add payload, and “opens instantly” is replaced by the factual
“opens in Safari.” The rebuilt video is exactly 7.000 seconds, 1920×1080 H.264
with no audio stream, and 1,727,431 bytes.

The sanitized marketing screenshot was deployed as Worker version
`1b3c4d14-7ee6-4206-af0e-f615d6c11d1b`. The live asset is byte-for-byte equal
to the committed source (SHA-256
`137161917175ef19a46c2e28825ba7e6fbc646ba1798a8c0936b9614482984ec`), and
macOS Vision reports `LIVE_NO_BARCODE` on a fresh production download.

The launch FAQ previously overclaimed support for “any Mac” and implied
permanent free pricing. It now states the proven distribution requirement—an
Apple-silicon Mac running macOS 26 or later with recent-iPhone guests—and says
only that the current public beta is free. Android and future-pricing claims
remain out of launch copy until the owner establishes those contracts.

The corrected support and pricing FAQ was deployed as Worker version
`aed623f3-a01c-497c-b787-e42f71da92c3` and both exact sentences were verified
on the live apex after deployment.

`CONTRIBUTING.md` no longer gives pull-request instructions immediately before
saying that pull requests cannot be accepted. Until explicit contributor terms
exist, it consistently directs proposed changes to issue discussion and asks
people not to spend time preparing an unusable pull request.

The launch page's eight expansion controls now have unique accessible names and
explicit `aria-controls` relationships to their detail panels. Below-fold
inline images declare intrinsic dimensions, lazy loading, and asynchronous
decoding, while the preloaded hero remains eager. Twitter metadata now carries
the same descriptive image alt text as Open Graph.

That accessibility and image-loading increment was deployed as Worker version
`3c9d3de1-e06f-42cc-9013-491db15f5c99`. A fresh production response contains
all eight `aria-controls` relationships, six below-fold lazy images, and the
Twitter image alt metadata. Root browser-contract tests, all 24 Worker smoke
tests, and Wrangler dry-run passed before deployment.

Privacy and Support now emit their own canonical URLs plus complete 1200×630
Open Graph and Twitter image metadata, including alt text. Support links to the
repository's issue-template chooser with an explicit reminder to omit private
data. The product site now owns a deterministic `robots.txt` that allows
indexing and points crawlers to the existing sitemap.

The first metadata deploy exposed a source mismatch during live verification:
the shared legal-page shell still selected the older 1300×867 `og-default.jpg`
while declaring 1200×630. The default was immediately corrected to the actual
1200×630 launch social card before this increment was closed.

The corrected discovery/support increment is live as Worker version
`4e2def86-c4d4-4103-8865-7994e3fb0beb`. Production Privacy and Support both
name `/img/social-card.png` with matching 1200×630 dimensions and canonical
URLs, Support exposes the issue chooser, and the live managed `robots.txt`
includes the committed sitemap directive after Cloudflare's content signals.

The launch audit measured white CTA text at 3.90:1 on the landing accent and
3.59:1 on the legal/support accent, below WCAG AA for their text sizes. The
accents were darkened to `#d7193f` (5.12:1) and `#d41446` (5.27:1), and the
small `#86868b` footer/secondary ink was replaced by `#6e6e73` (5.07:1). These
are computed sRGB contrast ratios against white; visual browser verification
remains separate from the unavailable Chrome trace/a11y tooling.

The contrast correction is live as Worker version
`30fcf1ff-a2c9-421f-9b70-8b0495c36cf1`; fresh apex and Support responses both
contain the intended darker variables. Browser-contract tests, 25 Worker smoke
tests, and Wrangler dry-run passed before deployment.
