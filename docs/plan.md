# PartyParty: the plan

One document. Everything in flight, everything intended, in the order it gets
done. Written 2026-08-06 against the tree at `1a0e35d`. Supersedes
`docs/platform-plan.md`.

Rules that govern this work live in `AGENTS.md` and are not repeated here. The
one to remember: any change to playlist geometry or playback positioning needs
a PASSING soak before a build is uploaded anywhere.

---

## Where this stands

**Shipping today.** A macOS menu-bar app that turns a DJ's Mac into a party
server. Guests scan a QR, land on an HTTPS page over the venue Wi-Fi, and hear
the set at a fixed three seconds on native AVPlayer — through a locked phone.
They post photos, video and comments to a wall. It works with no internet at
all. TestFlight is on 125.47 build 267.

**Proven and stable:** the capture path and its TCC prompt, in-app ShazamKit
recognition, the 3s buffer with its soak receipt, party folders as one-night
keepsakes, one-party-per-Wi-Fi adoption between DJs, guest re-homing when a Mac
leaves, per-phone stall telemetry, the LAN state reducer, and the Wi-Fi-only
default for party reach.

**Does not exist:** any database, account, profile, email pipeline, or payment
rail. The account system was removed on 2026-07-26 and the D1 binding went with
it. Everything in Part 2 and Part 3 below is a build, not a revival.

**The direction.** The durable object is not the party — it is the **group**: a
DJ or several, the people who come to their nights, and the events they run.
The party is one evening inside a group, and the silent-disco stream is
optional. That is what Partiful lacks (every event starts from zero) and what
Bandsintown and Eventbrite have without ever being in the room. It also means
the platform can ship without the Mac app moving at all.

---

## Part 1 — The party engine

Exists and works. The job here is to protect it and close four gaps.

### Untouchable

The audio core, the playlist geometry, the 3s room target, and
`internal/broadcast/`. Two green-tested geometry builds failed on real phones
inside minutes on 2026-08-05; unit tests cannot hear AVPlayer. Nothing in this
plan goes near any of it.

### The cloud is a fallback, never a broadcast

A club does not want its night streamed to the world, and neither does someone
throwing a party in their flat. The relay exists for exactly one reason: the
venue's own network cannot carry the room — AP isolation, a resolver that will
not answer, a hostile guest network. It is a way to reach the party that is
happening in front of you, not a way to attend from somewhere else.

So: relay is infrastructure, not a feature. It is never advertised, never
sold, and never the reason to buy anything. "Listen from anywhere" is not a
product we offer.

One honesty note, because the plan should not pretend otherwise: we cannot
cleanly tell a guest standing in the venue on cellular from someone at home
with the link. The relay stream is reachable by whoever holds the link, and the
link is handed out at the door. The discipline is that we do not build on that,
market it, or charge for it.

**Owed:** the Settings control is still called *Party reach*, with "Wi-Fi only"
and "Wi-Fi + cloud" — the vocabulary of broadcasting. It should read as what it
is: whether the party may fall back to the cloud when this Wi-Fi cannot carry
it.

### 1.1 The party link must survive the host leaving

Today the join hostname resolves to one Mac. When that Mac leaves, the link
still points at it: guests already in are covered by re-homing, but nobody new
can get in. The fix is the broker publishing an A record per live member with a
short TTL, so the name follows whoever is still playing.

Deliberately deferred once already, and the reason stands: it rewrites
production DNS for the live domain, and getting it wrong points guests at the
wrong Mac. It needs its own pass with the Worker smoke test extended — never
the tail of a long batch.

### 1.2 Field tests no simulator can stand in for

- A real iPhone joining on a wildcard certificate.
- A relayed party with more phones than one simulator, on venue Wi-Fi.
- The fallback path end to end: Settings → allow the cloud, go live, and join
  from off the network. This proves the relay works for a venue whose Wi-Fi
  cannot carry the room. It is a reliability test, not a feature demo.

### 1.3 LAN honesty, as actually built

`internal/server/lanstate.go` reduces cert, DNS publication, resolver
agreement, activation completeness and live guest count into one of three
states — `unavailable`, `ready`, `confirmed` — exposed as the `lan` object on
`/api/status`, with a Bonjour isolation verdict alongside. There is no
`/api/lan-health` endpoint and no explicit `cloud_fallback` state; the console
derives its message from the evidence fields. If the honest copy needs a fourth
state it should be added to the reducer, not invented in the page.

### 1.4 App Store

