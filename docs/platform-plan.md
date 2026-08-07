# The platform: groups, events, and the party inside them

Status: plan, not built. Owner decisions still open are marked **DECISION**.
Nothing here ships until the sequencing at the end is agreed.

## The thesis

Today PartyParty is one night. A DJ goes live, sixty phones join over Wi-Fi,
the party ends, and everyone evaporates. The next night starts from zero.

That is exactly the complaint about Partiful: every event is recreated from
scratch and there is no continuity, no crowd, no scene. Bandsintown and
Eventbrite have a follow button but were never in the room. Secretparty gets
closest, and it does it with email — the invite lands, there may be a code,
you come.

The durable object is not the party. It is the **group**: a DJ or several, the
people who come to their nights, and the events they run. The party is one
evening inside a group, and the silent-disco stream is optional — a group can
run events and never stream a note.

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

**Group** — a name, a handle, a picture, a description, links. Has one or more
DJs. Owns its members and its events. `partyparty.party/@handle`.

**Member** — a person who joined a group. An email address and a display name.
May sign in, but never has to.

**Event** — belongs to a group. Date, time, place, description, cover.
Optionally ticketed, optionally gated by a code, optionally attached to a live
party. `partyparty.party/@handle/<event>`.

**Signup** — a member said they are coming. Going, or not. A ticket is a signup
that was paid for.

The party — the Mac, the stream, the wall — attaches to an event when there is
one and stands alone when there isn't. A DJ who has never opened the Mac app
can run a group; a DJ who never makes an event can still go live.

## One link, for the whole life of the event

`partyparty.party/@handle/<event>` is a single URL the DJ posts once. Settled,
because of what people actually do with a Partiful link: they open it before to
see who's coming, and they come back after to dump their photos and videos.

- **Before** — details, who's going, tickets, and the timeline already running:
  the hype, the questions, the lineup.
- **During** — the same page hands you into the party. On the venue Wi-Fi it is
  the live room: the stream, the wall, posting. Off the Wi-Fi it is the same
  timeline without the player, or with the relay stream when the DJ allows it.
- **After** — the timeline stays. People upload their photos for days. The
  music does not: no replay, no recording, no archive of the set.

A second link for the party would cut the night's memory in half — the phone
photos on one page and everything before and after on another. It also doubles
what the DJ has to post and explain.

**The cost, stated plainly.** The timeline needs a cloud source of truth that
the LAN wall syncs into. At the party the Mac still serves posts locally, so a
party with no internet still works exactly as it does now; it reconciles
upward when it has a connection. That reconciliation is the real engineering
in this plan, and it lands in Phase 2.

**Visibility.** The event page is public — it is the invite. The timeline is
for members and attendees. Photos are never public and never mailed out
except by the DJ's own act.

## The pages

### Platform (Cloudflare, always reachable)

| Page | URL | Who |
| --- | --- | --- |
| Group | `/@handle` | anyone — who this is, next event, join button |
| Event | `/@handle/<event>` | anyone — details, signup, tickets, timeline |
| Join confirmation | emailed link | a new member confirming their address |
| Ticket | emailed link | a buyer — their code, their entry |
| Member preferences | emailed link | a member — stop emails, leave |
| Dashboard | `/@handle/manage` | the DJs — events, members, money |

### The party (served by the Mac, LAN first)

The existing guest page, with two additions: **tip the DJ** and **join the
group**. Its social links already exist. Otherwise unchanged — no accounts, no
internet required, no change to the audio path.

## Identity

**DJs sign in with Apple.** Native on macOS and on the web, no password, and
one identity across the Mac app and the dashboard.

**Members may sign in, and never have to.** Joining a group is an email
address and a confirmation. Every action after that works from a link in an
email: signing up, changing your mind, your ticket, leaving. A member who
wants one identity across several groups can sign in and get it; the link path
keeps working either way.

A guest at a party still needs nothing at all.

**DECISION:** Apple only, or Apple plus Google? Apple-only is simpler and
covers every DJ running the app; Google mainly matters for members who choose
to sign in.

## Email

MXroute SMTP. Five messages, no more:

1. **Confirm** — you asked to join; click to confirm. Double opt-in, so the
   list is clean from day one.
2. **Invite** — a new event, from the group, to its members.
3. **Reminder** — the day of, with the link and the code.
4. **Ticket** — the receipt and the entry code.
5. **After** — a note from the DJ, sent only when the DJ writes one.

One-click unsubscribe on every message, honored platform-wide. The list belongs
to the group, is exportable, and is never mailed for our own purposes.

**Honest risk:** MXroute is shared hosting with rate limits and a shared
reputation. Right for the first hundred sends, wrong for fifty thousand. When
volume grows this needs a dedicated sending domain with its own SPF/DKIM and a
warmup — not a different vendor.

## Money

### There is no Apple-only path

Apple Pay is a payment *method*, not a payments platform. Taking money on the
web with it still requires a processor and a merchant of record. Apple provides
no way to collect from a guest and pay out to an arbitrary DJ. So the real
question is not Stripe or Apple — it is who carries the liability.

- **Each DJ has their own Stripe account (Connect Express).** Stripe runs the
  identity checks and carries the payout liability. We take a percentage
  cleanly. Cost: the DJ does a hosted onboarding form — name, date of birth,
  address, bank details. Three to five minutes on a phone.
- **We are the merchant of record.** Less friction for the DJ up front, but we
  then hold chargebacks, refunds, tax exposure, and the awkward position of
  selling tickets to events we do not run. In the US that posture drifts toward
  money transmission. Not worth it.

