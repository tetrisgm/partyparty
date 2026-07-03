PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL,
  email_norm        TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL DEFAULT '',
  created_ms        INTEGER NOT NULL,
  updated_ms        INTEGER NOT NULL,
  email_verified_ms INTEGER,
  last_login_ms     INTEGER,
  disabled_ms       INTEGER
);

CREATE TABLE IF NOT EXISTS auth_magic_tokens (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  email_norm     TEXT NOT NULL,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  purpose        TEXT NOT NULL DEFAULT 'login',
  redirect_path  TEXT NOT NULL DEFAULT '/',
  created_ms     INTEGER NOT NULL,
  expires_ms     INTEGER NOT NULL,
  used_ms        INTEGER,
  request_ip_hash TEXT NOT NULL DEFAULT '',
  user_agent_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_magic_email ON auth_magic_tokens(email_norm, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_magic_expires ON auth_magic_tokens(expires_ms);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL,
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_ms      INTEGER NOT NULL,
  expires_ms      INTEGER NOT NULL,
  last_seen_ms    INTEGER NOT NULL,
  revoked_ms      INTEGER,
  request_ip_hash TEXT NOT NULL DEFAULT '',
  user_agent_hash TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON auth_sessions(user_id, expires_ms);

CREATE TABLE IF NOT EXISTS dj_profiles (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  handle             TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL DEFAULT '',
  bio                TEXT NOT NULL DEFAULT '',
  location           TEXT NOT NULL DEFAULT '',
  avatar_key         TEXT,
  hero_key           TEXT,
  website_url        TEXT NOT NULL DEFAULT '',
  instagram_url      TEXT NOT NULL DEFAULT '',
  soundcloud_url     TEXT NOT NULL DEFAULT '',
  spotify_url        TEXT NOT NULL DEFAULT '',
  primary_install_id TEXT,
  published          INTEGER NOT NULL DEFAULT 1,
  created_ms         INTEGER NOT NULL,
  updated_ms         INTEGER NOT NULL,
  last_activity_ms   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_profiles_activity ON dj_profiles(published, last_activity_ms DESC);

CREATE TABLE IF NOT EXISTS featured_profiles (
  profile_id TEXT PRIMARY KEY REFERENCES dj_profiles(id) ON DELETE CASCADE,
  rank       INTEGER NOT NULL DEFAULT 0,
  label      TEXT NOT NULL DEFAULT '',
  starts_ms  INTEGER,
  ends_ms    INTEGER,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_featured_profiles_rank ON featured_profiles(rank, starts_ms, ends_ms);

CREATE TABLE IF NOT EXISTS device_installs (
  install_id   TEXT PRIMARY KEY,
  install_slug TEXT NOT NULL DEFAULT '',
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  profile_id   TEXT REFERENCES dj_profiles(id) ON DELETE SET NULL,
  label        TEXT NOT NULL DEFAULT '',
  created_ms   INTEGER NOT NULL,
  linked_ms    INTEGER,
  last_seen_ms INTEGER,
  revoked_ms   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_device_user ON device_installs(user_id);
CREATE INDEX IF NOT EXISTS idx_device_profile ON device_installs(profile_id);

CREATE TABLE IF NOT EXISTS install_link_tokens (
  id          TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL UNIQUE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  profile_id  TEXT NOT NULL REFERENCES dj_profiles(id) ON DELETE CASCADE,
  install_id  TEXT,
  created_ms  INTEGER NOT NULL,
  expires_ms  INTEGER NOT NULL,
  used_ms     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_install_link_user ON install_link_tokens(user_id, expires_ms);

ALTER TABLE events ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN dj_profile_id TEXT REFERENCES dj_profiles(id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN scheduled_at_ms INTEGER;
ALTER TABLE events ADD COLUMN end_at_ms INTEGER;
ALTER TABLE events ADD COLUMN timezone TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN location_name TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN location_address TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unlisted';
ALTER TABLE events ADD COLUMN rsvp_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'install';
ALTER TABLE events ADD COLUMN published_ms INTEGER;
ALTER TABLE events ADD COLUMN live_started_ms INTEGER;
ALTER TABLE events ADD COLUMN live_ended_ms INTEGER;
ALTER TABLE events ADD COLUMN last_activity_ms INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_events_profile_time ON events(dj_profile_id, scheduled_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_owner_time ON events(owner_user_id, scheduled_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_events_home ON events(visibility, status, scheduled_at_ms);
CREATE INDEX IF NOT EXISTS idx_events_activity ON events(last_activity_ms DESC);

CREATE TABLE IF NOT EXISTS event_rsvps (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  anon_key_hash TEXT,
  name          TEXT NOT NULL DEFAULT '',
  emoji         TEXT NOT NULL DEFAULT '',
  response      TEXT NOT NULL, -- coming | not
  note          TEXT NOT NULL DEFAULT '',
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rsvp_user ON event_rsvps(slug, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rsvp_anon ON event_rsvps(slug, anon_key_hash) WHERE anon_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rsvp_slug ON event_rsvps(slug, response, updated_ms DESC);

ALTER TABLE posts ADD COLUMN author_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN author_cid_hash TEXT;
ALTER TABLE posts ADD COLUMN source TEXT NOT NULL DEFAULT 'mac_sync';
ALTER TABLE posts ADD COLUMN source_install_id TEXT;
ALTER TABLE posts ADD COLUMN dj INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN activity_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN updated_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN approved_ms INTEGER;
ALTER TABLE posts ADD COLUMN deleted_ms INTEGER;
ALTER TABLE posts ADD COLUMN moderation_note TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_posts_wall ON posts(slug, approved, deleted_ms, activity_ms DESC);
CREATE INDEX IF NOT EXISTS idx_posts_author_user ON posts(author_user_id, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_posts_cid ON posts(slug, author_cid_hash);

CREATE TABLE IF NOT EXISTS post_media (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  post_id         TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  media_key       TEXT NOT NULL,
  media_type      TEXT NOT NULL, -- image | video | audio
  mime_type       TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT '',
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  width           INTEGER,
  height          INTEGER,
  duration_ms     INTEGER,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  source_local_id TEXT NOT NULL DEFAULT '',
  created_ms      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_post_media_post ON post_media(post_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_post_media_slug ON post_media(slug, created_ms DESC);

CREATE TABLE IF NOT EXISTS post_comments (
  id              TEXT PRIMARY KEY,
  slug            TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  post_id         TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  author_cid_hash TEXT,
  author          TEXT NOT NULL DEFAULT '',
  emoji           TEXT NOT NULL DEFAULT '',
  text            TEXT NOT NULL DEFAULT '',
  dj              INTEGER NOT NULL DEFAULT 0,
  approved        INTEGER NOT NULL DEFAULT 1,
  ts_ms           INTEGER NOT NULL,
  created_ms      INTEGER NOT NULL,
  updated_ms      INTEGER NOT NULL DEFAULT 0,
  deleted_ms      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON post_comments(post_id, approved, ts_ms);

CREATE TABLE IF NOT EXISTS event_guest_claims (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  cid_hash       TEXT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  pseudonym      TEXT NOT NULL DEFAULT '',
  emoji          TEXT NOT NULL DEFAULT '',
  contact        TEXT NOT NULL DEFAULT '',
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_ms     INTEGER NOT NULL,
  last_synced_ms INTEGER,
  claimed_ms     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_slug_cid ON event_guest_claims(slug, cid_hash);
CREATE INDEX IF NOT EXISTS idx_claim_user ON event_guest_claims(user_id, claimed_ms DESC);

ALTER TABLE publish_events ADD COLUMN user_id TEXT;
ALTER TABLE publish_events ADD COLUMN detail_json TEXT NOT NULL DEFAULT '';
