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

**DECISION:** Apple only, or Apple plus Google for members who want an account?

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

### Two tiers, as Partiful ships them

Checked 2026-08-06. The only zero-setup path anywhere is "pay the host's own
handle", and it is exactly the path where the platform verifies nothing and
takes nothing. Luma, Eventbrite, Posh and DICE all run Stripe and all ask the
organizer who they are.

- **Chip in** — the DJ's own Venmo, Revolut or PayPal handle, displayed. No
  onboarding, no liability, no cut.
- **Tips and tickets** — Apple Pay in the browser, our cut, Stripe behind it.

Most DJs start on the first and move to the second the night someone tips them
$60 and it stops being theoretical.

### Onboarding is deferred to cash-out

Stripe supports charging before a connected account is verified and
transferring once it is. So the DJ turns tips on and does nothing else: guests
pay, our cut comes off, the balance builds under their name, and the identity
form appears the first time they tap cash out — with money already waiting.

The floor underneath is not a product choice: paying a human being requires
their name, date of birth and a destination. That is KYC law. We control only
when they are asked.

### Holding and payout

Funds are **held until after the night**, as Eventbrite, Posh and Partiful all
do, to cover refunds and chargebacks. Only Luma pays as sales land, and Luma
is not selling club nights.

Unclaimed money: hold 90 days with reminders, then refund the guests.

### The fee model: all-in, buyer pays

The DJ receives the face value. Everything — our cut and the processing fee —
is added on top and shown to the buyer as one number, which is how Posh and
DICE do it.

Worked, on a $20 ticket with our cut at 5% and Stripe at 2.9% + 30¢:

```
DJ receives          $20.00
our cut (5%)          $1.00
Stripe                $0.94
buyer pays           $21.94   (9.7% on top)
```

**This is the number to argue about.** At 5% we land at 9.7% all-in, which is
Posh's 10% — cheaper, but not visibly. At 3% the buyer pays $21.52 (7.6%); at
2%, $21.31 (6.6%). Being obviously the cheap one is a positioning choice, not
an accident.

Tips are worse, because the 30¢ is fixed: a $5 tip at 5% costs the guest $5.71,
which is 14% on top. Either the suggested amounts start higher, or tips carry
a smaller cut, or the DJ absorbs it.

**DECISION:** our percentage on tickets, and on tips.

### The Apple boundary

Two rails, deliberately separate. Anything sold to a **guest** — tips, tickets,
merch — happens in the guest's browser: real-world services, outside in-app
purchase, and the guest is not using our app at all. Anything sold to the **DJ**
as a feature of the app is IAP: `fm.partyparty.app.pro.lifetime`,
non-consumable, $99, already created and sitting in `MISSING_METADATA` until a
purchase screen exists to screenshot.

The Mac app may show a total. It must never take a payment that isn't IAP.

**DECISION: does Pro exist at all?** Branding is dropped and remote listening
is not a feature, which leaves the custom party link name as its only content —
thin for $99. The alternative is cleaner: no Pro, no IAP, and the business is
purely a cut of the money DJs make. The IAP is already created and can sit
unused in `MISSING_METADATA` indefinitely without harm.

---

## Free and paid

Free, permanently, no caps: the party, the group, the members, the events, the
signups. No member limit, no event limit. A cap on the thing that fills the
room would cost more in trust than it earns.

Paid is money: our cut of tickets and tips. The Pro unlock is now questionable
enough to be a decision rather than a plan — see Part 3.

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

**5. Tips.** Chip-in on day one; Stripe with deferred onboarding behind it.
*Proof: money reaches a DJ's bank account.*

**6. Tickets.** Price, capacity, codes, the door view, refunds.

**7. Merch.** A link out, on the group page and the party page.

**8. The Store.** Submission once macOS 27 is released and a Store package can
be built on a released host. Pro only if it survives its decision.

---

## Open decisions

1. Sign in with Apple only, or Apple plus Google for members?
2. Our percentage on tickets, and on tips.
3. Whether Pro exists at all, now that its content is down to one name field.