The binary cannot be submitted while this Mac runs a prerelease macOS 27 SDK.
Store packages build only on an Apple-released host. Not blocked: metadata,
screenshots, review notes, and the IAP paperwork. Owed separately: a correction
to Apple DTS — the host is macOS 27.0 build `26A5388g`, not 26.0.

---

## Part 2 — The platform

### The model

**Group** — name, handle, picture, description, links. One or more DJs. Owns
its members and its events. `partyparty.party/@handle`.

**Member** — a person who joined a group. An email and a name. May sign in,
never has to.

**Event** — belongs to a group. Date, time, place, description, cover.
Optionally ticketed, optionally code-gated, optionally attached to a live party.
`partyparty.party/@handle/<event>`.

**Signup** — going, or not. A ticket is a signup that was paid for.

### One link, for the whole life of an event

Settled, because of what people do with a Partiful link: they open it before to
see who is coming, and come back after to dump their photos.

- **Before** — details, who is going, tickets, and the timeline already
  running.
- **During** — the same page hands you into the party. In the room it is the
  live room: the stream, the wall, posting. Away from it you get the timeline
  and no player, because the music is for the people who are there.
- **After** — the timeline stays and people keep uploading for days. The music
  does not: no replay, no recording, no archive of the set.

A second link would cut the night's memory in half and double what the DJ has
to post.

**The cost, named.** The timeline needs a cloud source of truth that the LAN
wall reconciles into. At the party the Mac still serves posts locally, so a
party with no internet behaves exactly as it does now and reconciles upward
later. That reconciliation is the hardest engineering in this plan.

**Visibility.** The event page is public — it is the invite. The timeline is
for members and attendees. Photos are never public and never mailed out except
by the DJ's own act.

### The pages

| Page | URL | Who |
| --- | --- | --- |
| Group | `/@handle` | anyone — who this is, next event, join |
| Event | `/@handle/<event>` | anyone — details, signup, tickets, timeline |
| Join confirmation | emailed link | a new member confirming their address |
| Ticket | emailed link | a buyer — their code, their entry |
| Preferences | emailed link | a member — stop emails, leave |
| Dashboard | `/@handle/manage` | the DJs — events, members, money |

The Mac-served guest page gains exactly two things: **tip the DJ** and **join
the group**. Nothing else about it changes.

### Identity

DJs sign in with Apple — native on macOS and the web, one identity across the
app and the dashboard. Members may sign in, and never have to: joining is an
email and a confirmation, and every action after that works from a link in an
email. A guest at a party still needs nothing at all.

**Apple and Google, both** (owner, 2026-08-06), for DJs and for members who
want an account. Members who sign in are matched to an existing member row by
verified email, so a person who joined three groups by link and later signs in
keeps all three.

### Email

MXroute SMTP. Five messages: confirm (double opt-in), invite, day-of reminder,
ticket, and an after-note the DJ writes themselves. One-click unsubscribe on
every one, honored platform-wide. The list belongs to the group, is
exportable, and is never mailed for our own purposes.

**Risk:** MXroute is shared hosting with a shared reputation — right for the
first hundred sends, wrong for fifty thousand. Growth means a dedicated sending
domain with its own SPF/DKIM and a warmup, not a different vendor.

### Data

D1 on the existing Worker; R2 keeps images.

```
group       id, handle, name, bio, avatar, cover, links, stripe_account, created
dj          id, apple_sub, email, name, created
membership  group_id, dj_id, role (owner|host)
member      id, email, name, confirmed_at, unsubscribed_at, apple_sub?
follow      group_id, member_id, joined_at, source (party|link|invite)
event       id, group_id, slug, title, starts, place, description, cover,
            ticket_price, capacity, code, party_id, state
signup      event_id, member_id, state (going|not), created
ticket      id, event_id, member_id, code, amount, stripe_payment, state
post        id, event_id, member_id, kind, body, media, created, origin (lan|web)
tip         id, group_id, event_id, amount, stripe_payment, created
send        id, group_id, event_id, kind, count, created
```

`follow.source` measures the whole thesis: how much of a DJ's crowd came from
being physically at a party versus a posted link. `post.origin` is what makes
one link possible.

---

## Part 3 — Money

### The money is the DJ's, and we never hold it

Ko-fi's structure, adopted whole. Tips and tickets route through the DJ's
**own** PayPal or Stripe account. We are the page, not the processor; the DJ is
the merchant.

