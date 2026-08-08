-- The personal half of the product: who I saw, and what I thought.
--
-- Everything here belongs to ONE person and nobody else ever reads it. A note
-- about a night, or about running into somebody at it, is the whole reason to
-- keep a record at all, and it is not content - it is a diary. Every table is
-- keyed by the owner's verified address so a query cannot accidentally cross
-- from one person's memory into another's.
--
-- Nothing here requires the people in it to have accounts. Recording that I saw
-- Seth must work whether or not Seth has ever heard of PartyParty; if he turns
-- out to have an account later, `account_email` links the two without changing
-- anything I already wrote.

PRAGMA foreign_keys = ON;

-- Somebody I know. Mine, by name, with an optional link to a real account.
CREATE TABLE IF NOT EXISTS people (
  id            TEXT PRIMARY KEY,
  owner_email   TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- The account this person turned out to be, once I know. Not a foreign key:
  -- I can name somebody years before they sign up, and their record must not
  -- depend on them ever doing so.
  account_email TEXT,
  -- What I generally want to remember about them, as opposed to what happened
  -- on one particular night. Both exist because they are different thoughts.
  note          TEXT NOT NULL DEFAULT '',
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_people_owner ON people(owner_email, name);

-- Somebody at a party: who played, and who I saw. One row is one encounter, so
-- the note lives WITH the pairing rather than being flattened into the person -
-- "he was on fire at the warehouse" and "quieter at the rooftop" are two
-- memories and collapsing them loses both.
CREATE TABLE IF NOT EXISTS party_people (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'guest',  -- dj | guest
  note        TEXT NOT NULL DEFAULT '',
  created_ms  INTEGER NOT NULL,
  PRIMARY KEY (event_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_party_people_person ON party_people(person_id, created_ms);
CREATE INDEX IF NOT EXISTS idx_party_people_event ON party_people(event_id, role);

-- What I thought of the night, and whether I actually went.
--
-- Separate from the event row because the event is the PARTY - shared, public,
-- possibly somebody else's - and this is mine. Two people keeping notes on the
-- same night each get their own.
CREATE TABLE IF NOT EXISTS party_notes (
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_email TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  -- NULL means "not answered", which is different from "did not go".
  attended    INTEGER,
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (event_id, owner_email)
);
