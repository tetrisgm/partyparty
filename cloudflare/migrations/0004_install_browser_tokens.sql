CREATE TABLE IF NOT EXISTS install_browser_tokens (
  id              TEXT PRIMARY KEY,
  token_hash      TEXT NOT NULL UNIQUE,
  install_id      TEXT NOT NULL,
  install_slug    TEXT NOT NULL DEFAULT '',
  created_ms      INTEGER NOT NULL,
  expires_ms      INTEGER NOT NULL,
  used_ms         INTEGER,
  request_ip_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_install_browser_install ON install_browser_tokens(install_id, expires_ms);
CREATE INDEX IF NOT EXISTS idx_install_browser_expires ON install_browser_tokens(expires_ms);
