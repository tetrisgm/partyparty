-- Who can see the contents of a night.
--
-- Owner, 2026-08-09: "every page can be seen by anyone who follows you.
-- However, the contents of the page is something that you need permission for.
-- The permission is about who can see the contents of this page. Anyone, people
-- who follow me, or only the people I add."
--
-- So the axis changed. It used to be how far the PAGE reached - private, by
-- link, public. It is now how far the CONTENTS reach, with the page itself
-- always open to somebody who follows you:
--
--   public    anyone
--   followers people who follow you
--   named     only the people you added to the night
--
-- The mapping never widens anything. "Private" and "by link" were both "only
-- the people I gave this to", so both become `named`; a link is not a promise
-- that everyone who follows you may read it. Public stays public.
UPDATE events SET visibility = 'named'     WHERE visibility IN ('private', 'link');
UPDATE events SET visibility = 'public'    WHERE visibility = 'public';
UPDATE events SET visibility = 'named'     WHERE visibility IS NULL OR visibility = '';
