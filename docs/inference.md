# How PartyParty knows where you were

The consolidated spec for check-in, the backlog, and every inference source.
Decision trail: `docs/HANDOFF.md`, "Direction (2026-08-10)". This file is the
buildable whole; the units at the bottom are the build order.

## The promise, and the rule that keeps it honest

The owner should never type what the product could have known. A night out
leaves traces in a dozen Apple-shaped places - Shazams, calendar entries,
photos, tickets, receipts, visits - and the product's job is to gather them
into "you were at Public Works on Saturday with Cy and Dee, here's what
played" before being asked.

The rule that keeps automation from becoming presumption:

- **Creating a night is always confirmed.** Inference proposes; the owner
  accepts, edits, or skips. There is NO auto-add tier (owner, 2026-08-11):
  a suggestion is an item you HAVE - it can sit unconfirmed forever at no
  cost - and confirming is what makes a field beyond doubt.
- **Enriching an accepted night is automatic.** Tracks merge in, a venue name
  propagates, a better title is offered as a one-tap chip. Nothing is
  silently overwritten - anything typed by a person wins over anything
  inferred (proven pattern: the place-never-overwritten test).
- **Everything is editable afterwards**, because an accepted night is an
  ordinary night page.
- **A skip is durable.** Skipped days are never re-suggested; a "skipped"
  list exists as the escape hatch for changed minds.

## Everything is a suggestion

Owner, 2026-08-11, replacing the earlier autonomy-dial idea: "everything
should be a suggestion and then you can just confirm. It's okay to have lots
of suggestions - they're just items that you have. If you confirm them, then
there is no doubt about what's in the field."

So there are exactly two states, and both are visible everywhere:

- **Suggested** - pencil. Nights the pipeline believes in, venue names it
  worked out, people it thinks were there, titles it proposes. Suggested
  items render distinctly (dimmed, marked), can accumulate without limit,
  and never harden on their own.
- **Confirmed** - ink. One tap. A confirmed field is beyond doubt because a
  person said so.

Thresholds and scores only decide SURFACING ORDER - what shows first, what
stays in the long tail - never truth. Nothing is ever auto-added; there is
no dial. This also applies inside a night: a suggested venue or person shows
as a suggestion on the page itself until tapped, so the page is honest about
what is known versus inferred.

## The morning digest

The retroactive experience is not a list the owner remembers to visit - it is
a message the morning after a detected night: "Last night: Public Works,
11:40pm-3:04am - 12 Shazams, 14 photos. Add it?" One tap accepts from the
message itself. Channels, in order of preference: Web Push to the phone
(partyparty.party installed to the Home Screen can receive push on iOS - no
native app required), or email via the house SMTP. It always asks; nothing
is ever added on its own.

## One journal, three doors

Owner, 2026-08-11, on a real flaw in the earlier framing: "web and Mac are
the priority, while they're the least likely to be used when doing this kind
of journaling and check-in. They're also very separated from each other."

The correction, stated as architecture:

- **There is ONE journal - the web pages - and the PHONE is its primary
  door.** "Web" in this plan means partyparty.party on the phone in the
  pocket at the party: installable to the Home Screen, receiving push,
  asking "At Public Works?" on open. Not a desktop site.
- **The Mac is a collector, not a destination.** Nobody journals on a Mac.
  Its job is to feed the phone's morning: it is the always-on device Apple
  syncs everything to (photos, calendar, mail) and the only place those may
  legally be read. Its console shows the same journal in a frame - already
  true today - so it is never a second product.
- **The iOS app, when it comes, is the third door around the SAME pages** -
  exactly the shell the Mac console already is - plus the four things only a
  native app can add: the lock-screen widget, the share extension,
  JournalingSuggestions, live Shazam while open. It is a numbered slice
  below, not a someday.

Nothing is separate: three shells, one journal, and the build order below
puts the phone experience immediately after the foundation.

## The pipeline: evidence → candidate → night

Three stages, three tables. Every source on every device feeds stage one;
nothing downstream knows which sources exist on a given install.

**1. Evidence** - append-only inference atoms, uploaded by scanners. Raw
content never leaves the device it lives on; an atom is a conclusion.

    evidence(id, owner_email, day, kind, geokey NULL, window_start_ms NULL,
             window_end_ms NULL, payload JSON, source, dedupe_hash,
             created_ms)

