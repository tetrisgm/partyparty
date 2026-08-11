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
  accepts, edits, or skips. Nothing appears in the journal by itself.
- **Enriching an accepted night is automatic.** Tracks merge in, a venue name
  propagates, a better title is offered as a one-tap chip. Nothing is
  silently overwritten - anything typed by a person wins over anything
  inferred (proven pattern: the place-never-overwritten test).
- **Everything is editable afterwards**, because an accepted night is an
  ordinary night page.
- **A skip is durable.** Skipped days are never re-suggested; a "skipped"
  list exists as the escape hatch for changed minds.

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
| music    | these tracks played                 | Shazam import, live recognizer |
| plan     | this was planned: title, venue, when, attendees | Calendar, .ics, tickets, .pkpass |
| media    | you shot n photos/videos there      | PhotoKit (counts and windows only - attaching actual photos is a user pick) |
| company  | A and B were probably there         | Calendar attendees, shared-album contributors, later Messages, network |
| receipt  | you paid at V that night            | payment-receipt emails (merchant + time; never the amount) |
| listing  | the venue's page says event E ran   | venue-page JSON-LD fetch |
| attest   | another user's public night matches | the network layer |

`plan` and `presence` corroborating is near-certainty. `plan` alone (a
ticket for Friday) surfaces the card BEFORE the night - "going to this?" -
which is the forward-looking journal for free.

## Venues

    venues(id, owner_email, geokey, name, address, url NULL, created_ms)

Geokey = coordinates rounded to ~100m, the join key everywhere. Naming a
venue once names every night there, past and future. Resolution ladder on
first sight of a geokey: the owner's own venues → MKLocalSearch
point-of-interest (nightlife category - returns "Public Works", not "195
Erie St"; verify it runs in the sandboxed Mac app at build time, else fall
back to the geocoded address) → reverse-geocoded address. `url`, when the
owner sets it, feeds the `listing` fetcher. Account-scoped now; a global
suggestion layer (other users' public venue names) is the network stage.

Auto-titles: an accepted candidate with no plan-derived name is titled
"<Venue>, <date>" when the venue is known - "Public Works, March 21", not
"Saturday, 21 March 2026". The eighteen date-named parties from the first
import get offered the better titles once venues land.

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
tonight's night exists. No background location anywhere, ever (owner
decree); no Shortcuts arrival automation (owner: spammy).

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

- **Mac (the deep scanner).** Shazam is SHIPPED. Add EventKit, PhotoKit,
  Contacts - one prompt each, App-Store-clean. Later, behind macOS's per-app
  data consent, desk build first: Mail (tickets, .ics, .pkpass, receipts,
  attachment OCR via Vision), Downloads, Messages, Safari history. Cadence:
  on launch plus a daily idle tick; evidence posted via install-authed
  /api/v1; everything parses locally.
- **Phone web (now).** On-open geolocation check-in. No scanning - browsers
  have none to give.
- **iOS app (later, the live limb).** While-using location,
  JournalingSuggestions (additive - if Apple grants the journaling
  entitlement the picker becomes the best card-filler; if not, nothing is
  missing), a share extension (share the ticket email / .pkpass / screenshot
  / RA page in), EventKit, PhotoKit, Contacts, MapKit, live ShazamKit while
  open. No background microphone - it does not exist on iOS.
- **Platform.** The forward address - tickets@partyparty.party, the TripIt
  move, works from any phone with zero permissions (receiving plumbing
  decided at build time; the MXroute-for-sending rule is untouched). The
  `listing` fetcher: scheduled fetch of venue URLs, parsed generically for
  schema.org Event JSON-LD - no per-site scraping. The network layer:
  suggestions strictly from other users' PUBLIC nights.

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
   offers for the date-named eighteen.
2. **Evidence + backlog** - the three-stage pipeline, scoring, /home cards,
   accept/edit/skip with durable skips, the skipped list. The settings-page
   import becomes a scanner emitting evidence; its one-shot preview UI
   retires. Supersedes the import's one-party-per-day tiebreak with
   per-cluster candidates.
3. **Mac scanner expansion** - EventKit + PhotoKit + Contacts emission, and
   a sources panel in settings showing each source's grant state and last
   scan. Ask only ever on a button, as the Shazam folder grant does today.
4. **Phone check-in** - the /home button, venue disambiguation, candidate
   born accepted.
5. **People chips** - co-attendance query + company evidence, on check-in,
   creation, and cards.
6. **Deep sources** - Mail/Downloads doors on the desk build, the forward
   address, the listing fetcher, Messages, Safari. Each is its own small
   landing inside the slice.
7. **Series.**

The iOS app is a separate later track; nothing in 1-7 depends on it.

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
