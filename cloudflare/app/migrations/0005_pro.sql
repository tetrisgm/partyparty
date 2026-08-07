-- Pro: a subscription that removes our cut.
--
-- One entitlement, two possible sources. A DJ who subscribes on the web must
-- have Pro in the app and the other way round, so the source is recorded and
-- the answer to "is this group Pro" is the union - never one store's opinion.
--
-- Lifetime is deliberately absent. An unlock that zeroes our cut forever is
-- bought by exactly the DJs selling the most tickets.

CREATE TABLE IF NOT EXISTS entitlements (
  group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,                 -- web | appstore
  state       TEXT NOT NULL DEFAULT 'active', -- active | lapsed
  reference   TEXT NOT NULL DEFAULT '',      -- stripe subscription id, or the app transaction
  renews_ms   INTEGER,
  updated_ms  INTEGER NOT NULL,
  PRIMARY KEY (group_id, source)
);
CREATE INDEX IF NOT EXISTS idx_entitlements_group ON entitlements(group_id, state);