Idempotent by (owner_email, source, dedupe_hash) - re-scans cost nothing,
multiple devices cannot double-report. `day` uses the 6am rule in the owner's
local time, computed scanner-side (only the device knows the timezone).

**2. Candidates** - the merged view, one row per (owner, day, venue
cluster). A day can hold two: the party and the after.

    candidates(owner_email, day, geokey, state, score, summary JSON,
               event_id NULL, updated_ms)
    state: pending | accepted | dismissed

Evidence with a geokey attaches to its cluster's candidate; evidence without
one (a calendar entry with no location) attaches to the day's dominant
candidate, or stands alone venue-less. Score is the weighted sum of its
evidence kinds; a candidate SURFACES in the backlog when the score crosses a
threshold or any single strong kind arrives (a ticket, a journal pick, a
live check-in). The old "five Shazams minimum" generalizes: presence weight
scales with count, so one Shazam on a Tuesday still never surfaces alone.

**3. Nights** - `events`, as they already exist. Accepting a candidate
creates or updates the event (venue, best-known title, window), files its
music evidence into `songs` through the existing dedupe, and offers its
people as chips. A live check-in is a candidate born accepted.

## Evidence kinds

| kind     | says                                | emitted by |
|----------|-------------------------------------|------------|
| presence | you were at G during W              | Shazam clusters, photo geotags, on-open location, Journal pick |
| music    | these tracks played                 | Shazam import, live recognizer, and Shazam matching over the night's own videos and Live Photos (footage rules below) |
| plan     | this was planned: title, venue, when, attendees | Calendar, .ics, tickets, .pkpass |
| media    | you shot n photos/videos there      | PhotoKit (counts and windows only - attaching actual photos is a user pick) |
| company  | A and B were probably there         | Calendar attendees, shared-album contributors, later Messages, network |
| receipt  | you paid at V that night            | payment-receipt emails (merchant + time; never the amount). RIDE receipts are the special case worth naming: a 2:45am ride home FROM an address is presence at the venue plus the moment the night ended |
| listing  | a published calendar says event E ran there | the listings ladder below |
| attest   | another user's public night matches | the network layer. Two forms: CO-PRESENCE (two users' own evidence at the same venue and night auto-suggests them to each other as company - mutuals/followers only), and the SET FINGERPRINT (two track lists sharing the same songs in the same order on the same night are the same party even with no geo at all - and a guest's night can link itself to the DJ's published set, which no one else can do) |

`plan` and `presence` corroborating is near-certainty. `plan` alone (a
ticket for Friday) surfaces the card BEFORE the night - "going to this?" -
which is the forward-looking journal for free.

**Footage rules (owner, 2026-08-11).** Recognition over videos and Live
Photos is JUST SHAZAM, and only where there is music. A cheap on-device
music-presence check (SoundAnalysis) gates every clip; only clips that sound
like music get a Shazam pass, and the expectation is that MOST WILL NOT -
crowd noise and talking dominate party footage, and that is fine. The only
things ever computed from footage are "does this contain music?" (on-device)
and a Shazam signature - the same fingerprint the Shazam app itself sends.
No transcription, no scene analysis, no face anything, ever. Low weight:
footage music is bonus evidence on a night, never the reason a card
surfaces. Standing dependency: SHSession matching needs the SHAZAM_KIT
entitlement resolved, exactly like live recognition.

**Set reconstruction (owner: keep).** Nobody catches a whole set; a crowd
does. When several people are on the same night - attendees of one event, or
public nights matched by the set fingerprint - their music evidence UNIONS
into one track list in time order, each track crediting whoever caught it.
Five people with fifteen Shazams each reconstruct most of a set none of them
could alone, and the reconstruction can link to the DJ's own published set.

## Venues

    venues(id, owner_email, geokey, name, address, url NULL, created_ms)

