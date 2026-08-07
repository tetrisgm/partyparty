-- PartyParty platform, migration 0001.
--
-- Groups, the people in them, and the nights they run. Applied with:
--   wrangler d1 execute partyparty-app --remote --file=migrations/0001_init.sql
--
-- Two rules shape most of this. A member never needs an account, so every
-- membership row stands on an email address alone and every action is
-- reachable from a token in a message. And membership is TWO LEVEL: being in a
-- group and being at an event are separate facts, either of which the person
-- can end without ending the other.

PRAGMA foreign_keys = ON;

-- A group is a DJ or several, plus the people who come to their nights. The
-- handle is also reserved in the broker's R2 keyspace so it can never collide
-- with a machine or join name minted for a Mac.
CREATE TABLE IF NOT EXISTS groups (
  id          TEXT PRIMARY KEY,
  handle      TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL DEFAULT '',
  bio         TEXT NOT NULL DEFAULT '',
  avatar_key  TEXT,
  cover_key   TEXT,
  links       TEXT NOT NULL DEFAULT '[]',   -- JSON [{type,url}]
  pay_link    TEXT NOT NULL DEFAULT '',     -- the DJ's own Venmo/Revolut/PayPal
  stripe_acct TEXT NOT NULL DEFAULT '',
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);

-- A DJ signs in; a member does not have to. Both are people, but only one of
-- them ever sees a sign-in screen, so they are separate tables rather than one
-- with a nullable everything.
CREATE TABLE IF NOT EXISTS djs (
  id           TEXT PRIMARY KEY,
  email_norm   TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL DEFAULT '',
  created_ms   INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL DEFAULT 0
);

-- Which DJs run which group. Owner cannot be removed by a host.
CREATE TABLE IF NOT EXISTS group_djs (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  dj_id      TEXT NOT NULL REFERENCES djs(id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'host',   -- owner | host
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (group_id, dj_id)
);

-- A member is an email and a name. apple_sub/google_sub are filled in only if
-- they choose to sign in, and are matched onto the existing row by verified
-- email so someone who joined three groups by link keeps all three.
CREATE TABLE IF NOT EXISTS members (
  id            TEXT PRIMARY KEY,
  email_norm    TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL DEFAULT '',
  apple_sub     TEXT,
  google_sub    TEXT,
  confirmed_ms  INTEGER,
  created_ms    INTEGER NOT NULL,
  -- Set once and honoured everywhere: one unsubscribe stops every group.
  suppressed_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_members_apple ON members(apple_sub) WHERE apple_sub IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_members_google ON members(google_sub) WHERE google_sub IS NOT NULL;

-- Being in a group. `state` is the member's own choice and nobody else's;
-- `volume` is how much they hear, which is the whole answer to "this invades my
-- WhatsApp". source records how they arrived, which is the number that says
-- whether being in the room actually builds a crowd.
CREATE TABLE IF NOT EXISTS group_members (
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'joined',  -- joined | left
  volume     TEXT NOT NULL DEFAULT 'events',  -- all | events | none
  source     TEXT NOT NULL DEFAULT 'link',    -- party | link | invite
  joined_ms  INTEGER NOT NULL,
  left_ms    INTEGER,
  PRIMARY KEY (group_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_group_members_group ON group_members(group_id, state);

-- One night. party_id ties it to a live party on a Mac while it is happening.
-- ics_seq increments on every change: a subscribed calendar that never sees a
-- higher SEQUENCE quietly keeps showing the old date.
CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  title         TEXT NOT NULL DEFAULT '',
  description   TEXT NOT NULL DEFAULT '',
  starts_ms     INTEGER,
  ends_ms       INTEGER,
  timezone      TEXT NOT NULL DEFAULT '',
  place         TEXT NOT NULL DEFAULT '',
  address       TEXT NOT NULL DEFAULT '',
  cover_key     TEXT,
  state         TEXT NOT NULL DEFAULT 'draft', -- draft | announced | live | over | cancelled
  ticket_cents  INTEGER NOT NULL DEFAULT 0,
  capacity      INTEGER NOT NULL DEFAULT 0,
  entry_code    TEXT NOT NULL DEFAULT '',
  party_id      TEXT NOT NULL DEFAULT '',
  ics_seq       INTEGER NOT NULL DEFAULT 0,
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL,
  UNIQUE (group_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_events_group_time ON events(group_id, starts_ms);

-- Going, or not. Separate from group membership on purpose: someone can come to
-- one night without joining, and leave the group without cancelling a ticket.
CREATE TABLE IF NOT EXISTS signups (
  event_id   TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  state      TEXT NOT NULL DEFAULT 'going',   -- going | not
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (event_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_signups_event ON signups(event_id, state);

-- The timeline. A post with no event is the group's discussion; a post with one
-- belongs to that night, and origin says whether it came from the venue Wi-Fi
-- or the web - which is what lets one link hold both.
CREATE TABLE IF NOT EXISTS posts (
  id           TEXT PRIMARY KEY,             -- ULID, minted by whoever wrote it
  group_id     TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  event_id     TEXT REFERENCES events(id) ON DELETE CASCADE,
  member_id    TEXT REFERENCES members(id) ON DELETE SET NULL,
  dj_id        TEXT REFERENCES djs(id) ON DELETE SET NULL,
  author       TEXT NOT NULL DEFAULT '',     -- display name as posted
  body         TEXT NOT NULL DEFAULT '',
  media_key    TEXT,
  media_type   TEXT,
  origin       TEXT NOT NULL DEFAULT 'web',  -- web | lan
  deleted_ms   INTEGER,
  created_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_event ON posts(event_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_posts_group ON posts(group_id, created_ms);

-- "I do not want invitations from this person." Blocking is not leaving: the
-- member stays in the group and keeps everything else.
CREATE TABLE IF NOT EXISTS blocks (
  member_id  TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  dj_id      TEXT NOT NULL REFERENCES djs(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (member_id, dj_id)
);

-- Every member action arrives as one of these. Single use, scoped to one
-- member and one purpose, so a forwarded email cannot do more than it says.
CREATE TABLE IF NOT EXISTS tokens (
  id          TEXT PRIMARY KEY,
  hash        TEXT NOT NULL UNIQUE,
  member_id   TEXT REFERENCES members(id) ON DELETE CASCADE,
  group_id    TEXT REFERENCES groups(id) ON DELETE CASCADE,
  event_id    TEXT REFERENCES events(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL,                 -- confirm | manage | going | ticket
  created_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,
  used_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_expires ON tokens(expires_ms);

CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  hash         TEXT NOT NULL UNIQUE,
  dj_id        TEXT REFERENCES djs(id) ON DELETE CASCADE,
  member_id    TEXT REFERENCES members(id) ON DELETE CASCADE,
  created_ms   INTEGER NOT NULL,
  expires_ms   INTEGER NOT NULL,
  revoked_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_ms);

-- Mail waits here for the sender on the origin box. Workers are a poor place to
-- speak SMTP, and MXroute credentials have no business on Cloudflare.
CREATE TABLE IF NOT EXISTS outbox (
  id          TEXT PRIMARY KEY,
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  body_html   TEXT NOT NULL DEFAULT '',
  headers     TEXT NOT NULL DEFAULT '{}',    -- JSON, carries List-Unsubscribe
  attach_ics  TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL,                 -- confirm | invite | reminder | ticket | note
  group_id    TEXT,
  event_id    TEXT,
  created_ms  INTEGER NOT NULL,
  sent_ms     INTEGER,
  tries       INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(sent_ms, created_ms);
