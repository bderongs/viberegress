-- VibeRegress schema for Supabase Postgres.
-- Run in Supabase SQL Editor before enabling Postgres repository mode.

-- Scenarios
CREATE TABLE IF NOT EXISTS public.scenarios (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL,
  site_url text NOT NULL,
  steps_json text NOT NULL,
  created_at text NOT NULL,
  last_run_at text,
  last_status text CHECK (last_status IN ('pass', 'fail', 'never')),
  auth_profile_id text,
  starting_webpage text,
  owner_type text NOT NULL CHECK (owner_type IN ('anonymous', 'user')),
  owner_id text NOT NULL
);

-- Discoveries
CREATE TABLE IF NOT EXISTS public.discoveries (
  id text PRIMARY KEY,
  site_url text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  input_json text,
  result_json text,
  created_at text NOT NULL,
  completed_at text
);

-- Auth profiles
CREATE TABLE IF NOT EXISTS public.auth_profiles (
  id text PRIMARY KEY,
  name text NOT NULL,
  base_url text NOT NULL,
  mode text NOT NULL CHECK (mode IN ('session', 'headers_cookies', 'hybrid')),
  payload_cipher text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  owner_type text NOT NULL CHECK (owner_type IN ('anonymous', 'user')),
  owner_id text NOT NULL
);

-- Link scenarios to auth profiles if configured.
ALTER TABLE public.scenarios
  DROP CONSTRAINT IF EXISTS scenarios_auth_profile_fk;
ALTER TABLE public.scenarios
  ADD CONSTRAINT scenarios_auth_profile_fk
  FOREIGN KEY (auth_profile_id) REFERENCES public.auth_profiles(id) ON DELETE SET NULL;

-- Runs and derived run tables
CREATE TABLE IF NOT EXISTS public.runs (
  id text PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  scenario_name text NOT NULL,
  started_at text NOT NULL,
  finished_at text,
  status text NOT NULL CHECK (status IN ('running', 'pass', 'fail')),
  error_text text,
  steps_json text
);

CREATE TABLE IF NOT EXISTS public.scenario_versions (
  id text PRIMARY KEY,
  scenario_id text NOT NULL REFERENCES public.scenarios(id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  snapshot_json text NOT NULL,
  created_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.run_steps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  step_index integer NOT NULL,
  instruction text NOT NULL,
  step_type text NOT NULL CHECK (step_type IN ('act', 'extract', 'assert')),
  status text NOT NULL CHECK (status IN ('pending', 'pass', 'fail')),
  error_text text,
  duration_ms integer
);

CREATE TABLE IF NOT EXISTS public.telemetry_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  occurred_at text NOT NULL,
  run_id text,
  scenario_id text,
  discovery_id text,
  request_id text,
  trace_id text,
  actor text NOT NULL,
  level text NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  payload_json text NOT NULL,
  schema_version text NOT NULL
);

CREATE TABLE IF NOT EXISTS public.run_artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES public.runs(id) ON DELETE CASCADE,
  step_index integer,
  event_id text REFERENCES public.telemetry_events(event_id) ON DELETE SET NULL,
  file_path text NOT NULL,
  checksum_sha256 text,
  mime_type text,
  byte_size integer,
  created_at text NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_scenarios_owner ON public.scenarios(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_auth_profiles_owner ON public.auth_profiles(owner_type, owner_id);
CREATE INDEX IF NOT EXISTS idx_auth_profiles_base_url ON public.auth_profiles(base_url);
CREATE INDEX IF NOT EXISTS idx_runs_scenario_id ON public.runs(scenario_id);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON public.runs(started_at);
CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON public.run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_run_id ON public.telemetry_events(run_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_scenario_id ON public.telemetry_events(scenario_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_discovery_id ON public.telemetry_events(discovery_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_occurred_at ON public.telemetry_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_id ON public.run_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_scenario_versions_run_id ON public.scenario_versions(run_id);

-- Magic links: public read-only access to a site workspace (scenarios)
CREATE TABLE IF NOT EXISTS public.site_share_links (
  id text PRIMARY KEY,
  token text NOT NULL UNIQUE,
  owner_user_id text NOT NULL,
  site_url text NOT NULL,
  created_at text NOT NULL,
  revoked_at text,
  expires_at text,
  allow_public_read boolean NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_site_share_links_token ON public.site_share_links(token);
CREATE INDEX IF NOT EXISTS idx_site_share_links_owner_site ON public.site_share_links(owner_user_id, site_url);
