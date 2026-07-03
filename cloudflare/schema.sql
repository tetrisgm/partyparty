-- partyparty events D1 schema (migration 0001).
--
-- Apply with:
--   wrangler d1 execute partyparty-events --remote --file=schema.sql
-- (and --local for a local dev DB). Statements are idempotent (IF NOT EXISTS)
-- so re-applying is safe.
--
-- Phase-1 scope: a DJ finishes a set and publishes it, so the /e/<slug> page
-- becomes a real replay page (an <audio> stream + waveform + event meta).
-- Guest photos/comments/moderation are Phase-2 — the `posts` table is created
-- now (unwritten) so that growth needs no ALTER on live data.

-- events: one shareable page, owned by exactly one install (first-writer-wins).
-- install_id is the ownership key — a publish only succeeds if the slug is
-- unclaimed or already owned by the calling install.
CREATE TABLE IF NOT EXISTS events (
  slug        TEXT PRIMARY KEY,             -- the /e/<slug> path segment; charset-gated to EVENT_RE
  install_id  TEXT NOT NULL,               -- broker install id that owns this slug
  title       TEXT NOT NULL DEFAULT '',
  host        TEXT NOT NULL DEFAULT '',    -- "<host> is hosting" — the DJ/host name
  starts      TEXT NOT NULL DEFAULT '',    -- free-text when line ("Saturday · 11pm")
  where_txt   TEXT NOT NULL DEFAULT '',    -- free-text location
  tagline     TEXT NOT NULL DEFAULT '',
  about       TEXT NOT NULL DEFAULT '',
  cover_key   TEXT,                        -- R2 key for the cover image, or NULL (default art)
  status      TEXT NOT NULL DEFAULT 'replay',
  created_ms  INTEGER NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_install ON events(install_id);

-- event_sets: published set recordings for an event. A set is 'pending' from
-- the moment its metadata row is inserted and only flips to 'ready' once BOTH
-- the audio and the peaks are confirmed in R2 — so /e/<slug> (which filters
-- state='ready') never shows a half-uploaded set.
CREATE TABLE IF NOT EXISTS event_sets (
  id           TEXT PRIMARY KEY,           -- opaque set id (hex)
  slug         TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  audio_key    TEXT,                       -- R2 key of the faststart .m4a (NULL until uploaded)
  peaks_key    TEXT,                       -- R2 key of peaks.json (NULL until uploaded)
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  recorded_ms  INTEGER NOT NULL DEFAULT 0, -- when the set was recorded (Mac wall clock)
  published_ms INTEGER NOT NULL,           -- when publish-meta landed (sort key)
  state        TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_sets_slug ON event_sets(slug, state, published_ms);

-- publish_events: a cheap append-only audit trail (which install did what,
-- when). Best-effort — a failed insert never blocks a publish.
CREATE TABLE IF NOT EXISTS publish_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  install_id  TEXT NOT NULL,
  slug        TEXT NOT NULL,
  action      TEXT NOT NULL,               -- publish-meta | publish-audio | publish-peaks
  ts_ms       INTEGER NOT NULL
);

-- posts: Phase-2 guest wall (photos/videos/comments the DJ approves). Created
-- now, written later — pre-shaping avoids a migration on live data. Mirrors the
-- Mac-side event.Post/Comment model (pseudonymous author + emoji, DJ approval).
CREATE TABLE IF NOT EXISTS posts (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  author      TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '',
  text        TEXT NOT NULL DEFAULT '',
  media_key   TEXT,                        -- R2 key of an attached photo/video, or NULL
  media_type  TEXT,                        -- image | video | audio | NULL
  approved    INTEGER NOT NULL DEFAULT 0,  -- DJ moderation gate (0 = hidden online)
  ts_ms       INTEGER NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts(slug, approved, ts_ms);
