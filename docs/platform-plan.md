# The platform: communities, events, and the party inside them

Status: plan, not built. Owner decisions are marked **DECISION**. Nothing here
ships until the sequencing at the end is agreed.

## The thesis

Today PartyParty is one night. A DJ goes live, sixty phones join over Wi-Fi,
the party ends, and everyone evaporates. The next night starts from zero.

That is exactly the complaint about Partiful: every event is recreated from
scratch and there is no continuity, no crowd, no scene. Bandsintown and
Eventbrite have a follow button but were never in the room. Secretparty gets
closest, and it does it with email — the invite lands, there may be a code,
you come.

The durable object is not the party. It is the **community**: a DJ or a group
of DJs, the people who come to their nights, and the events they run. The
party is one evening inside a community, and the silent-disco stream is
optional — a community can run events and never stream a note.

That last point is what makes this worth building. It works before the app
does anything, on a phone, with no Mac in the room.

## What exists today

Honest inventory, verified 2026-08-06:

- **Mac app + Go server** — the party itself: capture, LL-HLS, the guest page,
  the wall, party folders under `parties/<id>/`. Party metadata already carries
  title, host, bio, avatar, date, time, place, cover, and social links.
- **Cloudflare Worker** (`cloudflare/worker.js`) — the landing site, the
  anonymous certificate broker, DNS for LAN hostnames, relay registration and
  the relay canary. Storage is R2 (`DL`) used as a key-value store.
- **Relay origin** (`cmd/pporigin`) — fans out LL-HLS for relay-mode parties.

What does **not** exist: any database, any account, any profile page, any
email pipeline, any payments. The account system was deliberately removed on
2026-07-26 and the D1 binding went with it. This is a build, not a revival.

## The model

Four objects. Everything else hangs off them.

**Community** — a name, a handle, a picture, a description, links. Has one or
more DJs. Owns its members and its events. `partyparty.party/@handle`.

**Member** — a person who joined a community. An email address and a display
name. No account, no password, no app.

**Event** — belongs to a community. Date, time, place, description, cover.
Optionally ticketed, optionally gated by a code, optionally attached to a live
party. `partyparty.party/@handle/<event>`.

**Signup** — a member said they are coming to an event. Going, or not going.
A ticket is a signup that was paid for.

The party — the Mac, the stream, the wall — attaches to an event when there is
one, and stands alone when there isn't. A DJ who has never opened the Mac app
can run a community, and a DJ who never makes an event can still go live. The
two halves do not depend on each other.

## The pages

### Platform (Cloudflare, always reachable)

| Page | URL | Who |
| --- | --- | --- |
| Community | `/@handle` | anyone — who this is, next event, join button |
| Event | `/@handle/<event>` | anyone — details, signup, tickets |
| Join confirmation | emailed link | new member confirming their address |
| Ticket | emailed link | a buyer — their code, their entry |
| Member preferences | emailed link | a member — stop emails, leave |
| Dashboard | `/@handle/manage` | the DJs — events, members, money |

### The party (served by the Mac, LAN first)

The existing guest page, with two additions: **tip the DJ** and **join the
community**. Its social links already exist. It stays exactly as it is
otherwise — no accounts, no internet required, no change to the audio path.

### One link for the whole lifecycle

`partyparty.party/@handle/<event>` is a single URL the DJ posts once:

- **Before** — the event page. Details, signup, tickets.
- **During** — hands the visitor into the live party (LAN when they are in the
  room, relay when they are remote and the DJ allows it).
- **After** — the night is over. No replay, no recording, no archive. It offers
  the community and the next date.

That is the answer to "you always have to recreate everything from scratch."

## Identity

**DJs sign in with Apple.** It is native on macOS and on the web, it needs no
password, and — the reason it matters here — it means we never build an
authentication email service, which the project's doctrine forbids. A DJ signs
in once on the Mac and once on the web and the same identity holds.

**Members never sign in.** Joining a community is giving an email address and
confirming it. Every action after that arrives by a link in an email: signing
up, changing your mind, getting your ticket, leaving. A ticket link is a
credential, not an account.

This preserves the rule that matters most: a guest at a party still needs
nothing — no account, no internet, no email — to open the page and listen.

**DECISION:** Sign in with Apple only, or Apple plus Google for DJs who are not
on a Mac? Apple-only is simpler and covers every DJ running the app.

## Email

MXroute SMTP, as with every project here. Five messages, no more:

1. **Confirm** — you asked to join a community; click to confirm. Double
   opt-in, so the list is clean from day one.
2. **Invite** — a new event, from the community, to its members.
3. **Reminder** — the day of, with the link and the code.
4. **Ticket** — the receipt and the entry code.
5. **After** — a short note from the DJ, sent only when the DJ writes one.

Every message carries a one-click unsubscribe. Unsubscribes are honored across
the whole platform, not per community.

**The list belongs to the community.** It is exportable. We send on the DJ's
behalf and never mail their members for our own reasons.

**Honest risk:** MXroute is shared hosting with rate limits and a shared
reputation. It is right for the first hundred sends and wrong for fifty
thousand. When volume grows this needs a dedicated sending domain, SPF/DKIM on
that domain, and a warmup — not a different vendor.

