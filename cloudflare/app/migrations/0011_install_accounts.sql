-- A Mac belongs to a PERSON, not to a group.
--
-- install_groups bound a Mac to one group and made the DJ choose which, so
-- signing in on the Mac asked "link to which of your groups?" - a question
-- about a concept the person may not have and certainly did not ask for. Two
-- call sites already gave the game away: they joined install_groups to
-- group_djs to djs purely to find out WHO the Mac belonged to, hopping through
-- a group to reach a person.
--
-- Signing in is the whole of it now: this Mac is mine. Wherever a group is
-- actually needed - a party has to live somewhere with an address - it is
-- resolved from the account on demand, the same way the web does it, and made
-- from their @name if they have none.
--
-- install_groups is left in place and unread. Macs in the field call the same
-- endpoints, the backfill below carries every one of them across, and dropping
-- a table underneath a live install is a worse trade than leaving a dead one.

CREATE TABLE IF NOT EXISTS install_accounts (
  install_id TEXT PRIMARY KEY,
  email_norm TEXT NOT NULL,
  linked_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_install_accounts_email ON install_accounts(email_norm);

-- Every Mac already linked keeps working, now bound to the person who owns the
-- group it was pointed at. A group with no DJ leaves its install unbound, which
-- is the honest answer: there is no person to attribute it to.
INSERT OR IGNORE INTO install_accounts (install_id, email_norm, linked_ms)
SELECT ig.install_id, d.email_norm, ig.linked_ms
  FROM install_groups ig
  JOIN group_djs gd ON gd.group_id = ig.group_id
  JOIN djs d ON d.id = gd.dj_id
 WHERE d.email_norm != '';
