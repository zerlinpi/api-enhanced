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
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS community_songs_owner_idx ON community_songs(owner_id);
CREATE TABLE IF NOT EXISTS community_visits (
  song_id uuid NOT NULL REFERENCES community_songs(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES community_users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (song_id, user_id)
);
