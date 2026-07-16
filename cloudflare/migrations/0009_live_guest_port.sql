-- The Mac serves its guest listener over HTTPS on a high port (default 8443 —
-- binding 443 needs root). Discovery + the permanent-link router therefore must
-- send guests to <host>:<port>, not the bare host (port 443, nothing listening).
-- Carry the install's actual guest port so both paths build a reachable URL; the
-- Worker falls back to 8443 for installs that predate this column.
ALTER TABLE live_installs ADD COLUMN guest_port INTEGER;
