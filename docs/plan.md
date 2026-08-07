# PartyParty: the plan

A DJ's Mac becomes the party: guests scan a QR, hear the set at three seconds
on a locked phone, and post to the wall — with no internet in the building.
That part ships today (125.47, build 267).

What it is missing is everything either side of the night. A DJ plays to sixty
people and keeps none of them; the next party starts from zero. So the durable
object is not the party, it is the **group** — a DJ or several, the people who
come to their nights, and the events they run. The party is one evening inside
a group, and the music is optional: a group can run events and never stream a
note.

## What already exists

**Shipping:** capture and its permission prompt, in-app ShazamKit, the 3s
buffer, party folders as one-night keepsakes, one-party-per-Wi-Fi adoption
between DJs, guest re-homing when a Mac leaves, per-phone telemetry, the LAN
state reducer, and Wi-Fi-only as the default reach.

**In git, not in the tree:** most of this platform was built once and removed
in `f44e796` ("Remove PartyParty account system"). `f44e796^` still has
`cloudflare/schema.sql`, eleven migrations and `docs/auth.md` — `users`,
`auth_sessions`, `auth_provider_tokens`, `dj_profiles` with handles,
`device_installs` and `install_link_tokens` for binding a Mac to an account,
`follows`, `event_guests`, and `live_installs`. Read it before writing
anything; most of the shape is right and the mistakes are informative.

Three judgements about that code:

- **Recover:** the auth tables, the device-link flow, follows, event guests,
  and `live_installs` — a heartbeat with a 90-second expiry and a
  `live_started_ms` tiebreak, which is exactly the mechanism 1.1 needs.
- **Change:** it was built around `dj_profiles`, one profile per DJ, with
  users bolted on afterwards by `ALTER`. Groups are the root object now, with
  several DJs, so this is a rebuild on recovered parts rather than a revert.
- **Never:** `event_sets` and the `/e/<slug>` replay page. The whole 0001
  schema exists to publish set recordings. We do not record the music.

## The model

**Group** — handle, name, picture, description, links. One or more DJs. Owns
its members and its events. `partyparty.party/@handle`.

**Member** — someone who joined a group. An email and a name. May sign in with
Apple or Google, never has to; sign-in merges onto the existing member by
verified email, so someone who joined three groups by link keeps all three.

**Event** — belongs to a group. Date, place, description, cover, optionally
ticketed, optionally code-gated, optionally attached to a live party.

**Signup** — going, or not. A ticket is a signup that was paid for.

A guest at a party still needs nothing: no account, no email, no internet.

### One link

`partyparty.party/@handle/<event>` is posted once and serves the whole life of
the night. Before: details, who is going, tickets, and a timeline already
running. During: in the room it becomes the room — stream, wall, posting; away
from it, the timeline and no player, because the music is for the people who
are there. After: the timeline stays and people keep uploading for days.

The event page is public — it is the invite. The timeline is for members and
attendees. Photos are never public and never mailed out except by the DJ's own
act.

The cost, named once: the timeline needs a cloud source of truth that the LAN
wall reconciles into. That is the hardest engineering here.

## Money

Ko-fi's structure. Tips and tickets route through the DJ's **own** PayPal or
Stripe; we are the page, not the processor. No holding, no payouts, no
escrow, no merchant-of-record posture, and refunds and disputes belong to the
DJ because it is their party. Onboarding is "connect your PayPal".

| | Free | Pro |
| --- | --- | --- |
| Tips | 0% | 0% |
| Tickets | 5% | 0% |
| Processing (theirs) | 2.9% + 30¢ | 2.9% + 30¢ |

Fees are added on top and shown to the buyer as one number. A $20 ticket costs
their guest $21.94 free, $20.91 on Pro; Posh charges $22.99.

**Pro is $12/month or $99/year**, sold both in the app and on the web. No
lifetime: an unlock that zeroes our cut forever is bought by exactly the DJs
selling the most. Both surfaces means one entitlement with two sources — the
App Store transaction binds to the DJ's account via `appAccountToken`, App
Store Server Notifications keep it current, and a lapse on either side revokes
both. Same price on both. Apple takes 30%, or 15% under the Small Business
Program — check enrolment before the first sale.

The existing IAP `fm.partyparty.app.pro.lifetime` is the wrong product type.
Delete it when the subscription is created.

## The build

