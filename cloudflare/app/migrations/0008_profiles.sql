-- One profile per person, whichever door they came through.
--
-- A human here is currently two rows: a `djs` row if they run nights and a
-- `members` row if they follow somebody's. That is the right split for what
-- those tables do - one of them sees a sign-in screen and the other never has
-- to - but it is the wrong place for a face and a name. Somebody who runs one
-- group and follows three is one person, and editing their photo should not
-- depend on which of those they happened to open.
--
-- So identity moves out to its own table, keyed by the verified address both
-- sides already agree on. djs.name and members.name stay where they are: they
-- are what a person was called at the moment they acted, and a post signed
-- three years ago should not silently change its author.
--
-- Everything here is optional. A profile with nothing in it but a handle is a
-- complete profile - the point of minting the handle is that anonymity is the
-- default rather than an empty form to fill in.

CREATE TABLE IF NOT EXISTS profiles (
  email_norm TEXT PRIMARY KEY,
  -- The @username. Unique across people AND groups: /@x has to mean one thing,
  -- and it is also reserved in the broker keyspace so it can never collide with
  -- a machine name minted for a Mac.
  handle     TEXT UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  bio        TEXT NOT NULL DEFAULT '',
  avatar_key TEXT,
  -- JSON {instagram,soundcloud,website} - the three the console asks for.
  links      TEXT NOT NULL DEFAULT '{}',
  -- When the person themselves last saved this, as opposed to what arrived
  -- from Apple or Google. NULL means they have never looked at it, which is
  -- what the home page uses to decide whether to offer it. Keying that off
  -- "is the name empty" does not work: both providers hand us a name, so the
  -- welcome would never appear for anybody who signed in normally.
  saved_ms   INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

-- Carry over the names people have already given us, so nobody signs in after
-- this lands and finds themselves anonymous again. No handle: those are minted
-- on first read, which is also what backfills anyone this misses.
INSERT OR IGNORE INTO profiles (email_norm, name, created_ms, updated_ms)
  SELECT email_norm, name, created_ms, created_ms FROM djs WHERE name != '';
INSERT OR IGNORE INTO profiles (email_norm, name, created_ms, updated_ms)
  SELECT email_norm, name, created_ms, created_ms FROM members WHERE name != '';
