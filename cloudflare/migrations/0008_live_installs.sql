-- Phase 2/3 live presence registry: which install is broadcasting right now, on
-- which public IP (hashed), and where its LAN listener + cloud mirror live. This
-- is the source of truth for three surfaces:
--   * GET /api/discover        — same-Wi-Fi auto-discovery (match on public_ip_hash)
--   * <handle>.party.ramine.net — the proxied host router (LOCAL 302 / REMOTE / IDLE)
--   * the 1-minute cron GC      — expire dead rows + drop orphaned grey A records
--
-- Correctness lives in the read path (every read filters expires_ms>now); the row
-- is written every ~30s while live with a 90s TTL, and deleted on a clean /offline.
--
-- public_ip_hash is ALWAYS sha256("ip:"+cf-connecting-ip) computed at the edge —
-- never a Mac-supplied value (a Mac can't know its NAT egress IP and a client
-- value is spoofable). handle/profile_id/dj_name are resolved server-side from
-- device_installs -> dj_profiles so a party can never impersonate another handle.
--
-- Two hostnames, never conflated:
--   * handle  — the PROXIED permanent guest link <handle>.party.ramine.net (Worker)
--   * host    — the grey local slug host <slug>.party.ramine.net (grey A -> lan_ip,
--               served by the Mac's own LE cert; the tight LAN LL-HLS lives there)
-- The grey A record the broker writes is for `host` (the slug), NEVER the handle.
CREATE TABLE IF NOT EXISTS live_installs (
  install_id      TEXT PRIMARY KEY,            -- broker install id (the live Mac)
  handle          TEXT NOT NULL DEFAULT '',    -- proxied router name (dj handle)
  profile_id      TEXT,                         -- dj_profiles.id this install is linked to
  public_ip_hash  TEXT NOT NULL DEFAULT '',    -- sha256("ip:"+cf-connecting-ip), edge-derived
  host            TEXT NOT NULL DEFAULT '',    -- grey LAN slug host, e.g. disco12.party.ramine.net
  lan_ip          TEXT NOT NULL DEFAULT '',    -- the Mac's current LAN IP (grey A target)
  event_slug      TEXT NOT NULL DEFAULT '',    -- event slug the cloud mirror is uploaded under
  dj_name         TEXT NOT NULL DEFAULT '',    -- display_name, denormalized for /api/discover
  event_title     TEXT NOT NULL DEFAULT '',    -- DJ-authored title (escape at render)
  listeners       INTEGER NOT NULL DEFAULT 0,
  now_playing     TEXT NOT NULL DEFAULT '',    -- DJ-authored track (escape at render)
  live_started_ms INTEGER NOT NULL DEFAULT 0,  -- set once; the which-Mac-wins tiebreak
  last_seen_ms    INTEGER NOT NULL DEFAULT 0,
  expires_ms      INTEGER NOT NULL DEFAULT 0   -- now + 90s each heartbeat; read path filters on this
);

-- Reverse lookup for auto-discovery: parties on the caller's egress IP, still live.
CREATE INDEX IF NOT EXISTS idx_live_ip ON live_installs(public_ip_hash, expires_ms);
-- Cron GC scans expired rows.
CREATE INDEX IF NOT EXISTS idx_live_expires ON live_installs(expires_ms);
-- Router claimant lookup: newest go-live for a handle wins.
CREATE INDEX IF NOT EXISTS idx_live_handle ON live_installs(handle, live_started_ms);

-- dj_profiles.primary_install_id already exists (migration 0002): reuse it as the
-- manual which-Mac tiebreak that overrides most-recent-go-live. No ALTER needed.