**A second Worker.** `partyparty-site` keeps the landing page, certificate
broker, DNS and relay registration untouched. The platform is
`partyparty-app` on the same zone — `/@*`, `/auth/*`, `/api/v1/*` — with its
own D1 and media bucket. Certificate issuance is live-party-critical; a
platform deploy must not be able to end a party in progress.

**Handles must join the broker's collision guard.** It checks `broker/host/`,
`broker/join/` and `broker/slug/` before minting a two-word name; a handle
reserved outside that set will eventually be handed to two owners. Add
`broker/handle/` to `newHostLabel()` and `newJoinName()` — the broker's only
change. Handles are `^[a-z0-9]{5,30}$` with a reserved and profanity list.
The Pro custom link reuses the handle as the join name, so `@sundaze` gives
both the page and `sundaze.partyparty.party`; that needs `JOIN_NAME_RE`
widened, since `^[a-z]+-[a-z]+(-\d{1,2})?$` rejects a one-word name and
`joinNameFromHost()` would resolve it to nothing.

**Auth.** Apple and Google (OIDC) on the web; session cookie over a D1 row.
The Mac uses `ASWebAuthenticationSession` against the same flow and stores a
device token — the `install_link_tokens` pattern, recovered. The broker's
install `id`/`secret` keeps its own job and the two never mix. Member email
links are single-use, 30-day, scoped to one action.

**The party joins the cloud.** A live Mac heartbeats into `live_installs`
(recovered) with its party id, direct URL and expiry. Posts and media queue in
`.state/outbox.jsonl` and drain when there is internet: media by signed PUT,
then the row. Inbound posts merge through `mergeRoomFeed`, which already
merges peer posts and rewrites media URLs — a second source, not a new
mechanism. ULIDs so an offline Mac mints ids that never collide. Photos always
sync; video only after the night over the DJ's own connection, because video
never enters the relay and the timeline should not quietly cross that line.

**Email** is MXroute, sent from the origin box rather than from Workers: the
Worker writes an outbox row, the box polls, sends, and marks it. SMTP
credentials stay off Cloudflare and every send leaves a receipt. Five
messages — confirm, invite, day-of reminder, ticket, and an after-note the DJ
writes. One-click unsubscribe on all of them against a global suppression
table. SPF, DKIM and MX are already live.

**Abuse and privacy.** Turnstile on the join form; an open email-collection
endpoint on a public page is a harvesting target. Rate limits per IP and per
group. Member export and deletion, group export of its own list, and
`/privacy` rewritten for accounts, email and payments before any of it is
public.

**Verification.** A smoke suite for the new Worker beside the existing eight;
Playwright over group page, event page, join and confirm; a Go contract test
for the sync including offline-then-drain. Nothing here touches playback, so
the soak rule is unaffected. A phase is done when its proof happened, not when
its tests pass.

## The order

**1. The party link survives the host leaving.** Today the join bootstrap
holds one `directUrl`, written by the host install at registration; when that
Mac goes, nobody new gets in. Guests already inside are covered by re-homing.
The fix needs no new DNS: live members already publish their own machine A
records, so the bootstrap should hand the page every live member of the party,
freshest first, and let it probe them in order before falling back to relay.
*Proof: the host leaves mid-party and a new guest still joins.*

**2. Field tests.** A real iPhone joining on a wildcard cert, and a venue whose
Wi-Fi cannot carry the room getting its guests onto the fallback path. Needs a
venue and real phones.

**3. Groups, events, signups, email.** The platform standing on its own, no
party attached — which is the whole product for anyone replacing Partiful or
Secretparty. *Proof: a real group gets a real invite and real people sign up.*

**4. One link.** The event page becomes the room while the party is live, and
the timeline reconciles both ways. *Proof: a photo posted on venue Wi-Fi and
one posted the next morning sit in the same timeline.*

**5. Tips**, then **6. tickets**, then **7. merch** as a link out.
*Proof of 5: money lands in a DJ's own account without passing through one of
ours.*

**8. Pro and the Store.** The subscription on the web, then the IAP and the
bridge between them. Submission waits for released macOS — a Store package
cannot be built on a prerelease SDK. Not blocked: metadata, screenshots, review
notes. Owed separately: correcting Apple DTS, which was told the host is macOS
26.0 when it is 27.0 build `26A5388g`.

## Needed from the owner

The field tests in 2, and Apple and Google credentials: a Services ID with Sign
in with Apple, its key, and a Google OAuth web client. Secrets go in by
`wrangler secret put`, typed by you. Everything else can start now, beginning
with 1, which depends on nobody.
