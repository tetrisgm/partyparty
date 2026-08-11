# PartyParty.party handoff

## Direction (2026-08-10, refined same night): a check-in journal that reads everything it may

The owner, after the Shazam import reconstructed eighteen nights: build toward
Foursquare's check-in, for parties. "I'm here" / "I was there" - the app names
the club (disambiguating neighbours), the party, and the people you were
probably with, the way Partiful suggests whoever you last partied with. The WEB
APP is the product surface; the Mac app stays about streaming. The check-in
moment is a PHONE moment and the phone surface already exists:
partyparty.party in mobile Safari, navigator.geolocation, one tap. No iOS app.

Refined the same night, two owner directives:

- **Leverage the MAXIMUM data Apple permits.** Calendar, photos, mail,
  messages, location - "look at all sorts of things that could allow us to
  infer more than just Shazam gives us... extremely helpful and necessary."
  The earlier plan ranked these too timidly.
- **The retroactive side is a BACKLOG** - a standing, reviewable queue of
  candidate nights: confirm "yes I was at a party that day", correct the place
  or the DJ or anything, or skip it - and a skip is remembered, never
  re-suggested.

The rule that makes data-maximalism sane: **everything parses ON the Mac; only
conclusions leave it.** The Shazam reader already works exactly this way - the
library never leaves the machine; titles, nights and venue keys do. Every
source below inherits that rule: raw calendar entries, mail bodies and photos
are never uploaded, only the inference ("party named X, venue Y, day Z,
probably with A and B").

The scanner's sources - the full Apple sweep (owner, third pass: "literally
think of all of the Apple offering... what apps or data does Apple give us
that we could leverage to infer the party." Wi-Fi SSID dropped by owner
decree). Grouped by the door Apple actually gives:

*Tier 1 - sanctioned frameworks, App-Store-clean, one prompt or none:*

- **Calendar** (EventKit, one prompt). Titles are often the party's literal
  name; `EKStructuredLocation` carries venue GEO; ATTENDEES are who was
  there; subscribed ical feeds (RA, ticketing "add to calendar") land here
  too. The richest source after Shazam.
- **Photos** (PhotoKit, one prompt). Geotagged timestamps are attendance
  evidence people never Shazam; the screenshot media subtype finds ticket
  screenshots directly; SHARED ALBUMS name their other contributors - who was
  there; a Live Photo carries three seconds of AUDIO - the music in the room,
  matchable locally. The same photos are candidate wall content.
- **Maps** (MKLocalSearch, NO prompt). Point-of-interest search with the
  nightlife category turns a coordinate cluster into a real venue NAME -
  "Public Works", not "195 Erie St". Upgrades unit 1 immediately.
- **Contacts** (one prompt). Names become people records with faces.
- **Mac location** (one prompt). Venue resolution at go-live.
- **MusicKit** recently-played (one prompt). Weak and mostly negative space -
  a gap in your own listening on a Saturday night is itself a signal. Low.
- **WeatherKit** (no prompt). The night's weather as journal color. Garnish.

