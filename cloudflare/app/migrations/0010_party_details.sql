-- The rest of a party, and an honest answer to "is it playing right now".
--
-- links: whatever belongs with the night - the ticket page, the set on
-- SoundCloud, the venue's map pin. Stored as typed, one per line, and rendered
-- as links. A party is a thing you look up later, and the links are half of
-- what you are looking for.
--
-- live_url / live_ms: the room a Mac is broadcasting into RIGHT NOW. Both are
-- written by the Mac's own sync heartbeat and neither is a flag anybody sets,
-- because a flag is exactly how a page ends up claiming a party is live hours
-- after the music stopped. live_ms is a timestamp so the claim expires by
-- itself: no heartbeat for a minute and a half and the page stops saying it.
--
-- These are columns on `events` rather than a table of their own: a broadcast
-- is temporary state ON the permanent party, and giving it a table invites
-- treating it as a second kind of party.

ALTER TABLE events ADD COLUMN links    TEXT    NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN live_url TEXT    NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN live_ms  INTEGER NOT NULL DEFAULT 0;
