-- The app is a journal.
--
-- Owner, 2026-08-08: "I'm at a party and I say this DJ, this place, these songs
-- are played and I write some notes." A party is a name, a place and a DAY -
-- not a time; nobody journalling a night cares that it started at 21:00. What
-- goes in it is people, songs, notes and photos, and the input has to be as
-- easy as Apple's Journal or it does not get used at the party.
--
-- Three things the model was missing.

-- 1. SONGS. What was played, in the order it was played, optionally credited to
-- whoever played it. The heart of remembering a night and the one thing there
-- was nowhere to put.
CREATE TABLE IF NOT EXISTS songs (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL DEFAULT '',
  -- Who played it, when that is somebody on the bill. Not a foreign key on
  -- purpose: most songs are remembered without deciding whose set they were in.
  person_id   TEXT,
  -- Ordering is the order they were added, which at a party is the order they
  -- were played. A number rather than the clock, so a song added from memory
  -- the next morning can be dropped into place.
  seq         INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT '',
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_songs_event ON songs(event_id, seq, created_ms);

-- 2. WHO CAN SEE IT, and who can add to it. Everything is mine by default; a
-- party becomes shared only when I hand out its link, and public only when I
-- say so. "Invite only with the link, or public" - the two the owner named.
ALTER TABLE events ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
  -- private | link | public

-- A day rather than a moment. starts_ms stays: it is what upcoming/past is read
-- from and what a broadcast uses. This says the time on it means nothing and
-- must not be shown, which is true of every party typed into a journal.
ALTER TABLE events ADD COLUMN day_only INTEGER NOT NULL DEFAULT 1;

-- Existing parties keep their behaviour: they were made when a time was part of
-- the form, and they were shared by having a public page.
UPDATE events SET visibility = 'public', day_only = 0;

-- 3. FOLLOWING A PERSON, private by default. Groups are dead, so membership of
-- one cannot be how anybody hears about anybody. Following is one person
-- choosing to hear about another's parties, and whether that choice is visible
-- to anyone else is the follower's to make.
CREATE TABLE IF NOT EXISTS follows (
  follower_email TEXT NOT NULL,
  person_email   TEXT NOT NULL,
  public         INTEGER NOT NULL DEFAULT 0,
  created_ms     INTEGER NOT NULL,
  PRIMARY KEY (follower_email, person_email)
);
CREATE INDEX IF NOT EXISTS idx_follows_person ON follows(person_email);

-- Everybody already following a group now follows the person who owns it, and
-- privately, because nobody consented to it being seen.
INSERT OR IGNORE INTO follows (follower_email, person_email, public, created_ms)
SELECT m.email_norm, d.email_norm, 0, gm.joined_ms
  FROM group_members gm
  JOIN members m ON m.id = gm.member_id
  JOIN group_djs gd ON gd.group_id = gm.group_id
  JOIN djs d ON d.id = gd.dj_id
 WHERE gm.state = 'joined' AND m.email_norm != '' AND d.email_norm != ''
   AND m.email_norm != d.email_norm;