*Tier 2 - local stores on this Mac, through the doors the Shazam reader
proved (user-selected folder grants; macOS's per-app data consent). Desk
build first; the standalone lane exists if App Store review balks:*

- **Mail.** Ticket confirmations (name, venue, lineup, date); .ics invites;
  .pkpass attachments (see Wallet below); PAYMENT-RECEIPT emails - a Square
  receipt from the venue bar is an attendance receipt with the venue's name
  on it; image attachments OCR'd by Vision. All parsed locally.
- **Downloads.** The same parsers over ticket PDFs, .ics and .pkpass that
  never went through Mail.
- **Messages.** The group chat that lit up at 1am; chats are often NAMED
  after the crew. "Who was with you" evidence.
- **Safari history.** The RA/Dice event pages visited that week say which
  party you were eyeing. Low rank, same door.
- **Notes.** Occasionally a lineup or an address. Lowest.

*Wallet, specifically (the owner asked):* the APP has no door on any platform
- PassKit lets an app read only passes it added itself, and macOS has no
Wallet at all. But a .pkpass is a zip with `pass.json` inside, and tickets
arrive as mail attachments and downloads BEFORE Wallet ever sees them - so we
intercept at the source. It is the best-structured evidence that exists:
event name, venue, start time, and the venue's COORDINATES, because
lock-screen relevance requires them.

*Tier 3 - no door; named so nobody wonders again:* Significant Locations and
CLVisit (iOS-only), Find My friends, Apple Pay transaction history, Health
(macOS has no HealthKit at all - the 4am bedtime lives on the phone), Screen
Time, Siri's own inferences, and Journal ENTRIES. Worth knowing:
**JournalingSuggestions** (iOS 17.2+) is Apple shipping our exact inference -
"you were somewhere with music, want to write about it?" - as an API,
iOS-only. It validates the product, and it is the one real argument for a
someday-tiny iOS companion. Until then, **Shortcuts** covers the phone hook
today: a personal automation "when I arrive anywhere after 10pm, open
partyparty.party" can be handed to users as a pre-built shortcut.

**The iPhone cut (owner, fourth pass: "restrict this to the things we would
be able to do on an iPhone without being rejected by Apple").**

On iOS the Tier 2 doors DO NOT EXIST. There is no cross-app file access of
any kind - no folder grants, no per-app data consent, nothing to point an
open panel at. Mail, Messages, Safari history, Voice Memos, Downloads:
unreachable by any app Apple would approve. What iOS gives instead, all
review-clean:

- **Location, WHILE-USING ONLY (owner decree, fifth pass).** No Always
  prompt, no background monitoring - which rules out CLVisit and geofences
  (both are Always-only). Check-in is an ON-OPEN moment: open the app, one
  fix, "At Public Works?". The arrival hook without Always still exists twice
  over: the user's own Shortcuts automation ("when I arrive, open
  PartyParty") runs on Shortcuts' consent rather than ours, and
  JournalingSuggestions hands over Apple's own already-collected visit
  history with NO location permission at all - making it the backbone of
  retroactive presence on iPhone.
- **JournalingSuggestions** (iOS 17.2+) - the packaged inference itself:
  visits (with place names), music-detection moments, photos, contacts -
  surfaced through Apple's picker, no location permission involved. Needs its
  entitlement, which Apple grants to journaling apps - which this literally
  is. With While-Using location, this is the single most important iOS
  source.
- **A share extension** - the sanctioned replacement for mail scanning: share
  the ticket email, the .pkpass, the screenshot, the RA page INTO PartyParty.
  One gesture, user-initiated, and it feeds the same evidence parsers.
- **The forward address** - the TripIt move, and it works on ANY phone:
  forward a ticket email to tickets@partyparty.party and the platform parses
  it - name, venue, lineup, the .pkpass attachment. THE mail answer for an
  iPhone-only user; the receiving plumbing is an implementation choice made
  at build time.
- The same one-prompt frameworks as the Mac: EventKit (titles, attendees,
  structured geo), PhotoKit (shared albums, screenshot subtype, Live Photo
  audio), Contacts, MapKit POI (no prompt), MusicKit, WeatherKit.
- **Live Activities** once checked in: the night on the lock screen while it
  runs. (The geofence-fired lock-screen ask died with Always location.)
- **ShazamKit live recognition while the app is open** - there is no
  background microphone on iOS, ever, so never promise it. SHLibrary history
  if the entitlement fight resolves.

Gray - defensible, not load-bearing, hold until the core app is approved
once: HealthKit sleep/steps as journal colour (guideline 5.1.3 wants clear
relevance; a lifestyle journal arguably has it); MultipeerConnectivity
presence between PartyParty users at the same party (clean API, belongs to
the network stage).

The split this forces is the architecture, and it loses nothing: **the
iPhone is the LIVE limb** (presence, the ask at the door, share-ins), **the
Mac is the DEEP scanner** (Mail, Messages and Voice Memos all sync to the
Mac, and Apple permits reading them THERE), **the web is the record**. A
Mac-owning user keeps every Tier 2 source - read on the machine where the
doors exist. An iPhone-only user trades the deep history for the best live
experience.

Review risks, named: the JournalingSuggestions capability request, and the
standing SHAZAM_KIT entitlement fight - which has to be resolved with Apple
on any platform. (Always-location left the list with the owner's While-Using
decree; nothing riskier than a While-Using prompt remains.)

**The backlog** (the spine of the retroactive side):

- The platform keeps candidate nights per (owner, day): merged evidence -
  n Shazams, calendar title, n photos, venue key, suggested people - and a
  state: pending / accepted / dismissed. Dismissed is durable.
- /home renders pending candidates as cards: Accept (the night is created or
  updated, and from there it is an ordinary night page - place, DJs, anything
  editable as always), edit-in-card first, or Skip.
- **The console gets the identical experience for free** - it shows /home in
  its frame. This is the unification dividend: "the Mac offers the same as
  mobile" costs zero Mac UI, which is also how the Mac stays about streaming.
- A live check-in is just a candidate born accepted.

Units, v2 order:

1. **Venues become records** - `venues` keyed by rounded (~100 m) coords,
   `events.venue_id`, `place` stays as display text. Naming once names all
   nights there, past and future; import and go-live resolve automatically,
   and MKLocalSearch's nightlife category proposes the real NAME, not the
   street address.
2. **The backlog** - the queue, its states, the /home cards. The settings-page
   import becomes a scanner that fills it.
3. **Scanner expansion: Calendar + Photos** (+ Contacts, location) - the
   one-prompt sanctioned sources, feeding names, venues, attendees and photo
   evidence into the backlog.
4. **"I'm here"** - phone-web check-in: location tap -> nearest venues ranked
   by own history -> confirm -> tonight exists, entering the same pipeline.
5. **People suggestions** - co-attendance x recency x same-venue chips on
   check-in and creation; enriched by Contacts, later Messages.
6. **Deep sources** - the Tier 2 stores (Mail with .pkpass/.ics/receipt
   parsing, Downloads, Messages, Safari history), the venue's
   own page (URL on the venue record, parsed generically for schema.org Event
   JSON-LD), and other users' PUBLIC nights at the same venue and date (the
   network answer; designed now, worth more with every user).
7. **Series** - same venue + cadence + recurring people => "these six
   Saturdays at Public Works look like one series - name it once?"; nights
   inherit, new check-ins default in.

Privacy line: events store venue ids, venues store rounded coordinates, a raw
GPS fix is never persisted, and raw source content (calendar entries, mail,
photos) never leaves the Mac - inferences only. Per-night contents permissions
are unchanged by all of this.

Nothing below this section is started. Units land one at a time, whole,
beginning with 1+2 on the owner's go.

## Current position (2026-08-10): the DJ's own Shazams find their party

The in-app recognizer only ever hears what THIS Mac broadcast. A DJ Shazams all
night on their phone as well, and every one of those was lost to the party it
happened at. `SHLibrary` (macOS 14+) is the read side of the same account, and
`SHMediaItem.creationDate` is what makes it usable: without a date a library is
a pile of songs with no night attached. The older `SHMediaLibrary` is write-only
and deprecated - it can add a match and nothing else.

Three parties, each doing the one thing only it can:

- **The app reads it** (`app/Sources/PartyParty/ShazamLibrary.swift`), because
  ShazamKit authenticates by code-signing identity and the Go server has none.
  It also decides which NIGHT each match belongs to, because only it knows the
  DJ's timezone - and that a Shazam at 01:30 belongs to the evening before, so
  the night rolls over at 06:00 local rather than at midnight. It reads on the
  console's `ready` message and again on `shazamRead`, and pushes to
  `POST /api/shazam/library`.
- **The server holds the snapshot** (`internal/server/shazam.go`). `read` and
  `count` are separate on purpose: "your library is empty" and "nobody has
  looked yet" are different things to tell somebody waiting for a button.
- **The platform files them** (`/api/v1/shazam/import`). It looks each match up
  by day - `starts_ms` is noon UTC for a day-only party, so no timezone enters
  into it - and merges with what the live recognizer already caught. A day can
  hold two parties (a night and the after); the one that actually ran a room
  wins, and the preview names the night either way.

`preview: true` is a real dry run through the same code path and writes nothing.
Running the import twice adds nothing. Matches on days with no party are
counted, not dropped somewhere convenient.

**It reads the store, not the API. 2026-08-10.**

`SHLibrary.default.items` returns an empty array on a Mac holding 898 matches.
Not an error - there is no error channel on that property, so empty is the only
failure it can express. Ruled out by test, each one: the sandbox (an unsandboxed
binary returns 0 too), a cold-load race (twelve retries over five seconds), and
signing.

Signing was nevertheless real and is now fixed. An ad-hoc build never reaches
Shazam at all - `shazamd` does not launch and there are zero Shazam log lines. A
build signed with a Mac Development profile launches it and gets a CloudKit zone
subscription of its own under
`~/Library/Caches/com.apple.shazamlibrary.cloud/fm.partyparty.app/`, and still
reads nothing. The App ID carries `SHAZAM_KIT` (`asc bundle-ids capabilities
list --bundle YPMR3HYD9L`), but no profile generated from it grants a ShazamKit
entitlement - checked on a fresh MAC_APP_DEVELOPMENT profile AND a fresh
MAC_APP_STORE one, byte-identical lists - and a binary that claims
`com.apple.developer.shazamkit` anyway is SIGKILLed at launch.

So the read is `app/Sources/PartyParty/ShazamStore.swift`, straight from
`~/Library/Application Support/com.apple.shazamd/ShazamLibrary.sqlite`
(`ZSHTRACKMO`; `ZDATE` is Core Data epoch, `+ 978307200` for Unix). Owner's
decision: "you were able to tell me what I've recognized from Shazam recently
anyway, so that means you have access to the information and that's all we
need." The cost is a private path with no stability promise; if macOS moves it
the read returns nothing, the console says the library is empty, and nothing
else in the app notices.

Three things that shape the implementation:

- **The sandbox redirects `~`.** `NSHomeDirectory()` is the container, so the
  path is built from `getpwuid`, and the file is reached through the one
  sanctioned route: the DJ picks the folder once from a panel that opens on it,
  and a security-scoped bookmark makes it permanent. `files.user-selected` was
  already in the entitlements. Only the button may raise that panel - the
  console coming up must never throw a file dialog at somebody.
- **The store is WAL.** It is copied into our own space and read there. Opening
  the original read-only needs to write a `-shm` beside it, which read-only
  access forbids, and `immutable=1` skips the write-ahead log and misses the
  newest Shazams - the ones somebody is asking about.
- **Declining is its own answer.** "You said no" and "you have never Shazamed
  anything" render differently, because reporting the first as the second is a
  lie told to somebody who just declined on purpose.

**The import makes the nights it finds.** A years-old library against a
week-old party list gives "896 of these have nowhere to go", which is true and
useless - and the owner's ask was for the Shazams from "various events" that are
not in PartyParty at all. So the preview also lists days carrying five or more
matches and no party, and each becomes a party named after its date with those
tracks already on it. Ten or more starts ticked; the tail is shown unticked,
because eighteen of this library's 157 nights are obviously nights out and the
rest are a long dinner somewhere with music. Only the days handed to the route
are made, a day that already has a party is left alone, and a second run makes
and adds nothing.

Two bugs from that work worth keeping:

- `internal/cloudsync` is a TYPED pipe between the platform and the console. A
  field nobody declares there is dropped in silence: the platform sent
  `newNights`, the struct had no field, and the console rendered the useless
  answer while the right one sat one hop upstream. Both ends were correct alone,
  so looking at either proved nothing. `TestNothingThePlatformSaysIsLostInTheMiddle`
  asserts on the JSON the console receives, not on the struct.
- `"2026-13-45"` satisfies a `YYYY-MM-DD` regex, parses to NaN, and made a party
  called "Invalid Date". A date is real when it round-trips, not when it is
  shaped right.

Desk builds are now Apple Development-signed rather than ad-hoc: `PP_SIGN_ID`
plus `APP_STORE_PROVISIONING_PROFILE`, profile "PartyParty Mac Dev", expires
2027-08-10. Strictly better than ad-hoc regardless of Shazam.

**LIVE recognition still has the ShazamKit dependency** and no profile carries
the entitlement, so `SHSession` catalog matching is very likely dead in every
lane. The notes have said since 2026-08-05 that it was only ever "proven in
provisioned builds" with the next TestFlight build as the vehicle; there is no
evidence that verification happened. Worth settling before the next set.

**Where the app lives now.** `/Applications/PartyParty.app`, owned by the user,
built from `main` by `scripts/build-app.sh` and installed with `ditto`. There is
exactly one copy on this Mac.

It took a detour worth remembering. That path used to hold the TestFlight build,
which is root-owned and carries `com.apple.appstore.metadata`: SIP refuses `mv`
and `ditto` there whatever the shell's rights are, so an install can only ever go
to `~/Applications` while an App Store copy is sitting in `/Applications`. Only
the App Store or the owner in Finder can remove one - the owner did, and the desk
build moved into the normal place.

While both existed they shared bundle id `fm.partyparty.app`, and
`osascript -e 'path to application id ...'` both resolved ambiguously AND
LAUNCHED whichever it picked, which is how two copies ended up running at once.
Find and quit by PID from `pgrep -lf "PartyParty.app/Contents/MacOS/PartyParty"`.

**Import from Shazam lives on the settings page, not in the Mac's gear sheet.**
It went into the gear sheet first and the owner reported "there is nothing about
Shazam in the settings" - because the page called settings is the account one,
and an import that files a whole library into a whole account belongs there.

The shape that makes that possible is worth keeping: the console serves
`/settings` through its own server, so `/api/shazam` is same-origin from inside
the frame. The PAGE owns the markup (`shazamImport()` in worker.js), the Mac
lends the capability, and the console still injects nothing into a web page. The
section is `hidden` until a probe of `/api/shazam` answers, so on
partyparty.party it simply is not there. Asking for a fresher read goes
`window.parent.postMessage({pp:'shazamRead'})` to the shell, which owns the only
bridge to the app - a frame has none.

Three defects that only showed up by LOOKING at the rendered page: `.ghost` is
not a class this stylesheet has ever defined (it exists in `web/dj.html`, which
is a different sheet), so those buttons rendered as system chrome; a value in a
`<span>` inside `.eventfield` gets the uppercase LABEL rule and turned an
address into `DJ@EXAMPLE.COM`; and `.sectionhead` could not wrap, so a heading
and its hint became two four-word columns on a phone. Render the page and read
it. `cloudflare/app/test/smoke.mjs` now asserts all three.

**The frame's first load is the fragile one.** The console asks for `/home` the
instant it opens, which can be before the platform client is ready. The mirror
correctly falls back to `offlinePage` - but that page used to be a dead end, so
one unlucky second at startup left a signed-in DJ reading "cannot reach it right
now" for the whole session with partyparty.party up the entire time. It now
polls `/api/mirror` every five seconds while visible and reloads itself the
moment the answer is yes. `TestTheOfflinePageComesBack` fails if the page ever
loses its way back.

## Earlier position (2026-08-09): the night in the middle, the room down the side

The owner used the console beside partyparty.party and rebuilt the shape of it
in a dozen messages. Where it landed:

**The console is a shell around the web's own pages.** `web/dj.html` keeps only
what a Mac can do - capture source, Go live, the join code and QR - and shows
the person's real pages in a frame (`#webFrame`). `internal/server/mirror.go`
fetches them from the platform as the owner and serves them on the console's
own origin. There is no top bar and no party picker: whatever night the frame
is on IS the night the room is running, and the way home is the PartyParty chip
the page itself draws on the cover.

**The people live in the Mac's sidebar, beside the QR.** The platform serves
the rail on its own at `/@handle/slug/rail` and the console hangs it under the
invite code; the page is asked to leave its copy out with `?rail=0`. One
implementation, one stylesheet, shown where the owner wanted it. Its forms
carry `from=rail` so a post returns to the rail instead of opening the whole
night inside a 300px column.

**Who played is the DJs; who was there is the attendees.** Each list has its own
field and its own `+` - there is no third question after the name, and no
sentence parser (the capture line it existed for is gone). Going live lists you
as a DJ; a NAMED listener rides the heartbeat and is recorded as an attendee, so
the console keeps no second list of people. Unnamed phones are skipped.

**The track list writes itself.** ShazamKit has always run in the app; it now
carries what it hears on the same 20s heartbeat as the posts, deduped on title
and artist server-side. A track can also be a photograph - `songs.media_key`,
no title required, because at a party a Shazam screenshot is faster to keep
than a line to type.

**Permission is about the contents, not the page.** `whoSees()` is the only
answer to both questions and every read path asks it:

  public     anyone
  followers  people who follow you
  named      only the people you added to the night

Following opens the page - a follower sees THAT a night happened and who played
- and the setting opens the contents. A stranger gets 404. A party opened with
a live room on it is public from the first moment, because the people about to
be handed its address are in the room, not following the DJ.

**Nothing has to be expanded to be useful.** Who can see it is three buttons;
the day and the place are typed into the line under the name that shows them
(the picker hides behind "Sat 8 Aug"); the notes and the composer are open. The
delay/sync numbers are the one exception and sit behind Details, in a panel
that only appears while somebody is listening.

Three traps this file exists to stop the next session repeating:

- **Remove markup and its JavaScript together.** Twice today the console lost a
  block and kept the code that painted it, and `show()` threw on a missing
  element - which stops the frame steering entirely. `test-dj-console-shell.mjs`
  boots the real page and fails on any uncaught error; it caught both.
- **Land before deploying.** `wrangler deploy` runs from the canonical checkout,
  which only has what has landed. Deploying with the change still in the
  worktree ships the old code and then production disagrees with the source.
- **Measure, do not eyeball.** The remove-cover button was moved twice against
  the wrong neighbour and ended up exactly on top of the upload button, which
  made upload look deleted. `getBoundingClientRect` in the running app settled
  it in one call.

## Earlier position (2026-08-09): one line writes the whole night


The product's only job, in the owner's words: "I'm at this party. I saw DJ 1, 2
and 3. They played song XYZ. I attended it with friend A, B and C." That was
three separate actions for four clauses. It is now one:

    saw Ada and Bo, played Windowlicker by Aphex Twin, with Cy and Dee

`parseNight` read it. **It has since been deleted**: with a field per list, the
name typed into "Add a DJ" is a DJ, and reading "Bo with Cy" as a guest was the
app being clever at the expense of being right. Kept here for why it existed. A word opens a clause and
owns the text until the next word opens one - `saw`/`dj` for who played,
`played`/`song`/`track` for what, `with`/`w/` for who you were with. Quoted text
is a song wherever it appears. A leading list with no word after it is who
played, because that is how the sentence starts. `played by Ada` says who
played, not a song called Ada. One artist covers a whole clause. A full stop
separates thoughts, but not inside "Mr. Fingers".

**What it refuses matters as much.** A bare list - "Ada, Bo and Cy" - returns
`used:false` and the three buttons decide, exactly as before. Guessing there
would file people under the wrong heading, and there are tests for the refusal.
The sentence outranks the button: Enter submits via whichever button is first in
the DOM, so a person who wrote out what happened must not be overruled by it.

Two smaller things shipped with it. The place on a new night defaults to where
you were last, the same kind of harmless guess as today's date, from one
`lastPlaceUsed` so the error paths cannot answer differently. And somebody
holding a share link can say "I was there" on a night that already happened -
POST `/@handle/slug/here`, no account, a name is enough - which lands in the
owner's own record as a guest. Private nights have no such door, and who you SAW
still never appears on a shared page; only who PLAYED does.

All three verified in 375px screenshots, not in HTML.

## Earlier position (2026-08-09): one event page, shown twice

The Mac and the web are one experience apart from streaming. That is not two
implementations kept in step - the owner looked at the console beside
partyparty.party on 2026-08-09 and said "they are completely different", which
they were. There is now one implementation.

**The console is a shell.** `web/dj.html` keeps what only a Mac can do - the
capture source, Go live, the join code and QR, who is listening, permissions
and LAN state - and shows the person's real pages in a frame in the middle of
it (`#webFrame`, opening on `/home`). The frame is same-origin: this server
serves `/home`, `/people`, `/settings`, `/parties/...`, `/@...` and `/media/...`
by fetching them from partyparty.party as the owner (`internal/server/
mirror.go`) and handing them back. The session comes from
`/api/v1/install/session` - a linked Mac trades its install credential for its
owner's web session; nothing new is trusted, the install already belonged to
the account. The console holds that session rather than fetching one per page,
and remembers a failure for 30s.

**1,530 lines came out of dj.html.** The poster, the title and cover editors,
the profile fields, the party feed and composer, the link editor, the
moderation queue and the reaction panel were all the console's own copies of
things the web page already owned, and every one of them had drifted. Deleted,
with their CSS left in place (a purge of it broke Go live's styling and was
reverted - dead CSS is cheap, a dead button is not).

Three things that must not regress:

- **A Mac with no platform still runs a party.** Unreachable, or nobody signed
  in, and the mirrored paths serve a small local page saying so - never a
  redirect to `/dj`, which would load the console into its own frame, and never
  a hang or a 502. Covered in `internal/server/mirror_test.go`.
- **The mirror is loopback and DJ-only.** A guest on the venue Wi-Fi reaches
  none of it. Same file.
- **The console must not grow a second event page again.**
  `scripts/test-dj-console-shell.mjs` boots the real page in a real browser,
  fails on any uncaught error, and asserts that `titleEdit`, `profileName`,
  `djFeed`, `linkRows` and friends are absent. `test-stream-contract.mjs`
  asserts the same statically. That shell test replaces
  `test-dj-console-saves.mjs`, whose subject was the deleted editors.

The console's boot probe used to call any page without dj.html's `__ppBooted`
flag an error. It now treats a page that rendered as healthy; the field bug it
exists for is a WHITE window, and that is still caught.

## Earlier position (2026-08-08): the web is a personal party record

The web half changed shape. It was a place to PUBLISH a night, reached from the
Mac. It is now first a place to KEEP one, and it is useful with nobody else on
PartyParty at all - none of it needs the other people to have accounts.

`/home` is your parties, upcoming and past. A party page carries your own record
of it: went or not, a private note, who played, who you saw, and a note about
each of them from THAT night. People are reused by name, so typing "Seth" twice
is one Seth; `/people` and `/people/<id>` are the list and one person's whole
history. Everything private is keyed by the owner's verified address, and a
party page shows a signed-out visitor none of it.

Three things worth knowing before changing any of it:

- **Upcoming / on tonight / past is read off the clock** (`partyPhase`), never
  a field somebody flips. Six hours is a night.
- **"Playing right now" is a heartbeat, not a flag.** The Mac's timeline sync
  already ran every 20s while live and stopped when it was not, so it now
  carries the guest link and stamps `events.live_ms`; the page offers Listen
  for 90s past the last one and then stops on its own. A flag would still be
  saying "listen now" the next morning. The web LISTENS and never transmits -
  there is a test that fails on the word.
- **One party, two clients.** The web edit form and the Mac's `/api/party/edit`
  are the same `updateParty` on the same row. Renaming in the booth now carries
  up to the platform in the background (`pushPartyEdit`): it used to change
  only the Mac's copy, so a party with a page ended the night under two names.

Migrations `0009_people.sql` (people, party_people, party_notes) and
`0010_party_details.sql` (events.links, live_url, live_ms), both applied to
production D1 on 2026-08-08. There is no scripted deploy for `cloudflare/app`,
so migrations do not ride along with one: `wrangler d1 migrations apply
partyparty-app --remote` has to run BEFORE `wrangler deploy` in that directory,
or the home page and every party page fail on their first query.

DEPLOYED 2026-08-08: partyparty-app version 5a5ff09d, partyparty-site version
235ea835, and TestFlight build 268 (125.47), which is IN_BETA_TESTING for the
internal group.

Two App Store Connect facts worth not rediscovering: `asc builds upload` wants
the NUMERIC app id (6794880742), not the bundle id, and refuses a build number
already on the record - 267 was up, so the package had to be rebuilt as 268.
And an internal group cannot be added to a build at all ("Cannot add internal
group to a build"): internal testers get every processed build automatically,
so a VALID build with autoNotifyEnabled is already delivered. Only external
groups need `add-groups`, and those need a beta review submission.

A TRAP THIS SESSION WALKED INTO, now guarded: two workers share the zone, and
which paths belong to the platform is declared in `cloudflare/app/wrangler.jsonc`
rather than in the code that serves them. `/people` and `/parties/new` were
served by the app worker with no route pointing at them - which works perfectly
on localhost and 404s on partyparty.party, because the request is answered by
partyparty-site instead. Nothing request-level can see it; the tests call the
worker directly. A test now reads the two files against each other, and the
development doors must have NO route.

## Current position (2026-08-06, end): every step of the plan has code

`docs/plan.md` is the single plan, written from the person throwing the party.
Every numbered step in it now exists behind tests in the merge gate: 30 platform
tests, 10 broker tests, the Go suites and the Playwright pages.

- **1. The join link follows the party** (574fca3). Presence per live member
  under `broker/party/<id>/<install>`; the join page probes them all. No new
  DNS - live Macs already publish their own machine records.
- **3 and 3b. The platform** (a0306aa, 4556365, 8249c79, dcdd3c0): groups,
  nights, two-level membership, Apple and Google sign-in, invitations, the
  day-of reminder, the group thread with per-member volume, and calendars.
- **4. One link** (c8344b3, 8cc4908, f41c1a3): a party binds itself to
  tonight's night, and the wall and the event page are one timeline.
- **5. Tips** (259ddb4, f3ac560): the DJ's own link, and Stripe behind it.
- **6. The door** (7d917e3): capacity, entry codes, a list that needs no signal.
- **7. Merch** (652aeff). **8. Pro** (fdc8bca).
- **ppmail** (c7084b3) drains the outbox through MXroute from the origin box.

WHAT IS NOT BUILT, and why:

- **Step 2, the field tests.** A real iPhone on a wildcard cert, and a venue
  whose Wi-Fi cannot carry the room. Needs a venue and real phones.
- **The App Store half of Pro.** StoreKit in the Mac app and an auto-renewable
  subscription in App Store Connect - there is now NO in-app purchase product
  on the app at all: the non-consumable one was deleted on 2026-08-07 (owner),
  because Pro is a subscription and a lifetime unlock is not coming back. The
  entitlement row the App Store will write, and the union that reads it, are
  done and tested.
- **Media on merged posts.** A web post carrying a photo is not put on the LAN
  wall: the file lives in the cloud and this Mac cannot serve it to a guest on
  the venue network. It is on the event page.

SIGN IN WITH APPLE IS CONFIGURED (2026-08-07). Services ID fm.partyparty.web
against primary App ID fm.partyparty.app, domain partyparty.party, return URL
/auth/apple/callback; key 9DLLL4UAR8, whose .p8 the owner holds and Apple will
not reissue. Two things were missing that would each have failed silently: the
App ID had no APPLE_ID_AUTH capability, so PartyParty was not even offered as a
primary app; and no email source was registered, which means mail to a member
who hides their address behind Apple's relay would have bounced with nothing to
see. partyparty.party is now a registered source, verified by SPF. The key was
proven by signing a real client secret through the Worker's own
appleClientSecret path - ES256, correct kid, iss, sub and aud.

A correction to an earlier assumption of mine: the
.well-known/apple-developer-domain-association.txt file is NOT required for
Sign in with Apple web auth. The route is harmless and stays for other Apple
flows, and the check script now reports its absence rather than failing.

NOTHING IS DEPLOYED. No D1 database exists, `database_id` is blank on purpose,
no secrets are set, ppmail has no unit, and no Stripe account is connected.
Bringing it up is the owner's call and needs, in order: `wrangler d1 create`,
the five migrations, a Sign in with Apple Services ID and key, a Google OAuth
web client, `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, `OUTBOX_KEY`, and
a systemd unit for ppmail.

A LIVE BUG WAS FIXED ON THE WAY (8d4564d): every profile save in the DJ console
went through `button.click()`, and the click handler disabled the button for the
length of the fetch - so moving from the name field to the bio fired a save
carrying only the name, the bio's own save found the button disabled and was
DROPPED, and then the first save's reply overwrote the bio on screen. Type a
name, tab, type a bio, click away: gone, and never sent. Saves now serialize
through one queueing function, and hydration leaves alone any field whose value
has moved away from what the server last wrote. It surfaced as a "flaky" test on
the build runner; the runner was just slow enough to land in the window.

## Current position (2026-08-06): parties replace event folders; 125.47 (267)

The event model is gone. A PARTY is one night: `parties/<id>/`, resumed while
current, new after eight idle hours, empty ones reused so launching twice
leaves no litter. Its folder is a keepsake - guest uploads plus a static
`index.html` of the wall (posts, comments, media, setlist), with the journal,
guest names, thumbs and set reports hidden in `.state`. Old `events/<date>/`
folders migrate in with every byte kept. Set recording is REMOVED (owner:
the app should not keep a copy of the music); nothing had set RecordPath since
the LL-HLS rewrite, so it was dead capability, and a test now fails if an ADTS
tee leg reappears.

ONE PARTY PER WI-FI: peers advertise their party (id, name, cover, join link)
over the existing Bonjour + /api/peer probe, and a Mac going live adopts a live
peer's party instead of starting a rival - taking its id, folder, name and
cover, keeping its own DJ name and photo, and showing the HOST'S join link, so
the second DJ's QR is the first DJ's. A party with posts is never abandoned to
join another. The shared wall needed nothing: mergeRoomFeed already merged peer
posts and rewrote media URLs to the owning Mac.

Guests are no longer stranded when a Mac leaves: after ~20s of failed polls the
page re-homes to another member from the DJ reel it already holds.

Telemetry: every listener carries its own stall count and worst latency for the
set, shown in the console - "my phone or the stream?" is now answered by the
screen. Settings also shows the three permissions honestly (microphone has a
real API; system audio has none, so it offers Check, which attempts a tap; local
network has neither, so it offers only the pane).

NEW TEST GUARDS (both in `npm test`): `test-dj-console-saves.mjs` types into the
console and fails if a save never reaches the server;
`test-guest-page-taps.mjs` taps play, the sheets, the QR, a comment and a poll
outage on the guest page and fails on any console error. Both were verified
against the real bug before landing. Note for whoever writes the next one: the
stub's `appVersion` MUST match the served page or the page reloads itself
mid-test (its own stale-page refresh), which reads as a mystery timeout.

DELIBERATELY NOT DONE: the broker publishing an A record per live member so the
party link survives the host leaving. It rewrites production DNS for the live
domain, and getting it wrong points guests at the wrong Mac - it needs its own
pass with the Worker smoke test extended, not the tail of a long batch. Until
then a host who leaves keeps serving nobody new; guests already in are covered
by re-homing.


## Current position (2026-08-05, close): TestFlight 125.42 build 262

On top of the benched 3s buffer (below): 261 made the DJ profile stick
(auto-saves disarmed until hydration; /api/dj-profile is nil-means-keep) and
made track changes latch in ~15-20s via incumbent-veto matching. 262 adds
PARTY REACH in Settings - Wi-Fi only is the DEFAULT (owner decision: nothing
leaves the room until deliberately switched); Wi-Fi + cloud pushes the relay
whenever live+internet (relay.Manager Config.OnPush drives
contribute.SetEnabled; mode stays DIRECT for LAN guests), and an isolated
venue under Wi-Fi only reads NO PATH reason wifi_only instead of relaying
against the DJ's choice. The join bootstrap (Cloudflare Worker, DEPLOYED
ed831a0c) now health-checks the relay before handoff, shows an honest
"join the Wi-Fi" page, and re-probes every 8s + on online/visibility - a
phone that regains Wi-Fi converges alone. The QR is brand pink on both
renders with the DJ avatar badged center on the console (correction H).
Remote-listen test protocol: Settings -> Party reach -> Wi-Fi + cloud, go
live, open the join link on 5G.


## Current position (2026-08-05, end of night): 125.40 build 260 - the buffer, benched

The 3s cushion SHIPPED on the third attempt, done the way the contract now
demands. The July D=3 implementation was read as it actually shipped (commit
affebd3): EXT-X-START:TIME-OFFSET=-3.000,PRECISE=YES in the MULTIVARIANT
playlist, PART-HOLD-BACK at the honest 0.9 floor - both details load-bearing
(the same tag in the MEDIA playlist without PRECISE measures 25.00s from the
edge; AVPlayer applies the offset from the wrong end). Proven BEFORE upload
with the bench that is now the standard for any geometry change: a local
rewriting proxy (scratchpad/benchproxy.py) serves the candidate manifest
from the LIVE stream to a muted headless AVPlayer (scratchpad/soak.swift -
note the setvbuf: Swift print buffers into pipes, which hid the 258 verdict
once); ten minutes, 120 samples, 3.11s flat, zero backward movement; receipt
at build/soak-125.40-260.log. TestFlight: 260 is the only live build,
internal active, external submitted. Owner-side: update, one permission
prompt, and every phone should join at 3s and hold - venue blips inaudible.


## Current position (2026-08-05 night): TestFlight 125.39 build 259 - proven geometry restored

The evening's 3s-cushion attempt is REVERTED. Sequence: the owner decided
stability over immediacy (a fixed 3s room instead of the ~1s knife edge,
justified by the Shack15 A/B - a phone at ~2.6s heard none of the venue
bursts a ~1s phone heard). Implementation One (125.37, PART-HOLD-BACK=2.9)
was self-contradictory - parts only exist ~1.4s from the edge - and AVPlayer
audibly ROLLED A LISTENER BACKWARD, then parked it 24.8s deep. Implementation
Two (125.38, EXT-X-START:-3) left the owner's phone 27s behind; its exact
mechanism is UNDIAGNOSED (the muted-AVPlayer soak harness produced no output
before the phone found the bug - the harness itself needs a shakedown).
125.39 restores hold-back 0.9 / D=1.0 exactly as the successful afternoon
ran. Root failure, named in the reflection the owner demanded: geometry
changes shipped at app-fix tempo on green unit tests, which cannot hear
AVPlayer - the same lesson the sandbox/TCC/Shazam sagas taught earlier the
SAME DAY. AGENTS.md now requires a PASSING pre-upload soak (muted headless
AVPlayer, >=10 min, zero backward movement, stable at target, log kept) for
any playlist-geometry or positioning change; a soak after upload is theater.

The 3s decision STANDS as owner intent. Bench work owed: shake down
scratchpad/soak.swift (compile + attach never verified), read the JULY D=3
implementation as it actually shipped instead of paraphrasing it from
memory, find the mechanism AVPlayer respects for deep attachment, pass the
soak, then ONE build. Also parked: per-phone stall counters into /api/status
(proposed, owner receptive) - would have made tonight's phone-vs-stream
attribution instant.


## Current position (2026-08-05 evening): TestFlight 125.36 build 256

125.36 (256) is the only live build: recognition moved into the APP process
(the one ShazamKit-authenticatable identity - proven working live at Shack15
with real matches and artwork), match switching requires a 15s-apart repeat
so sound-alikes can't flap mid-song, plus the player polish round (waves
before chevron; sheet: no heading, no solo-DJ card, 128px cover row,
"N listening" pill by the play button). Shack15 re-test verdict: two 15-min
telemetry windows with ZERO stream gaps - the cutoff era is closed; the only
audible events were the permission-toggle rebuild and one phone-side Wi-Fi
rebuffer. Below, the 255-era record:

## Previous position: TestFlight 125.35 build 255

The sandboxed-capture saga is SOLVED, in three layers, each proven on this
Mac before shipping:

1. TOPOLOGY (the crash): an own-profile sandboxed child cannot be
   posix_spawn'd from a sandboxed parent — libsecinit SIGTRAPs before main()
   (crash reports land in ~/Library/Logs/DiagnosticReports and are whisked
   into Retired/ within a second). Builds 251-253 killed ppcapture this way
   on EVERY Go Live; the desk dev loop never showed it because its parent
   chain is unsandboxed. ppcapture is now app-sandbox + inherit exactly like
   the other helpers (verify-app-store.sh enforces it), keeps its own bundle
   id for LaunchServices hygiene, and its TCC identity is the app's.
2. PROMPT (the silence): a sandboxed process's tap NEVER raises the System
   Audio Recording prompt — fresh TCC state, tap runs with zero device
   cycles, no AUTHREQ ever reaches tccd, room goes "live" streaming filler
   silence. Go Live on Mac output now sends primeSystemAudio over the shell
   bridge first: the APP creates a momentary CATap in its own name (the shape
   macOS prompts for), the grant covers the helper via process
   responsibility, and a denied prime stops Go Live with the honest Settings
   path. Proven end to end on the sandboxed store-dev build: prompt appeared,
   Allow, guests' segment measured -5.8 dB mean (real music).
3. HONESTY (the gaslighting): capture-failure copy no longer tells the DJ to
   play music or flip permissions when the fault is ours.

125.35 (255) carries all of it; versions now MOVE for every build a Mac can
receive (the owner had 125.34-as-253-and-254 side by side and could not tell
them apart — never reuse a visible version across lanes again).

Shazam: 202 on dev builds is EXPECTED forever (no provisioning). 255 is the
first fair test of recognition under the inherit design; if it still 202s
there, the inherited profile isn't carrying the shazamd lookup for ShazamKit
and recognition needs its own home (likely the app process) — a designed
follow-up, not a hotfix.

Menu bar decoder: 🕺 ⚠ N = live but health "strain"/"congested" (real alarm,
not noise); 🕺 🔴 = capture dead. Xcode builds on the DJ Mac while
broadcasting CAUSE strain and audible cutoffs — never compile during a set.

Seth: leadman.seth.finkin@gmail.com (the bare seth.finkin record was deleted
from ASC on owner's order). Team member (Marketing), internal group, tester
state INSTALLED — but what he installed today was a broken-capture build;
he needs the 125.35 (255) update for anything to work.

## Workflow + build lane facts (2026-08-05)

- This repo now lands ONLY via worktree + branch + merge-gate
  (~/dev/stack/runbooks/workflow.md); a pre-commit hook blocks canonical-main
  commits. Standing worktree: ~/dev/partyparty--work (merge-gate --keep).
- GitHub Actions is dead fleet-wide (workflow file + all eight repo secrets
  deleted). The login keychain holds both distribution identities and is the
  ONLY signing home; the CI-era stash (custom partyparty-app-store keychain,
  p12s, raw key) was archived to NAS /volume3/backups/ci-era-signing-20260805/
  and deleted from this Mac (infra session, 2026-08-05). Never recreate it.
- Local TestFlight packaging: scripts/package-app-store.sh with
  APP_STORE_PROVISIONING_PROFILE (build/partyparty-mas.provisionprofile, or
  re-download: asc profiles view --id W6PS27X4YK), PP_SIGN_ID "Apple
  Distribution: Ramine Darabiha (52WM463HR2)", APP_STORE_INSTALLER_ID "3rd
  Party Mac Developer Installer: ...", PP_TESTFLIGHT_ONLY=1. Upload:
  asc builds upload --app 6794880742 --pkg dist/PartyParty-app-store.pkg
  --version <v> --build-number <n> --wait.
- First merge-gate runs on this repo surfaced two runner facts: (1) the WSL
  runner's network stack can ACCEPT on a "closed" loopback port, so readiness
  timeout tests must dial a TEST-NET-1 blackhole, never a freed local port
  (internal/mediamtx tests fixed); (2) Playwright browsers are provisioned
  once on the runner as root (npx playwright install --with-deps chromium;
  cache /root/.cache/ms-playwright survives across runner builds).
- Debugging gotchas that each cost real time today: `log` is a zsh BUILTIN —
  unified-log reads silently do nothing unless you call /usr/bin/log; tccd
  redacts identities as <private> (grep for AUTHREQ/service names, or dump a
  tight window unfiltered); the broadcast log ring (ppcapture/ffmpeg/mediamtx
  output) is served as the `log` field of /api/status — no FDA needed, the
  fastest capture-debug channel there is; inherit-entitled helper binaries
  SIGTRAP when run standalone from a shell (rc=133, not a build defect — use
  the unsigned copies in assets/ for desk experiments); the standing worktree
  needs assets/ffmpeg + assets/mediamtx copied in once from canonical.

## The Shack15 cutoff fix (reference)

THE SHACK15 CUTOFF CAUSE IS FIXED AND PROVEN. The 2026-08-04 silence keepalive
in swift/ppcapture.swift fired 120ms after the last real frame - inside normal
HAL callback jitter - so on a loaded venue Mac it repeatedly spliced zeros into
PLAYING audio and every listener heard the same hole at the same instant. The
replacement is a two-clock design: real audio rides the device clock
exclusively (per-cycle mSampleTime accounting; a real-frames meter separates
real from synthesized so a wedged/hogged tap still looks wedged to the health
monitor), and dead air is wall-clock-filled only after 1.5s of no real frames -
strictly beyond what the 0.5s ring + 0.9s hold-back absorb, so the filler is
structurally incapable of touching playing audio - with a 5ms fade-in when
music returns. Empirical facts baked into an every-launch "clock report" diag
line: on a silent Mac the aggregate's IO cycle stops COMPLETELY (cycles=0 over
10s, measured 2026-08-05), so device-clocked silence is impossible on this API
and the wall-clock filler is not optional. Verified live on this Mac: silent
go-live in 4s (was 34.5s/forever), silence->music transition with zero
gapHistory growth. Installed and running (125.33-dev stamp).

## Shazam verdict (2026-08-05 02:30)

Track recognition died 2026-07-31 for TWO stacked reasons, both now resolved
as far as code can: (1) the rename flattened ppcapture to a bare inherit-
signed binary, losing the shazamd mach exception AND the bundle identity TCC
needs - restored on the branch (ppcapture.app, app's bundle id, capture
entitlements, verify-app-store.sh asserts all of it). (2) With that fixed, a
clean-room probe proved the remainder: ShazamKit 202 = "Missing entitlements"
wrapping HTTP 401 from api.shazam.apple.com - catalog matching requires
signing/provisioning that carries the App ID's ShazamKit service. Desk builds
embed no profile and are refused by Apple's server, always. Recognition is
therefore PROVEN only in provisioned builds: the next TestFlight build (with
this branch merged) is the verification vehicle. Desk-build recognition would
need a Mac Development profile embedded (app + capture bundle) - optional
follow-up, not a gate.

## Blockers

None recorded.

## Ruled out

- The 300-500 listener load test: the owner cancelled it, and a real party has since run successfully.
- Speaker mode (foreground Web Audio tight sync) — proposed as a sixth sync mode, never adopted. Web Audio, MSE, and rate-nudging are all proven dead on locked iPhones; do not relitigate without new iOS facts.
- hls.js/ManagedMediaSource as the iPhone default — caused an audible seek storm (~1 skip/sec). Native AVPlayer is the engine; MMS is opt-in only.
- Renaming bundle IDs, DNS hostnames, Bonjour service type, Go module/import path, helper binary name, R2 bucket/header keys, or the Workshop project id: these are installed-app and live-infrastructure compatibility identifiers, not product-facing old-name copy.
- Commit-on-snap for the DJ reel: selectDJ() rebuilds the HLS session, so a flick past four DJs would mean four rebuilds and four audible gaps. Snap moves focus; the switch fires on settle.
- Capping the cover with aspect-ratio + max-height: the browser shrinks the WIDTH to keep the ratio, which left the banner covering two thirds of a wide window. Use an explicit height with object-fit:cover on the img.
- Splitting a CSS selector list on commas without first excluding comments: a comma inside a comment stranded the closing */ in a fragment that was dropped as dead, turning the rest of the stylesheet into one runaway comment and silently killing ~21 rules.
- React + Tailwind for the console: the app is a single vanilla HTML file embedded in the Go binary and rendered in a WKWebView, with no bundler and no internet at runtime. Emitting React/Tailwind would be a framework migration plus an offline-vendored build step, and would discard ~1,400 lines of working JS driving the QR, status polling, capture permissions and the feed.
- A human-readable join address like party.local/sunset: guest playback is HTTPS and the certificate must validate for the hostname, and an mDNS .local name can never hold a public cert. The readable address already exists as the direct hostname; only relay mode shows the opaque r-<token> URL.
- A start/end chime: capture is Mac system output, so any UI sound plays through that output and lands in the guests' stream. 'Subtle sound' and 'never enters program audio' are mutually exclusive under system-output capture.
- "The container is empty" as evidence: a shell without Full Disk Access LISTS ~/Library/Containers/<id>/Data directories as empty and reads files as "Operation not permitted" (TCC). The 2026-08-03 session logs were "missing" all night while sitting exactly where diag.Open put them. Prove absence with a file read, never with ls; /api/status.diagPath now names the live path.
- Probing the r-<token>.partyparty.party URL with curl to judge room health: the Worker serves its relayBootstrap (a probe-then-redirect page) for EVERY path on r- hosts, so curl sees 4.4KB of HTML regardless of room state. The room lives at <token>.relay.partyparty.party; judge health there.
- Treating relay presence as proof the relay works: presence (RunPlane) and media push (Run) are separate planes with separate failure modes. Fresh presence proves only that snapshots flow.
- Counting HTML tags to prove structure: balanced totals do not prove nesting. </details></div> where </div></details> was meant balances perfectly and silently force-closes an ancestor, landing whole panes inside unrelated elements with no syntax error. The contract test now walks the stack in document order instead.
- Presence freshness as relay health: RunPlane and the media cycle are separate planes; presence stayed fresh for hours while the media push was dead
- Judging room health via the r-<token> URL with curl: the Worker serves its relayBootstrap for every path on r- hosts; judge at <token>.relay… or /__pp/health on the box
- Concluding files are missing from ls of ~/Library/Containers/...: TCC shows those dirs as empty to a no-FDA shell; prove absence by file read

## Owed

- Whether an iPhone's Shazams reach this Mac's `SHLibrary`. Thirty seconds to
  find out: Shazam something on the phone, then Settings -> Look in my Shazam
  library. If they never arrive, the import is only as good as Music
  Recognition on the Mac, and the screenshot path stays the way in.
- Correction to Apple DTS: an earlier support message said the host was
  "macOS 26.0". It is macOS 27.0 build `26A5388g`.
- Field tests no simulator can stand in for: a real-iPhone wildcard-cert join,
  and a relayed party with more phones than one simulator on venue Wi-Fi
  (`docs/relay-architecture.md`).
- Nothing on the web pages. The stacked layout eras are collapsed: dead rules
  removed and every selector declared more than once in the same context merged
  into one canonical rule (listener 500 -> 359 live rules, dj 438 -> 311), with
  computed-style equivalence proven against the pristine files at nine
  breakpoints. What remains of `.hero` and `.hero .artwork` across `@media`
  blocks is genuine responsive variation, not leftovers.
