-- Phase 1 identity backbone: a permanent, confirmable, editable username (handle)
-- for every account. handle_confirmed_ms distinguishes an auto-derived default
-- (NULL -> the /welcome soft-gate prompts the DJ to keep or change it) from a
-- deliberate choice. Existing public profiles are treated as already confirmed
-- so they are never disrupted or re-prompted.

ALTER TABLE dj_profiles ADD COLUMN handle_confirmed_ms INTEGER;
ALTER TABLE dj_profiles ADD COLUMN handle_changed_ms INTEGER;

-- Old handles keep resolving after a username change: /@old 301s to the current
-- handle, and the alias holds the name in the uniqueness namespace so it can't be
-- re-taken. Every availability check consults BOTH dj_profiles.handle and this.
CREATE TABLE IF NOT EXISTS handle_aliases (
  handle      TEXT PRIMARY KEY,
  profile_id  TEXT NOT NULL REFERENCES dj_profiles(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS handle_aliases_profile ON handle_aliases(profile_id);

-- Existing published profiles are already the DJ's chosen public identity: mark
-- them confirmed so the /welcome prompt only fires for genuinely new accounts.
UPDATE dj_profiles SET handle_confirmed_ms = created_ms
  WHERE handle_confirmed_ms IS NULL AND published = 1;