**The friction fix: defer the onboarding.** Stripe supports charging before a
connected account is verified and transferring the money once it is. So the DJ
turns tips on and nothing else: guests pay, our cut comes off, the balance
builds under their name, and the identity form appears the first time they tap
cash out — with money already waiting, which is the only moment it is
justified.

The floor underneath that is not a product choice. Paying a human being
requires their name, date of birth and a destination; that is KYC law. What we
control is *when* they are asked.

**Two tiers, as Partiful ships them.** Checked 2026-08-06, and the pattern is
universal: the only zero-setup path anywhere is "pay the host's own handle",
and it is exactly the path where the platform verifies nothing and takes
nothing.

- **Chip in** — the DJ's own Venmo, Revolut or PayPal handle, displayed. No
  onboarding, no liability, no processor, no cut.
- **Tips and tickets** — Apple Pay in the browser, our cut, Stripe behind it
  with onboarding deferred to cash-out.

Most DJs start on the first and move to the second the night someone tips them
$60 and it stops being theoretical.

**Payout timing.** Eventbrite, Posh and Partiful all hold funds until after the
event, to cover refunds and chargebacks. Only Luma pays out as sales land.
**DECISION:** hold tips until after the night, or pay as they arrive?

**Unclaimed money.** A DJ who takes tips and never cashes out leaves us holding
someone else's money. Proposed: hold 90 days with reminders, then refund the
guests.

### What the market charges

Checked 2026-08-06. The party-native platforms are the expensive ones:

| Platform | Fee |
| --- | --- |
| Posh | 10% + $0.99, shown all-in |
| DICE | ~10–12% booking fee to the fan, negotiated |
| Eventbrite | ~3.7% + $1.79, plus ~2.9% processing |
| Luma | ~5% on paid tickets, free events free |
| Ticket Tailor | flat ~$0.75/ticket, ~$0.30 prepaid — no percentage |

So a DJ selling a $20 ticket pays Posh about $3.00 and Ticket Tailor about
$0.75. There is a lot of room between those two.

**DECISION:** our take on tickets and on tips. My read: 5% plus Stripe's
2.9% + 30¢, passed to the buyer, undercuts Posh by half while staying
sustainable. Note that small tips are fee-hostile — Stripe alone eats 7% of a
$5 tip — so tips want either a suggested floor or our percentage at zero.

### The Apple boundary

Two rails, deliberately separate:

- Anything sold to a **guest** — tips, tickets, merch — happens on a web page
  in the guest's browser. Real-world services, outside in-app purchase, and
  the guest is not using our app at all.
- Anything sold to the **DJ** as a feature of the app — the Pro unlock — is
  in-app purchase: `fm.partyparty.app.pro.lifetime`, non-consumable, $99.

The Mac app may show a total. It must never take a payment that isn't IAP.

## Free and paid

Free, permanently, no caps: the party, the group, the members, the events, the
signups. No member limit, no event limit. A cap on the thing that fills the
room would cost more in trust than it earns.

Paid is money and scale:

- **Our cut** of tickets, and possibly tips. This is the business.
- **Pro, $99 lifetime (IAP)** — **DECISION on the payload.** With branding
  dropped the candidates are a custom party link name and remote listening
  (guests outside the venue). Remote listening is the only item that costs us
  bandwidth on every use, which argues against selling it once, forever.

## Data

A D1 database on the existing Worker. R2 keeps images. Sketch:

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

`follow.source` matters: it tells a DJ how many of their crowd came from being
physically at a party versus a posted link. That number is the whole thesis,
measured.

`post.origin` is what makes one link possible: the same timeline holds what was
written on the venue Wi-Fi and what was written from a couch three days later.

## What does not change

- The LAN party works with no internet, no account, and no platform.
- The audio core is untouched. No phase goes near `internal/broadcast/`, the
  playlist geometry, or the room delay.
- Photos stay the DJ's. Nothing is public, nothing is mailed to guests, unless
  the DJ does it.
- No replays, no recordings, no archives of the music.

## Doctrine

Done in this branch. `AGENTS.md` invariants 2, 4 and 6 were rewritten:
accounts are for DJs and optional for members; groups and events are durable
public pages while the music of a night still is not; email is MXroute and a
member's address belongs to the group that collected it. Invariant 1 stands —
a guest at a party needs nothing.

## Sequencing

Phase 1 needs no Mac work, which is why it goes first: it moves at web speed
and cannot hurt the audio core.

**Phase 1 — groups, events, signups, email.** D1, Sign in with Apple, the group
page, the event page, join and confirm, going/not going, invite and reminder
email. At the end of this phase the product replaces Partiful and Secretparty
with no party attached.
*Proof: a real group with real members gets a real invite and people sign up.*

**Phase 2 — one link.** The event page becomes the party when the party is
live, and the timeline reconciles between the Mac's LAN wall and the cloud. The
guest page gets "join the group", recording the follow source.
*Proof: a photo posted on the venue Wi-Fi and a photo posted the next morning
sit in the same timeline, and a follow taken at the party appears in the member
list.*

**Phase 3 — tips.** The DJ's own payment link on day one; Stripe Connect with
deferred onboarding behind it.
*Proof: money reaches a DJ's bank account.*

**Phase 4 — tickets.** Price, capacity, codes, the door view, refunds.

**Phase 5 — merch.** A link out, on the group page and the party page.

**Pro** lands whenever its payload is decided; it is independent of the above.

## Open decisions

1. Sign in with Apple only, or Apple plus Google for members?
2. The Pro payload, given branding is dropped.
3. Our percentage on tickets, and whether tips are 0%.
