# One app, shown in the Mac

Two owner decisions, 2026-08-08:

1. **The Mac and the web are the same experience, and the Mac additionally
   streams music.** Not "similar" - the same pages.
2. **Groups are dead. There are only parties.**

They are one body of work, and the second comes first: the proxy below would
otherwise be built against a model that is about to move.

## Groups are dead

A party belongs to a PERSON. That is the whole change, and most of the product
already believes it - `posts`, `signups`, `tickets` and the entire tracker are
keyed by event, and the two Mac call sites that looked up a group were only ever
trying to reach the person behind it.

What a group carried goes to the obvious place: its name, picture and bio are
the person's profile, which already exists and is already shared by both
clients; its parties are the person's parties; its feed is the party's own.

The address stays `/@handle/<slug>`, but the handle is the PERSON'S @name rather
than a group's. That is what the owner meant by "it doesn't seem to understand I
have the username shokunin", and what put a Mac's parties in a forgotten side
project called "early testers".

Sequence, each landing green on its own:

- **G1 - ownership.** `events.owner_email`, backfilled from the group's owner.
  Creating, reading and listing a party all key on the person. `/@handle`
  resolves through `profiles`, with groups as a fallback while both exist.
- **G2 - the pages.** `/@handle` becomes the person: their profile and their
  parties. `/manage`, group covers and the group feed retire into the party
  pages that already do that job.
- **G3 - the tables.** `groups`, `group_djs`, `group_members`, `group_handles`
  leave the read path and the dead code goes with them.

Following is NOT deleted by this. Following a person is a real idea and the
reason Seth wants any of it; it simply stops being "membership of a group".

## Why not two UIs

The console was never a variant of the web app; it is a different app that
happens to be about the same thing. It has no home at all - it *is* one party's
page. Creating a party was `prompt('What is the party called?')` while the web
asked for a title, a date, a place and who is playing. Choosing one was a
`<select>`.

Every Mac bug fixed on 2026-08-08 was drift between the two:

- the booth's rename changed only that Mac's copy, so a party ended the night
  under two names
- the Mac was bound to a GROUP while the web knew accounts, so signing in asked
  which group to link to
- the sign-in door promised a browser it never opened

A second implementation of one product produces these forever. So there is one
implementation, and the Mac shows it.

## The shape

The console keeps loading from the LOCAL server - same origin as its own API,
which is what makes the streaming layer possible without CORS, mixed content or
a message bridge for every call. The local server fetches the real pages from
partyparty.party and serves them, with the Mac's layer injected.

    WKWebView -> http://127.0.0.1:<djport>/  ->  partyparty.party/home
                                                  (+ injected Mac bar)

Three parts:

1. **A session for a linked Mac.** The pages authenticate with a `pp_s` cookie;
   the Mac authenticates with an install credential. `/api/v1/install/session`
   trades the second for the first, because the install is already proven to
   belong to the account. Without this the proxy has nothing to fetch pages as.

2. **The proxy.** DJ-only (`isDJ`), loopback only. It forwards the console's
   requests to the platform with that cookie and returns the page. Guests never
   reach it: they are on :8443 with the guest page, which is untouched.

3. **The Mac layer.** Injected into the proxied page: capture source, Go Live,
   the QR, LAN state. It calls the local API directly because it is the same
   origin. It appears on a party page and nowhere else - the Mac's only
   difference from the web is that a party can start playing.

## Offline

The pillar is that a party runs with zero internet. Nothing here weakens it,
because **listing and creating parties already needs the internet**: parties
live in D1 and the Mac proxies every read. Offline, the console could not show
them under any design.

So when the proxy cannot reach the platform, the console falls back to the local
room view - the page that runs a party, which is what offline needs and all it
ever needed. The fallback is a real state with its own copy, not an error.

## What must stay true

- The guest page is untouched. Guests scan a code and listen; they never sign
  in and never see any of this.
- Audio is untouched. Nothing here goes near capture, the ladder, or playback.
- No Mac-only party. There is one canonical row; a broadcast is temporary state
  attached to it.

## The journal

Owner, 2026-08-08, on what an event page IS: "the name of the event, the place
and date. I don't need the time." Plus who was there, who played, what they
played, notes and photos. Nothing else. The bar for the input is Apple's
Journal - "you are not done until it feels like a journaling app from Apple
that they would feature for a design award".