Geokey = coordinates rounded to ~100m, the join key everywhere. Naming a
venue once names every night there, past and future. Resolution ladder on
first sight of a geokey: the owner's own venues → `venues_catalog` on the
platform → device-side MKLocalSearch point-of-interest (nightlife category -
returns "Public Works", not "195 Erie St"; verify it runs in the sandboxed
Mac app at build time) → reverse-geocoded address. `url`, when the
owner sets it, feeds the `listing` fetcher. Account-scoped now; a global
suggestion layer (other users' public venue names) is the network stage.

Auto-titles: an accepted candidate with no plan-derived name is titled
"<Venue>, <date>" when the venue is known - "Public Works, March 21", not
"Saturday, 21 March 2026". The eighteen date-named parties from the first
import get offered the better titles once venues land.

## The registries: venues, performers, people

Owner, 2026-08-11: comprehensive lists, so recognition has something to
recognize AGAINST. Three catalogs; every suggestion field resolves through
one of them, and each fills from every side at once:

- **Venues** (above). Two layers: the owner's overlay (what THEY call a
  place, always winning) over a GLOBAL CATALOG the platform builds and
  refreshes itself - see the gazetteer below. Comprehensive means the
  catalog knows the clubs before the owner's first visit: check-in
  disambiguation between two close venues comes from it, not just from
  history and MKLocalSearch.
- **Performers.** A canonical table of DJs and artists: seeded from the
  platform's own DJs and every `party_people` row with the dj role,
  extended by lineups parsed from tickets and listings, and CANONICALIZED
  against two catalogs - **Bandsintown** (a real, documented API: artist
  name, image, links, and their events with venue name and coordinates;
  often better than Apple Music for club DJs, because small touring artists
  register there themselves) and the **Apple Music catalog** (MusicKit
  lookup: proper name, artwork, disambiguation). Store both ids when both
  hit. "Ada", "ada kaleh" and the misspelling on a flyer become one
  performer, and "who played" autocompletes and suggests from it.
- **People.** The comprehensive base is the owner's Contacts (one prompt),
  matched to the existing `people` table by email and name; co-attendance
  history ranks them. Faces come with them.

Registries are suggestion sources, not truth: a registry hit renders as a
suggested chip like everything else.

## The listings ladder

Owner, 2026-08-11: learn from Bandsintown and 19hz.info. Three rungs, tried
in order, all feeding `listing` evidence and both registries:

1. **The venue's own page** - a URL on the venue record, parsed generically
   for schema.org Event JSON-LD. No per-site scraping.
2. **Regional aggregator calendars - 19hz.info first.** THE community
   calendar for electronic music (Bay Area above all - the owner's own
   Public Works nights are literally on it - plus LA, NYC, Seattle and
   more): date, title @ venue, genres, times, organizers, ticket links, in
   famously plain, stable tables with calendar-feed links. Fetched at most
   once a day per region into a cached `listings` table, matched to
   candidates by day + venue. It is one person's labour of love: fetch
   politely, attribute suggestions ("via 19hz.info"), and write the
   maintainer before shipping it.
3. **Bandsintown events by artist** - given a performer already linked to a
   night, their event on that date names the party, the venue (with
   coordinates), and the rest of the lineup. Documented API with an app_id;
   its terms are scoped to artist promotion, so treat as enrichment, seek
   the partner blessing if it grows load-bearing - which, by standing rule,
   it never becomes.

A listing hit is the single best "which party WAS this" answer - title,
lineup, ticket link - and like everything external it degrades to nothing
without anything else noticing.

## The gazetteer

Owner, 2026-08-11, sharpening what "learn from 19hz" means: it is not just a
match-time lookup - it is HOW THE CATALOGS GET BUILT. "A good way to find out
the names of venues... and their official websites... and potentially
artists. We need a way to build a database of all of these and refresh them,
so the suggestions are good."

So the platform keeps standing catalog tables, harvested on the Worker's
existing cron, separate from any owner's data:

    venues_catalog(id, region, name, address, url, geokey NULL,
                   source, first_seen_ms, last_seen_ms)
    performers_catalog(id, name, bandsintown_id NULL, apple_music_id NULL,
                       image_url, source, first_seen_ms, last_seen_ms)
    listings(id, region, day, title, venue_name, venue_id NULL,
             lineup JSON, links JSON, source, seen_ms)

The harvest, in order of what it yields:

1. **19hz venue directories** - the seed. Each region page lists club names
   with ADDRESSES and OFFICIAL WEBSITES: exactly the bootstrap. Weekly.
2. **The venues' own sites** - the rich ongoing source ("we will learn a lot
   more from club venues"): every catalog venue with a URL gets the JSON-LD
   event fetch, which yields party names, dates and LINEUPS - and lineups
   feed the performers catalog. Daily, polite, cached.
3. **19hz event tables** - daily per region: title @ venue, organizers,
   ticket links. Names venues the directory missed and parties the venue
   sites do not publish.
4. **Bandsintown** - canonicalizes performer names met anywhere above, and
   its events corroborate venues with coordinates.

