-- A party belongs to a person.
--
-- Groups are dead (owner, 2026-08-08). They were an ownership and addressing
-- layer over events, and events were always the real spine: posts, signups,
-- tickets and the whole personal tracker are keyed by event already. The two
-- Mac call sites that looked up a group were only ever trying to reach the
-- person behind it.
--
-- So the owner moves onto the party itself. The address stays /@handle/<slug>,
-- but the handle becomes the PERSON'S @name - which is what the owner meant by
-- "it doesn't seem to understand I have the username shokunin", and what sent a
-- Mac's parties into a forgotten side project called "early testers".
--
-- events.group_id stays and keeps being written while both models exist, so
-- this migration is reversible by deploying the previous worker. G3 removes it.

ALTER TABLE events ADD COLUMN owner_email TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_events_owner ON events(owner_email, starts_ms);

-- Every party that exists now belongs to whoever owns the group it was in. A
-- group with no owner leaves its parties unowned rather than guessing, and they
-- stay reachable by their existing address.
UPDATE events SET owner_email = COALESCE((
  SELECT d.email_norm FROM group_djs gd
    JOIN djs d ON d.id = gd.dj_id
   WHERE gd.group_id = events.group_id AND gd.role = 'owner'
   ORDER BY gd.created_ms LIMIT 1
), '')
WHERE owner_email = '';

-- Any group DJ at all, for a group whose owner row is missing.
UPDATE events SET owner_email = COALESCE((
  SELECT d.email_norm FROM group_djs gd
    JOIN djs d ON d.id = gd.dj_id
   WHERE gd.group_id = events.group_id
   ORDER BY gd.created_ms LIMIT 1
), '')
WHERE owner_email = '';
