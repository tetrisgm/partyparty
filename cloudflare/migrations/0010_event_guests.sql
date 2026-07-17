-- Web guests joining a live party get the same identity ask as LAN guests:
-- name / emoji / optional email ("email updates from the party host"). One row
-- per guest per event, keyed like event_rsvps (signed-in user OR the anon
-- cookie hash minted by rsvpIdentity — the same cookie, so RSVP + join share
-- one identity). Email is stored for the HOST; never surfaced publicly.
CREATE TABLE IF NOT EXISTS event_guests (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL REFERENCES events(slug) ON DELETE CASCADE,
  user_id       TEXT,
  anon_key_hash TEXT,
  name          TEXT NOT NULL DEFAULT '',
  emoji         TEXT NOT NULL DEFAULT '',
  email         TEXT NOT NULL DEFAULT '',
  source        TEXT NOT NULL DEFAULT 'web-live',
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_user ON event_guests(slug, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_anon ON event_guests(slug, anon_key_hash) WHERE anon_key_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_guest_slug ON event_guests(slug);
