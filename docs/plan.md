# Throwing a party should be one thing

## What it's like now

You want to throw a party. So you make a flyer somewhere, an invite on
Partiful, post it to a WhatsApp group, chase the people who didn't see it,
answer "what's the address?" thirty times, put someone on the door with a list
on their phone, plug a laptop into whatever speaker is there, and afterwards
beg everyone for the photos that ended up scattered across forty camera rolls.

Five tools. None of them know about each other. You have no idea who actually
came. And the next time, you build the whole thing again from scratch — because
Partiful forgets you, and the group chat is the wrong shape for the people who
came but weren't in it.

That is the thing to fix. Not invites — those are solved and given away free.
The mess *between* the tools.

## What it should be

**You make the party.** Name, when, where, a picture. One screen. You get a
link.

**You invite the people you already have.** Not the first time — the first time
you paste some emails and drop the link in the group chat. Every time after
that, the list is already there, because it is made of the people who actually
turned up, not the people who once clicked going.

**They say yes without becoming a user.** No app, no account, no password. A
link in an email or a message, one tap, done. Anyone who *wants* an account can
have one; nobody needs one.

**The day arrives and you stop being an information desk.** Everyone going gets
the address and a nudge, automatically. You are not answering messages, you are
getting ready.

**At the party, the same link is the party.** People scan the QR and the music
is on their phones — locked screens, headphones, the kitchen, the smoking area
— with no Bluetooth speaker fight and nothing to install. They post photos and
they land on the wall, not in a void.

**The next morning the photos are already yours.** All of them, in one place,
because they were posted to the party and not to a camera roll. Yours to keep,
yours to share if you feel like it, nobody else's to see.

**And you know who came.** Not who RSVP'd — who was in the room. That list is
the thing that makes the next party one button instead of an evening's work.

**Press the button. Same people, new date.**

If you also want to sell tickets or take tips, that is a toggle on the first
screen, and the money goes to you.

## What this does not touch

The music is finished work and this plan is built around it, never through it.
Nothing here changes how audio is captured, segmented, scheduled or played —
not `internal/broadcast/`, not `internal/schedule/`, not the capture helper,
not the player in `web/listener.html`.

Two steps get close, so the line is worth stating:

- **Step 1** changes which address the join page tries before a guest is in the
  room. It never touches how audio is fetched once they are.
- **Steps 4 and 5** put a timeline and a tip button on the guest page — the same
  page as the player. They go *around* it: no change to the player's code path,
  and the guest-page tap test fails on any console error, which is how a stray
  edit gets caught.

If anything here starts to look like it needs a change to the streaming path,
that is the signal to stop and ask. It is not a thing to work around quietly.

## What that means we build

The party engine already exists and ships: guests scan, hear the set at three
seconds on locked phones, post to a wall, all with no internet in the building.
Everything above is what surrounds it.

**Three objects, and no more.** A **group** is you and the people who come to
your nights — one handle, one page, `partyparty.party/@handle`. An **event** is
one night in it. A **member** is an email and a name; sign-in with Apple or
Google is offered and never required. That is the entire model, and the group
is what makes the second party easier than the first.

**One link for the whole night.** `@handle/<event>` is the invite before, the
room during, and the photos after. Away from the venue it shows the timeline
and no player — the music is for the people who are there. A second link would
split the night's memory in half and double what you have to explain.

**Don't reinvent it.** Most of this was built once and removed in `f44e796`.
`f44e796^` still has the schema, eleven migrations and `docs/auth.md`: users,
sessions, provider tokens, profiles with handles, the device-link flow that
binds a Mac to an account, follows, event guests, and `live_installs` with its
heartbeat and expiry. Recover that. Change one thing: it was built around a
single DJ profile with accounts bolted on afterwards, and the group is the root
object now. Never bring back `event_sets` — that whole schema exists to publish
set recordings, and we do not record the music.

**The money is yours.** Tips and tickets run through the thrower's own PayPal
or Stripe. We never hold it, never pay it out, never sit between you and it —
so there is nothing to onboard beyond connecting an account you already have,
and refunds are yours because the party is yours. We take 0% of tips and 5% of
tickets; **Pro at $12/month or $99/year** takes nothing at all. On a $20 ticket
your guest pays $21.94, or $20.91 on Pro. Posh charges them $22.99.

## The order

1. **The party link keeps working when a DJ leaves.** Today the join page holds
   one Mac's address; when that Mac goes, nobody new gets in. Live Macs already
   publish their own addresses, so the page should get all of them and try each.
   No new DNS. *Proof: the host leaves mid-party and a new guest still joins.*

2. **Field tests.** A real iPhone on a wildcard cert, and a venue whose Wi-Fi
   can't carry the room falling back cleanly. Needs a venue and real phones.

3. **The group, the event, the yes, the reminder.** The whole thing above,
   standing without a party attached — which is already a complete replacement
   for the five-tool mess. *Proof: a real group gets a real invite and real
   people say they're coming.*

4. **The link becomes the room.** The event page turns into the party while it
   is live, and photos posted on venue Wi-Fi and photos posted three days later
   land in the same place. *Proof: exactly that.*

5. **Tips**, then **6. tickets**, then **7. merch** as a link out. *Proof of 5:
   money reaches someone's own bank account without passing through ours.*

8. **Pro, then the Store.** Subscription on the web, then in the app with one
   entitlement across both. Submission waits for released macOS; a Store package
   can't be built on a prerelease SDK.

## How it's actually made

A second Worker (`partyparty-app`) so a platform deploy can never break a live
party — the existing Worker keeps certificates, DNS and relay untouched. Group
handles must be reserved in the broker's existing collision guard
(`broker/host/`, `broker/join/`, `broker/slug/`) or two owners eventually get
the same name, and a one-word custom link needs `JOIN_NAME_RE` widened. Email
is MXroute, sent from the origin box rather than from Workers, with one-click
unsubscribe. Turnstile on the join form, because an open email box on a public
page gets harvested. Posts carry ULIDs so an offline Mac mints ids that never
collide, and sync drains through the outbox when there's internet. Photos
always sync; video only afterwards, over the DJ's own connection.

Verified by a smoke suite for the new Worker, Playwright over the pages, and a
Go contract test for offline-then-drain. A step is done when its proof happened.

## Needed from you

The field tests, and Apple and Google credentials — a Services ID with Sign in
with Apple plus its key, and a Google OAuth web client. Secrets go in with
`wrangler secret put`, typed by you. Everything else can start now, beginning
with step 1, which depends on nobody.
