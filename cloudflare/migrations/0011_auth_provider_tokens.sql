CREATE TABLE IF NOT EXISTS auth_provider_tokens (
  provider      TEXT NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_sub  TEXT NOT NULL DEFAULT '',
  revoke_token  TEXT NOT NULL,
  token_kind    TEXT NOT NULL DEFAULT 'refresh_token',
  created_ms    INTEGER NOT NULL,
  updated_ms    INTEGER NOT NULL,
  PRIMARY KEY (provider, user_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_provider_sub
  ON auth_provider_tokens(provider, provider_sub);
