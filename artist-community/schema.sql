-- The artist discovery app owns these tables; no changes to the upstream music API.
CREATE TABLE IF NOT EXISTS community_users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS community_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS community_sessions_expires_idx ON community_sessions(expires_at);
CREATE TABLE IF NOT EXISTS community_profiles (
  user_id uuid PRIMARY KEY REFERENCES community_users(id) ON DELETE CASCADE,
  artist_id text NOT NULL UNIQUE,
  artist_name text NOT NULL,
  proof_code text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS community_songs (
  id uuid PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  netease_song_id text NOT NULL UNIQUE,
  title text NOT NULL,
  artist text NOT NULL,
  url text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_songs_owner_idx ON community_songs(owner_id);
CREATE TABLE IF NOT EXISTS community_visits (
  song_id uuid NOT NULL REFERENCES community_songs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (song_id, user_id)
);

-- Non-destructive schema upgrades: legacy accounts remain unverified until mail confirmation.
ALTER TABLE community_users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
CREATE TABLE IF NOT EXISTS community_auth_tokens (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_verification','password_reset')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_auth_tokens_user_idx ON community_auth_tokens(user_id, purpose);
CREATE INDEX IF NOT EXISTS community_auth_tokens_expiry_idx ON community_auth_tokens(expires_at);

-- Audited actions use a separate internal table; do not store bearer credentials.
CREATE TABLE IF NOT EXISTS community_audit_log (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  target_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Reviewable content moderation: existing pending/approved rows are preserved.
-- Community moderators can temporarily hide and reinstate previously approved works.
DO 'BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid=c.conrelid
    WHERE t.relname=''community_songs'' AND c.conname=''community_songs_status_check''
      AND pg_get_constraintdef(c.oid) NOT LIKE ''%hidden%''
  ) THEN
    ALTER TABLE community_songs DROP CONSTRAINT community_songs_status_check;
    ALTER TABLE community_songs ADD CONSTRAINT community_songs_status_check
      CHECK (status IN (''pending'', ''approved'', ''hidden''));
  END IF;
END';

CREATE TABLE IF NOT EXISTS community_song_reports (
  id uuid PRIMARY KEY,
  song_id uuid NOT NULL REFERENCES community_songs(id) ON DELETE CASCADE,
  reporter_id uuid NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  reason text NOT NULL CHECK (reason IN ('copyright','impersonation','spam','other')),
  details text NOT NULL DEFAULT '' CHECK (char_length(details) <= 500),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved','dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  UNIQUE (song_id, reporter_id)
);
CREATE INDEX IF NOT EXISTS community_song_reports_status_idx
  ON community_song_reports(status, created_at);
