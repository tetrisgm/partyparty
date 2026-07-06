-- Follows: a signed-in user follows a DJ profile. One row per (follower, profile).
CREATE TABLE IF NOT EXISTS follows (
  follower_user_id TEXT NOT NULL,
  dj_profile_id    TEXT NOT NULL,
  created_ms       INTEGER NOT NULL,
  PRIMARY KEY (follower_user_id, dj_profile_id)
);

-- "who follows this DJ" (counts / follower lists) and "who does this user follow"
-- (the home "DJs you follow" strip, newest first).
CREATE INDEX IF NOT EXISTS idx_follows_profile ON follows(dj_profile_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower ON follows(follower_user_id, created_ms);