What that deletes from this plan, and it is most of the hard part: holding
funds until after the night, payout scheduling, an unclaimed-money policy,
chargeback exposure, and any merchant-of-record or money-transmission posture.
Gone, all of it. Refunds and disputes belong to the DJ, which is correct — it
is their party.

What it costs: we can guarantee a buyer nothing. If a DJ cancels and refuses to
refund, the buyer's recourse is their card issuer and the DJ's processor, not
us. That belongs in the ticket copy, not in a support thread six months from
now.

Onboarding is "connect your PayPal or Stripe" — one click for anyone who
already has an account. Mechanically this is Stripe Connect **Standard**, where
the connected account is the merchant and owns its own disputes and the
platform takes an application fee, or PayPal's equivalent.

### The fee table

| | Free | Pro |
| --- | --- | --- |
| Tips | 0% | 0% |
| Tickets | 5% | 0% |
| Processing (Stripe/PayPal) | 2.9% + 30¢ | 2.9% + 30¢ |

Ko-fi's own shape, with tickets sitting where their shop and memberships sit.
Tips at zero also fixes the arithmetic that made them embarrassing: a $5 tip
carries the processor's fee and nothing of ours.

### Fees are added, not deducted

The DJ receives the face value. Our cut and the processing fee are added on top
and shown to the buyer as one number, as Posh and DICE do.

A $20 ticket:

```
free tier                       Pro                     Posh
DJ receives   $20.00            $20.00                  $20.00
our cut        $1.00 (5%)        $0.00                   $2.99 (10% + 99c)
processing     $0.94             $0.91                   included
buyer pays    $21.94            $20.91                  $22.99
```

A Pro DJ's guests pay $2 a ticket less than they would on Posh. That is the
line, and it is worth more than any feature we could list.

### Pro is a subscription

Owner decision, 2026-08-06: fee-free is recurring and **there is no lifetime**.
A lifetime unlock that zeroes our cut forever is adversely selected — the DJs
who buy it are precisely the ones selling the most tickets, and the revenue
never comes back.

Pro contains: no platform fee, and the custom party link name. More can earn
its way in later; it does not need to launch full.

**Price: $12/month or $99/year** (owner, 2026-08-06). Ko-fi Gold is $12/month;
the annual keeps the number already anchored. A DJ who plays once a quarter
will subscribe the month of the party and cancel — that is fine, and Ko-fi
lives with the same pattern.

### The Apple boundary

Guests pay in their browser and the app never touches it — real-world services,
outside in-app purchase, and the guest is not using our app at all.

Pro is a digital subscription sold to the DJ, **both in the app and on the
web** (owner, 2026-08-06). Four things follow:

- **The existing IAP is the wrong product type.**
  `fm.partyparty.app.pro.lifetime` is a $99 non-consumable. A subscription
  needs an auto-renewable product in a subscription group. The lifetime product
  is dead — delete it when the real one is created, and never ship it.
- **One entitlement, two sources.** A DJ who subscribes on the web must have
  Pro in the app, and one who subscribes through the App Store must have it on
  the web. That means binding the IAP transaction to the DJ's account at
  purchase (`appAccountToken`) and verifying it against the App Store Server
  API, plus revoking on both sides when either lapses. Without it, DJs pay
  twice or lose what they bought.
- **Price parity.** Same $12/$99 on both surfaces. Undercutting the App Store
  price on the web is the kind of thing that draws attention we do not need for
  a difference of a few dollars.
- **Apple's share.** 30% by default, 15% under the App Store Small Business
  Program. Check enrolment before the first sale, not after.

The Mac app may show a total. It must never take a payment that isn't IAP.

---

## Free and paid

Free, permanently, no caps: the party, the group, the members, the events, the
signups. No member limit, no event limit. A cap on the thing that fills the
room would cost more in trust than it earns.

Paid is Pro: a subscription that removes our 5% on tickets. Tips carry no fee
of ours on either tier, and the money always belongs to the DJ.

---

## Part 4 — The build

How each piece is actually made, against the tree as it stands.

### 4.1 Where the platform lives: a second Worker

`partyparty-site` (the existing 979-line Worker) keeps the landing page, the
certificate broker, DNS, relay registration and the canary. It is not touched
beyond one three-line change in 4.2.

The platform is a **new Worker**, `partyparty-app`, on the same zone, routed on
`partyparty.party/@*`, `/app/*`, `/auth/*` and `/api/v1/*`. It binds a new D1
database, the same `DL` R2 bucket (for name reservations only), and a new R2
bucket for member-uploaded media.

