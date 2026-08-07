-- Old handles do not resolve. If someone changes their address, they changed
-- their address (owner, 2026-08-07) - keeping every name a group ever had is
-- machinery for a problem they do not have.
--
-- The old handle stays RESERVED in the broker keyspace, which costs nothing and
-- means it is never handed to a stranger. It simply stops answering.
DROP TABLE IF EXISTS group_handles;
