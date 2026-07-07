CREATE TABLE IF NOT EXISTS event_aliases (
  old_slug   TEXT PRIMARY KEY,
  slug       TEXT NOT NULL,
  created_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_event_aliases_slug ON event_aliases(slug);
