-- Per-user / anonymous session ownership. Legacy rows become claimable by first signed-in user.

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

ALTER TABLE scenarios ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'anonymous';
ALTER TABLE scenarios ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

ALTER TABLE auth_profiles ADD COLUMN owner_type TEXT NOT NULL DEFAULT 'anonymous';
ALTER TABLE auth_profiles ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';

-- Existing installs: one-time pool for first authenticated user
UPDATE scenarios SET owner_type = 'user', owner_id = 'legacy-unclaimed' WHERE owner_id = '' OR owner_id IS NULL;
UPDATE auth_profiles SET owner_type = 'user', owner_id = 'legacy-unclaimed' WHERE owner_id = '' OR owner_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_scenarios_owner ON scenarios(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_auth_profiles_owner ON auth_profiles(owner_type, owner_id);
