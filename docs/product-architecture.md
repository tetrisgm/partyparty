# partyparty — product architecture (two halves of one product)

> Status: **direction + spec.** The app (live LAN audio, QR→browser join, sync,
> locked-phone) ships today. The hosted platform (event pages, accounts, cloud) is
> the build this describes. Everything here is **free** — this is not a paywall/Pro
> split; the app is a free companion that *unlocks more*, not a premium tier.

## The shape: core + companion (the way Apple would)

partyparty is **one product with two faces**, joined by one object and one identity —
the pattern Apple ships in **Apple Invites** (create in a native app; anyone joins via a
web link with no app/account; shared album + playlist; tied to Apple ID).

- **The web page = the accessible core.** A DJ's home: an easy linktree/about page
  (bio, socials, links), posts, organized events, and — the heart of it — a place the
  crowd **checks in, drops photos/videos/comments, follows, and gets updates.** Works
  for everyone, on any phone, with no app. *Meaningful even without streaming:* "check
  in here, send me your shots, follow me" is already worth it.
- **The Mac app = the free companion that steps it up.** Unlike a typical desktop
  companion (Notion), ours enables **entirely new capabilities**: live audio
  streaming/broadcast, running the room, richer/faster posting, claiming your subdomain,
  and verification. Install it and your page goes from "nice" to "powered."

| | Web page (core) | Mac app (companion) | Shared |
|---|---|---|---|
| Who | The whole crowd + the world | The DJ | — |
| Job | Profile · events · check-in · photos/videos/comments · follow · updates · replay | Go Live / broadcast · run the event · host · verify · claim handle | **The Event** |
| Reach | Any browser, no app, optional account | macOS (Apple Silicon) | **Apple ID (optional)** |
| Feel | apple.com light | dark macOS instrument | one design system (`docs/design-system.md`) |

**Never force the app on the crowd.** Guests always stay on the web. The app is the
creator's amplifier.

## The Event — the single object both halves render

One record is the source of truth; the app writes it, the web renders it, the crowd
adds to it.

```
Event {
  id            // stable slug, e.g. "rooftop-2026-07-04"
  handle/owner  // the DJ (a local identity, or an Apple ID when signed in)
  title, when, where, coverImage, description
  socials[]     // soundcloud / instagram / spotify / …
  status        // upcoming | live | ended
  stream {                    // present while/after streaming (the app half)
    liveUrl?                  // HLS while status=live
    replayUrl?                // auto-saved VOD when status=ended (planned)
    stats { peak, joins, latencyMedianMs, syncSpreadMs, health }  // from internal/stats
  }
  wall: Post[]  // guest photos/videos/comments, each { author?, media?, text, ts, approved }
  followers[]   // who to notify about the next event
  visibility    // local-only | unlisted | public
}
Post { id, author (guest handle | Apple ID | anonymous), kind (photo|video|text),
       media?, text?, ts, approved }  // approved gates what shows on the wall (DJ moderates)
```

- **Local ↔ hosted, offline-first.** An Event exists **locally on the Mac with no
  account** (an offline popup needs nothing). When the DJ signs in + is online, the
  Event **syncs to the hosted page** (`party.ramine.net/@dj` / `/e/<id>`) so the crowd
  can reach it, post to the wall, and catch the replay. Same object, two homes.
- **The app is the writer, the web is the reader + collector.** The app sets
  title/when/where, flips `status`, produces `stream.*` + `stats`, and moderates the
  wall. The web renders the page and lets guests add `Post`s + `followers`.
- **Stats are free, not a tier.** `internal/stats` already yields peak/joins/latency/
  sync-spread/health per live session — the event page just surfaces it.

## Identity — Sign in with Apple, optional + offline-first

- **Offline / anonymous is the default.** Throw a popup with **no account at all** —
  the Event is local, guests join by QR, nothing signs in. This must never regress
  (offline is a core promise).
- **Sign in only to unlock the hosted half:** claim your `@handle`/subdomain, host the
  page in the cloud, get **verified**, keep a permanent replay archive, and let
  followers get your next date. Use **Sign in with Apple** (see `docs/design-system.md`
  for the button + flow); guests may also SIWA to post as themselves or stay anonymous.
- **Rule to honor when we add other logins:** if we offer Google/social sign-in, Sign
  in with Apple must sit alongside at equal prominence (App Store 4.8). Not gating today
  (app is notarized, not App-Store), but build it in from day one on the platform.

## What connects them (Continuity)
- **Guests:** a link (QR) — zero friction, no app.
- **DJ:** universal links / "Open in partyparty" — tap your event on the web, it opens
  in the app; the app can jump to the event's public page. One identity spans both.

## Build order (when we start the platform)
1. Event object + local store in the app (offline-first) — formalize what the console
   already holds.
2. Hosted event page renderer on `party.ramine.net` (`/@dj`, `/e/<id>`) — the core web
   half, standalone-useful (profile + check-in + wall + follow) even before streaming
   is wired to it.
3. Sign in with Apple (optional) → claim handle, sync local Event → hosted.
4. The wall (moderated photos/videos/comments), replay upload, follower notifications.
