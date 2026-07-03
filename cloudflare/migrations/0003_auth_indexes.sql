CREATE INDEX IF NOT EXISTS idx_magic_ip ON auth_magic_tokens(request_ip_hash, created_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth_sessions(token_hash);