## Money

**Stripe Connect.** Each community onboards its own Stripe account; Stripe
handles the identity checks and holds the liability for payouts. Guests pay by
Apple Pay in the browser. We take a percentage.

- **Tips** — first. A tip button on the party page and the community page.
  Small amounts, no refunds to speak of, no capacity, no scanning. The rails
  get proven on the cheapest possible case.
- **Tickets** — second. Priced entry, a code in the email, capacity, a door
  view for the DJ, refunds. Real work; worth doing once tips are running.
- **Merch** — third, and a link out to the store the DJ already has. Holding
  inventory or handling returns is a different company.

**Why this is safe with Apple.** Two separate rails, and the split is clean:

- Anything sold to a *guest* — tips, tickets, merch — happens on a web page in
  the guest's browser. Our app never presents it, never links to it, never
  processes it. Tickets and tips are real-world services, outside in-app
  purchase, and the guest is not using our app at all.
- Anything sold to the *DJ* as a feature of the app — the Pro unlock — is
  in-app purchase. That product already exists:
  `fm.partyparty.app.pro.lifetime`, non-consumable, $99.

The Mac app may *show* a total. It must never take a payment that isn't IAP.

## Free and paid

Free, permanently, no cap: the party. Going live, guests joining, listening,
the wall. Also free: having a community, having members, running events, and
people signing up. A capped free tier on the thing that fills the room would
cost more in trust than it earns.

Paid is money and scale:

- **Our cut** of tips and tickets. This is the business.
- **Pro, $99 lifetime (IAP)** — **DECISION on the payload.** With branding
  dropped, the candidates are: a custom party link name, remote listening
  (guests outside the venue), and an unlimited community (free caps at, say,
  250 members and 4 events a year). Remote listening is the only item that
  costs us bandwidth on every use, which argues against it being lifetime.

## Data

A D1 database on the existing Worker. R2 keeps images. Sketch:

```
community   id, handle, name, bio, avatar, cover, links, stripe_account, created
dj          id, apple_sub, email, name, created
membership  community_id, dj_id, role (owner|host)
member      id, email, name, confirmed_at, unsubscribed_at
follow      community_id, member_id, joined_at, source (party|link|invite)
event       id, community_id, slug, title, starts, place, description, cover,
            ticket_price, capacity, code, party_id, state
signup      event_id, member_id, state (going|not), created
ticket      id, event_id, member_id, code, amount, stripe_payment, state
tip         id, community_id, event_id, amount, stripe_payment, created
send        id, community_id, event_id, kind, count, created
```

`follow.source` matters: it tells a DJ how many of their crowd came from being
physically at a party versus a posted link. That is the number that proves the
whole thesis.

## What does not change

- The LAN party works with no internet, no account, and no platform. Every
  invariant about offline parties stands.
- The audio core is untouched. No phase of this work goes near
  `internal/broadcast/`, the playlist geometry, or the room delay.
- Photos stay the DJ's. The wall is theirs; nothing is sent to guests, and
  nothing becomes public, unless the DJ chooses to send it.
- No replays, no recordings, no archives, no public feed of past nights.

## Doctrine changes required

These are real changes to `AGENTS.md` and should be made deliberately, in one
commit, before any code:

- **Invariant 1** (guests join without accounts or internet) — **unchanged**,
  and the identity model above exists to keep it that way.
- **Invariant 2** (no product login before Go Live) — **rewrite.** DJs get an
  account. Guests still don't, and Go Live is still not gated on anything.
- **Invariant 4** (cloud state is ephemeral; no public party pages) —
  **rewrite.** Communities and events are durable public pages. The part worth
  keeping is the ban on replays, recordings, and archives of the night itself.
- **Invariant 6** (no authentication email service) — **keep**, and Sign in
  with Apple is how. Announcement email to members is a different thing and is
  allowed explicitly.

## Sequencing

Phase 1 needs no Mac work at all, which is why it goes first: it can move at
web speed without risking the audio core.

**Phase 1 — communities, events, signups, email.** D1, Sign in with Apple, the
community page, the event page, join and confirm, going/not going, and the
invite and reminder emails. At the end of this phase the product is a working
replacement for Partiful and Secretparty, with no party attached.
*Proof: a real community with real members gets a real invite and people sign up.*

**Phase 2 — the party joins the platform.** The event page hands visitors into
the live party. The guest page gets "join the community", with the follow
source recorded. The Mac app links its party to an event.
*Proof: a follow taken at a live party appears in the community's member list.*

**Phase 3 — tips.** Stripe Connect onboarding, a tip button on the party page
and the community page, payouts, and the DJ's total.
*Proof: money reaches a DJ's bank account.*

**Phase 4 — tickets.** Price, capacity, codes, the door view, refunds.

**Phase 5 — merch.** A link out, on the community page and the party page.

**Pro** lands whenever its payload is decided; it is independent of the above.

## Open decisions

1. The word. "Community" is a placeholder — crew, club, collective, scene?
2. Sign in with Apple only, or Apple plus Google?
3. The Pro payload, given branding is dropped.
4. Our percentage on tips and on tickets.
5. Free caps on members and events — any, or none?
