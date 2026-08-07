-- Linking a Mac to a group, so a party can find the night it is playing.
--
-- The Mac shows a short code and the DJ, already signed in on the web, types
-- it into their group. That direction matters: the Mac never needs a browser
-- session or a password, and a code that is seen is a code someone is standing
-- in front of.

CREATE TABLE IF NOT EXISTS install_groups (
  install_id TEXT PRIMARY KEY,          -- the broker install id, as the Mac knows itself
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  label      TEXT NOT NULL DEFAULT '',
  linked_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_install_groups_group ON install_groups(group_id);

-- Short-lived and single use. Short enough to read off a screen, which is why
-- it expires in minutes rather than days.
CREATE TABLE IF NOT EXISTS install_codes (
  code       TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  used_ms    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_install_codes_expires ON install_codes(expires_ms);