The reason is blunt: certificate issuance and relay registration are
live-party-critical. A DJ mid-set must not be able to lose their room because a
platform deploy went out. Two Workers means a bad platform deploy takes down
sign-ups, not parties.

### 4.2 Names, and not fighting the broker

The broker mints two-word labels and guards three keyspaces —
`broker/host/`, `broker/join/`, `broker/slug/` — before handing out a name.
Group handles must join that guard or the two systems will eventually hand the
same word to two owners.

- **Group handle** — `^[a-z0-9]{5,30}$`, at `partyparty.party/@handle`. On
  creation, write `broker/handle/<h>` in R2 and refuse if any of the four keys
  exists.
- **The broker's only change:** `newHostLabel()` and `newJoinName()` gain
  `broker/handle/` to their existing collision checks.
- **The Pro custom party link** is the same handle used as the join name, so
  `@sundaze` gives both `partyparty.party/@sundaze` and
  `sundaze.partyparty.party`. That needs `JOIN_NAME_RE` widened: today it is
  `^[a-z]+-[a-z]+(-\d{1,2})?$`, which a single-word custom name fails, and
  `joinNameFromHost()` rejects anything that does not match.
- **Reserved:** `www`, `api`, `app`, `mail`, `admin`, `help`, `support`,
  `privacy`, `party`, `live`, `relay`, `r`, single letters, anything starting
  `r-`, plus a standard profanity list. Minimum five characters, as decided.

### 4.3 Identity and sessions

- **DJ, on the web:** Sign in with Apple or Google (OIDC). Session is an
  HttpOnly, Secure, SameSite=Lax cookie holding a signed session id; the row
  lives in D1 and can be revoked.
- **DJ, in the Mac app:** `ASWebAuthenticationSession` against the same web
  flow, returning a device token bound to the DJ and the install. Kept in the
  keychain. This is *additional* to the broker's install `id`/`secret`, which
  keeps doing its own job — the two credentials never mix.
- **Member:** an email link is the primary path and always works. Signing in
  with Apple or Google is optional and merges onto the existing member row by
  verified email.
- **Email links:** single use, 30-day expiry, scoped to one member and one
  action, and invalidated when used.

### 4.4 Data

One D1 migration to start (`0001_init.sql`) with the tables sketched in Part 2,
plus `session`, `email_token`, `outbox`, `suppression`, and `entitlement`.
Indices on `group.handle`, `event(group_id, starts)`, `follow(group_id)`,
`member.email`, and `post(event_id, created)`.

### 4.5 Phase 1 surface

```
GET  /@handle                     group page
GET  /@handle/<event>             event page
GET  /@handle/manage              dashboard (DJ session required)
POST /api/v1/groups/:h/join       join a group (Turnstile) -> confirm email
GET  /j/<token>                   confirm membership
GET  /e/<token>                   going / not going, from an emailed link
POST /api/v1/events               create, update, cancel (DJ session)
POST /api/v1/events/:id/invite    send the invite to the group
GET  /u/<token>                   member preferences, leave, unsubscribe
POST /auth/{apple,google}         start; /auth/*/callback finishes
```

### 4.6 Email plumbing

MXroute SMTP, and Workers are a bad place to speak SMTP. So: the Worker writes
to an `outbox` table; the origin box — already deployed, already ours, already
watched by the relay canary — polls an authenticated endpoint, sends through
MXroute with a normal Go SMTP client, and marks each row sent. Credentials stay
off Cloudflare, retries are ordinary, and every send leaves a receipt.

SPF, DKIM and MX for `partyparty.party` are already live. Every message carries
`List-Unsubscribe` and `List-Unsubscribe-Post`; the one-click endpoint writes to
a global `suppression` table checked before any send.

Rate limits: per group per day, and one invite per member per event.

### 4.7 Phase 2: the timeline across one link

The cloud is the source of truth. Post ids are ULIDs minted by whoever creates
the post, so a Mac with no internet can create real ids that never collide.

- **Outbound from the Mac:** posts and media queue in `.state/outbox.jsonl`.
  When there is internet, media goes to R2 through a signed PUT issued by the
  app Worker, then the post row goes up. A party with no internet behaves
  exactly as it does now and drains later.
- **Inbound to the Mac:** poll `/api/v1/events/:id/posts?since=` and merge into
  the room feed. `mergeRoomFeed` already merges peer posts and rewrites media
  URLs, so this is a second source, not a new mechanism.
