-- Paid entry. A ticket is a signup that was paid for, so the signup stays the
-- single answer to "who is coming" and this table only records the money.
--
-- The id is the Stripe checkout session, which makes a retried webhook a
-- no-op rather than a second seat sold.

CREATE TABLE IF NOT EXISTS tickets (
  id             TEXT PRIMARY KEY,
  event_id       TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id      TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  code           TEXT NOT NULL DEFAULT '',
  amount         INTEGER NOT NULL DEFAULT 0,
  stripe_payment TEXT NOT NULL DEFAULT '',
  state          TEXT NOT NULL DEFAULT 'paid',   -- paid | refunded
  created_ms     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);

-- Tips recorded for the DJ's own total. The money never touches us; this is
-- only so a DJ can see what a night brought in.
CREATE TABLE IF NOT EXISTS tips (
  id             TEXT PRIMARY KEY,
  group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  event_id       TEXT REFERENCES events(id) ON DELETE SET NULL,
  amount         INTEGER NOT NULL DEFAULT 0,
  stripe_payment TEXT NOT NULL DEFAULT '',
  created_ms     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tips_group ON tips(group_id, created_ms);
