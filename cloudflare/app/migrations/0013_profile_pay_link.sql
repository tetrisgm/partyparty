-- Tipping is a person's, not a group's.
--
-- pay_link sat on `groups` because groups were where a DJ's public identity
-- lived. Their identity is their profile now, which both clients already share,
-- so the link to tip them goes with the rest of who they are.

ALTER TABLE profiles ADD COLUMN pay_link TEXT NOT NULL DEFAULT '';

UPDATE profiles SET pay_link = COALESCE((
  SELECT g.pay_link FROM groups g
    JOIN group_djs gd ON gd.group_id = g.id
    JOIN djs d ON d.id = gd.dj_id
   WHERE d.email_norm = profiles.email_norm AND g.pay_link != ''
   ORDER BY gd.created_ms LIMIT 1
), '')
WHERE pay_link = '';

-- The store a DJ already has, for the same reason: it is theirs, not a group's.
ALTER TABLE profiles ADD COLUMN merch_link  TEXT NOT NULL DEFAULT '';
ALTER TABLE profiles ADD COLUMN merch_label TEXT NOT NULL DEFAULT '';

UPDATE profiles SET
  merch_link = COALESCE((
    SELECT g.merch_link FROM groups g
      JOIN group_djs gd ON gd.group_id = g.id
      JOIN djs d ON d.id = gd.dj_id
     WHERE d.email_norm = profiles.email_norm AND g.merch_link != ''
     ORDER BY gd.created_ms LIMIT 1), ''),
  merch_label = COALESCE((
    SELECT g.merch_label FROM groups g
      JOIN group_djs gd ON gd.group_id = g.id
      JOIN djs d ON d.id = gd.dj_id
     WHERE d.email_norm = profiles.email_norm AND g.merch_link != ''
     ORDER BY gd.created_ms LIMIT 1), '')
WHERE merch_link = '';
