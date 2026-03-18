-- Auth profiles and scenario linkage. Idempotent.

-- Auth profiles (encrypted payload at rest)
CREATE TABLE IF NOT EXISTS auth_profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('session', 'headers_cookies', 'hybrid')),
  payload_cipher TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_profiles_base_url ON auth_profiles(base_url);
-- scenarios.auth_profile_id and idx_scenarios_auth_profile_id are added in db.ts (idempotent).
