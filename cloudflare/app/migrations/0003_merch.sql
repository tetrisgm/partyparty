-- Merch is a link to the store the DJ already has.
--
-- Holding stock, printing, posting and taking returns is a different company.
-- A link costs nothing to run and is the whole of what most DJs want: the
-- shirts exist somewhere already.

ALTER TABLE groups ADD COLUMN merch_link TEXT NOT NULL DEFAULT '';
ALTER TABLE groups ADD COLUMN merch_label TEXT NOT NULL DEFAULT '';