- **Media policy:** photos always sync. Video syncs only after the night and
  only over the DJ's own connection — video never enters the relay, and that
  boundary should not be quietly crossed by the timeline.
- **Deletes:** the DJ can remove anything; deletion is a tombstone that
  propagates both ways.
- **Attribution:** a LAN guest posts under their party name; a member posts
  under their member identity. Both render as a name, and the two are never
  silently merged.
- **The join:** when a party goes live the Mac sets `event.party_id`, and the
  event page shows the live room while the party is live.

### 4.8 Phases 3–5: the money surface

- **Onboarding:** a Stripe Connect **Standard** account link, or PayPal's
  equivalent. The DJ is the merchant; we hold nothing (invariant 6).
- **Checkout:** Stripe Checkout in the guest's browser, created on the
  connected account with `application_fee_amount` — 5% on tickets, zero on tips
  and zero for Pro.
- **Webhooks:** `checkout.session.completed` writes the ticket or tip row and
  triggers the ticket email.
- **Tickets:** capacity checked at creation time, a code per ticket, and a door
  view for the DJ. The door view needs to work on a phone with bad signal — it
  should load the whole list once and check codes locally.
- **Refunds and disputes** are handled by the DJ in their own Stripe or PayPal
  dashboard. The ticket copy says so before purchase.

### 4.9 Pro across two stores

Web sales use our own Stripe. App sales use an auto-renewable IAP in a
subscription group, with `appAccountToken` binding the transaction to the DJ's
account and App Store Server Notifications v2 keeping the `entitlement` table
current. Pro is on when either source says so, and off when both have lapsed.
The old `fm.partyparty.app.pro.lifetime` non-consumable is deleted at that
point.

### 4.10 Abuse, privacy, limits

Turnstile on the join form — an open email-collection endpoint on a public page
is a harvesting target. Rate limits per IP and per group on join. Member export
and deletion on request; group export of its own member list. The `/privacy`
page needs rewriting for accounts, email and payments before any of this is
public.

### 4.11 How each phase is verified

The audio soak rule is untouched because nothing here goes near playback.
Everything else:

- A second smoke suite for `partyparty-app`, alongside the existing eight
  worker smoke tests, run by merge-gate.
- Playwright coverage for the group page, the event page, joining and
  confirming — the repo already runs Playwright on the lane.
- A Go contract test for the Mac↔cloud sync against a local stub, including the
  offline-then-drain path.
- One manual proof per phase, as listed in the sequencing below. A phase is not
  done because its tests pass; it is done when its proof happened.

---

## Sequencing

Ordered across everything, with what proves each step.

**1. Party-link survival** (Part 1.1). Small, self-contained, protects what
already ships. *Proof: a host leaves mid-party and a new guest still joins.*

**2. Field tests** (Part 1.2). Owner-dependent. *Proof: a real iPhone joins on
a wildcard cert, and a venue whose Wi-Fi cannot carry the room still gets its
guests onto the fallback path.*

**3. Platform: groups, events, signups, email.** D1, Sign in with Apple, the
group page, the event page, join and confirm, going/not going, invite and
reminder mail. No Mac work at all. At the end of this the product replaces
Partiful and Secretparty with no party attached. *Proof: a real group gets a
real invite and real people sign up.*

**4. One link.** The event page becomes the party while it is live; the
timeline reconciles between the Mac's LAN wall and the cloud; the guest page
gains "join the group". *Proof: a photo posted on venue Wi-Fi and one posted
the next morning sit in the same timeline, and a follow taken at the party
appears in the member list.*

**5. Tips.** Connect the DJ's own PayPal or Stripe; a tip button on the party
page and the group page; nothing of ours taken. *Proof: money lands in a DJ's
own account without ever passing through one of ours.*

**6. Tickets.** Price, capacity, codes, the door view. Refunds are the DJ's,
through their own processor.

**7. Merch.** A link out, on the group page and the party page.

**8. Pro and the Store.** The subscription on the web, then the auto-renewable
IAP and the entitlement bridge between them. Then submission, once macOS 27 is
released and a Store package can be built on a released host.

---

## Open decisions

None. Every question this plan raised has an answer in it.

Two things need the owner rather than a decision: the field tests in 1.2, which
need a venue and real phones, and the Apple and Google developer credentials
for sign-in. Everything else can start now, beginning with 1.1 — the party link
surviving the host's departure — which depends on nobody.