Freshness is a column, not a hope: every row carries source and last_seen;
harvests upsert; nothing hard-deletes (a closed club still names old
nights). Suggestions prefer fresh rows.

The gazetteer is ENTIRELY a platform service - Worker cron plus D1, nothing
else (owner, 2026-08-11: "a web service needs to handle the database for the
venues and artists; the Mac app has nothing to do with this"). No client is
involved in building, refreshing, or matching against it: check-in fixes and
evidence geokeys join against `venues_catalog` server-side, where they
arrive. Geocoding the directories' addresses happens at harvest time on the
platform too: OpenStreetMap's Nominatim, politely - cached forever, about a
request a second, attributed. And OSM itself is a second seed alongside
19hz: its nightclub and music-venue POIs carry name, coordinates AND website
in one query, no geocoding needed. (Device-side MapKit remains only what it
always was: a per-owner suggestion for naming the owner's OWN clusters,
submitted like any other suggestion - never part of catalog construction.)

The courtesies stand and extend: per-source daily/weekly caps, attribution
on every suggestion the catalog produces, the 19hz maintainer written to
before any of it ships.

## The backlog

Pending candidates render as cards on /home - web, phone web, and the Mac
console via its frame, one implementation. A card shows the merged story
(venue, window, counts per kind, sample titles, suggested people) and three
moves: **Accept**, **edit-then-accept**, **Skip**. Cards sort newest-first;
below-threshold candidates are queryable but never pushed.

## Live check-in

On the phone web (and the iOS app later): a button on /home, while-using
location only, one fix → nearest venues ranked by the owner's own history
first, MKLocalSearch candidates after → confirm → candidate born accepted,
tonight's night exists. No background location anywhere (owner decree); no
Shortcuts arrival automation (owner: spammy).

**The ask, without Always** - the live moment can still come to the owner,
through four channels that need no background location:

- **A lock-screen widget** (iOS app). WidgetKit refreshes on the system's
  schedule with while-using-class location: parked at a known venue late, it
  reads "At Public Works? →" and a tap deep-links into the one-tap check-in.
  It sits quietly on the lock screen; it never notifies.
- **The plan-triggered nudge.** A ticket for tonight schedules one local
  notification at doors: "Tonight: Sunset Campout - check in when you're
  there." It fires only when a plan EXISTS - the anti-spam inverse of the
  rejected arrival automation.
- **App Intents donations.** Donate the check-in intent and let Apple's own
  suggestion engine surface it contextually - its ML, its spam filter, zero
  permissions.
- **Web Push** for the PWA on any phone, carrying the morning digest and the
  plan nudge before the iOS app exists.

## People

Two feeds into the same chips:

- **Co-attendance** (exists in `party_people`): rank by frequency × recency
  × same-venue affinity. The Partiful move.
- **Company evidence**: calendar attendees matched to people by email;
  shared-album contributors by name; Messages-derived names later.

Chips are confirmed with a tap (bulk-confirm allowed); people are never
auto-added to a night. Contacts enriches matches with faces.

## Series

Same venue + cadence (~weekly/monthly, loose) + recurring people across ≥3
nights ⇒ one suggestion: "these six Saturdays at Public Works look like one
series - name it once?" Accepting names the matched nights and becomes the
default for new check-ins matching the pattern. Schema (a `series` table vs
a shared label) is decided in its own unit.

## The scanners

- **Mac (the deep scanner - and the always-on limb Apple actually allows).**
  A menu-bar app runs all day, and Apple syncs everything to it: last
  night's photos, the calendar, the mail. The nightly sweep means the
  morning card exists with the phone never touched - the Mac is our
  Pilgrim. Shazam is SHIPPED. Add EventKit, PhotoKit,
  Contacts - one prompt each, App-Store-clean. Later, behind macOS's per-app
  data consent, desk build first: Mail (tickets, .ics, .pkpass, receipts,
  attachment OCR via Vision), Downloads, Messages, Safari history. Cadence:
  on launch plus a daily idle tick; evidence posted via install-authed
  /api/v1; everything parses locally.
- **Phone web (now) - the primary door.** The whole journal, the backlog
  cards, on-open check-in, the digest via Web Push once installed to the
  Home Screen. Browsers scan nothing; they do not need to - the collectors
  feed this surface.
- **iOS app (slice 8) - the same pages in a native shell**, the way the Mac
  console already is, plus what only a native app adds: the lock-screen
  widget, the share extension (share the ticket email / .pkpass / screenshot
  / RA page in), JournalingSuggestions (additive - if Apple grants the
  entitlement the picker becomes the best card-filler; if not, nothing is
  missing), while-using location, EventKit, PhotoKit, Contacts, MapKit,
  live ShazamKit while open. No background microphone - it does not exist
  on iOS.
- **Platform.** The listings ladder (venue pages, 19hz.info regional feeds,
  Bandsintown by artist), fetched on the Worker's existing schedule and
  cached in D1. The network layer: suggestions strictly from other users'
  PUBLIC nights. (The forward-address idea is DROPPED - owner, 2026-08-11:
  "no point, we'll just scan the mails." Mac Mail scanning is the mail
  answer.)

## Privacy invariants

Parse on-device, upload conclusions. Venues store rounded coordinates; a raw
GPS fix is never persisted. Receipt evidence never carries amounts. Photo
evidence is counts and windows; the photos themselves move only when the
owner picks them. Per-night contents permissions (public / followers /
named) are untouched by all of this. Every source is additive; none is
load-bearing; a denied grant degrades exactly one column of evidence.

## Build order

Each slice lands whole, in the workflow's usual way.

1. **Venues** - table, geokey resolution ladder, MKLocalSearch naming,
   `events.venue_id`, backfill of coordinate-known places, auto-title
   offers for the date-named eighteen - plus the gazetteer seed: the 19hz
   venue directories harvested into `venues_catalog`, so the catalog knows
   the clubs before slice 3's check-in needs to disambiguate them.
2. **Evidence + backlog** - the three-stage pipeline, scoring, /home cards,
   accept/edit/skip with durable skips, the skipped list. The settings-page
   import becomes a scanner emitting evidence; its one-shot preview UI
   retires. Supersedes the import's one-party-per-day tiebreak with
   per-cluster candidates.
3. **The phone journal** - the primary door ships early: backlog cards and
   check-in on the phone web, Home Screen install, Web Push, the morning
   digest.
4. **The collectors** - EventKit + PhotoKit + Contacts emission on the Mac,
   and a sources panel in settings showing each source's grant state and
   last scan. Ask only ever on a button, as the Shazam folder grant does
   today.
5. **People + performers** - co-attendance and company chips; the performer
   registry seeded from platform DJs, canonicalized via Bandsintown and the
   Apple Music catalog; Contacts filling the people registry.
6. **Deep sources** - Mail/Downloads doors on the desk build, the rest of
   the gazetteer harvest (venue sites, 19hz event tables, Bandsintown),
   Messages, Safari. Each its own small landing inside the slice.
7. **Series.**
8. **The iOS shell** - the same journal wrapped native: widget, share
   extension, JournalingSuggestions, push. Nothing in 1-7 depends on it;
   everything in 1-7 makes it thinner.

## Known risks and standing facts

- D1 writes batch per night (learned 2026-08-10: 543 tracks = 1,086
  sequential round trips blew a 15s client timeout); the import client now
  gets three minutes. Evidence atoms are small; same batching discipline.
- SHAZAM_KIT entitlement: capability shows on the App ID, no profile carries
  it, claiming it SIGKILLs. Resolve with Apple eventually; the store-reader
  sidesteps it on the Mac. `SHLibrary` on iOS would hit the same wall.
- JournalingSuggestions entitlement is a human-reviewed request; additive
  only, never load-bearing.
- The Shazam store path is private and unpromised; if macOS moves it, that
  source reads empty and everything else stands.
- Same-day multi-candidate replaces the current one-party-per-day merge rule
  in slice 2; until then the import's tiebreak stands.
- Performer canonicalization against the Apple Music catalog needs a
  MusicKit developer token - a key the owner mints once in the developer
  account; requested when slice 5 starts. Bandsintown needs an app_id and,
  if it ever matters commercially, their partner blessing.
- External listings and catalog sources (19hz.info, OSM/Nominatim,
  Bandsintown, venue pages) are the fragile tier: cached through D1, attributed on the suggestion, rate-limited to
  daily, and never load-bearing - any of them going dark removes a
  suggestion source and nothing else.
- Always location is DECIDED NO (owner, 2026-08-10, reaffirmed 2026-08-11).
  It is the only path to zero-touch live check-in, and the answer is still
  no - do not re-propose it. The widget, the plan nudge, App Intents
  donations and the digest are the ceiling for live automation.
