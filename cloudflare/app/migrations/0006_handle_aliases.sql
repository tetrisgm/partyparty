-- Every handle a group has ever had.
--
-- A handle is an address people already have: in a message, in a calendar
-- subscription, on a printed QR. Renaming must not turn those into a 404, and
-- the old name must never be handed to somebody else - a stranger's night at
-- your old address is worse than a dead link.

CREATE TABLE IF NOT EXISTS group_handles (
  handle     TEXT PRIMARY KEY,
  group_id   TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_group_handles_group ON group_handles(group_id);

-- Backfill: whatever each group is called now is its first alias.
INSERT OR IGNORE INTO group_handles (handle, group_id, created_ms)
  SELECT handle, id, created_ms FROM groups;