Shipped so far (`3d6ae95`): a party is a DAY with today already filled in and
the hour never shown; songs, which had nowhere to live at all; `visibility`
(private / link / public) with everything private by default; and following
became person-to-person, private by default, with every group follower carried
across.

## The only job

Owner, 2026-08-08: "I'm at this party. I saw DJ 1, 2 and 3. They played song
XYZ. I attended it with friend A, B and C." That sentence is the product. The
Mac additionally streams; nothing else is in scope.

Judge every change against typing that sentence. It currently takes: open the
party, type three names in one box, two in another, the tracks in a third.
Three actions for four clauses.

What would take it to one: a single capture line at the top of a night that
routes what you type - names to people, quoted or "played" phrases to songs -
so the whole sentence goes in at once. That is the next real step and it is a
parser, not a layout change.

Still unexamined at Apple-Journal quality: /people, the visitor view on a phone
(checked in HTML, not in a screenshot), and every empty state on home.

## Status

- DONE `8000254` - creating a party means the same thing from either client.
- DONE `a0e18c5` - G1, a party belongs to a person.
- DONE `051b586` - G2, /@handle is a person; photos and words moved onto the
  night; tips and merch moved onto the profile.
- DONE `3d6ae95` - the journal model: day-only dates, songs, visibility,
  person-to-person follows.
- DONE `33aada9` - G3, parties are found by whose they are. The group tables
  are out of the read path.
- DONE `01e5354`..`0dfe6ec` - the design pass, screen by screen: the event page
  as a record rather than a poster with a diary stapled on, home as a timeline
  of nights, /people with faces, a person's page, and starting a night as one
  field. Each one checked in a 375px screenshot, not in the HTML.
- DONE, this branch - the Mac unification, in full. `/api/v1/install/session`
  hands a linked Mac its owner's own web session; the server fetches the
  person's real pages and serves them on its own origin; and the console became
  a SHELL around them - capture source, Go live, join code, listeners - after
  the owner put the two side by side and said "they are completely different".
  1,530 lines of the console's own event page came out: poster, title and cover
  editors, profile fields, feed, link editor, moderation, reactions. What is
  left is the room, which is the one thing the web cannot do.

- DONE, this branch - the three seams the surgery left, and the three product
  pieces that were still open:
  - The event folder is back, in Settings beside the diagnostics logs.
  - The frame and the party picker are one choice; `roomSlug` is the guard
    against them bouncing, and the test proves it is load-bearing.
  - 25,918 bytes of dead CSS, removed by deleting proven-dead byte ranges
    rather than rewriting the sheet, and checked against the real server.
  - **One line writes the whole night.** `parseNight` reads
    "saw Ada and Bo, played Windowlicker by Aphex Twin, with Cy and Dee" into
    two DJs, one song with its artist, and two guests - one field, one return.
    A bare list still means whatever the buttons say; the parser refuses to
    guess, and there are tests for the refusal.
  - The place defaults to where you were last, the way the date defaults to
    today, and survives a validation error.
  - Somebody holding the link can say "I was there" on a night that already
    happened. Private nights have no such door. Verified at 375px.

## What the night takes now

The capture line is gone. Owner, 2026-08-09: "I really hate that input field...
we should just delete that field." Each list has its own way in, and the list
you type into answers the question the line used to ask:

- **Who played** - a field and a `+` in the sidebar. Going live adds you.
- **Who was there** - the same, and a named listener is recorded automatically.
- **Track list** - a title, "Title by Artist", or a Shazam screenshot. Shazam
  fills it in while the set runs.

## Where things are

The Mac is a shell: capture source, Go live, join code and QR, with the web's
own pages in a frame and the night's people in the sidebar beside the QR
(`/@handle/slug/rail`). One implementation of every page, shown twice.

## Permission

Not how far the page reaches - how far the CONTENTS reach. Following opens the
page; the setting opens what is in it. `public` / `followers` / `named`, all of
it through `whoSees()`.

## STILL OPEN

- **The one-line capture is not coming back.** It was built, used, and deleted
  by the person who asked for it; a field per list beat a parser.
- **Unproven live:** Shazam into the track list, and listeners becoming
  attendees. Both have tests; neither has run through a real set, which needs
  somebody broadcasting music.
- **A Mac release.** Everything is landed and deployed; nothing has shipped to
  TestFlight or the App Store, which is the owner's decision.
