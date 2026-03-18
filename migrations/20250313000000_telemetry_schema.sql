-- Idempotent telemetry and scenario/run persistence schema.
-- Order: table creations → indexes. No RLS (SQLite).

-- Scenarios (current definitions; steps stored as JSON)
CREATE TABLE IF NOT EXISTS scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  site_url TEXT NOT NULL,
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT CHECK (last_status IN ('pass', 'fail', 'never'))
);

-- Discoveries (input url/objective, result summary, status)
CREATE TABLE IF NOT EXISTS discoveries (
  id TEXT PRIMARY KEY,
  site_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  input_json TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

-- Runs (execution summary; created before scenario_versions for FK)
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  scenario_name TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'pass', 'fail')),
  error_text TEXT,
  steps_json TEXT,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id)
);

-- Scenario versions (snapshot used at execution time for a run)
CREATE TABLE IF NOT EXISTS scenario_versions (
  id TEXT PRIMARY KEY,
  scenario_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (scenario_id) REFERENCES scenarios(id),
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

-- Run steps (normalized step results for querying)
CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step_index INTEGER NOT NULL,
  instruction TEXT NOT NULL,
  step_type TEXT NOT NULL CHECK (step_type IN ('act', 'extract', 'assert')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'pass', 'fail')),
  error_text TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

-- Append-only telemetry events
CREATE TABLE IF NOT EXISTS telemetry_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  run_id TEXT,
  scenario_id TEXT,
  discovery_id TEXT,
  request_id TEXT,
  trace_id TEXT,
  actor TEXT NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  payload_json TEXT NOT NULL,
  schema_version TEXT NOT NULL
);

-- Run artifacts (file metadata; heavy payloads on disk)
CREATE TABLE IF NOT EXISTS run_artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  step_index INTEGER,
  event_id TEXT,
  file_path TEXT NOT NULL,
  checksum_sha256 TEXT,
  mime_type TEXT,
  byte_size INTEGER,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id),
  FOREIGN KEY (event_id) REFERENCES telemetry_events(event_id)
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_runs_scenario_id ON runs(scenario_id);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at);
CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_run_id ON telemetry_events(run_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_occurred_at ON telemetry_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_scenario_id ON telemetry_events(scenario_id);
CREATE INDEX IF NOT EXISTS idx_telemetry_events_discovery_id ON telemetry_events(discovery_id);
CREATE INDEX IF NOT EXISTS idx_run_artifacts_run_id ON run_artifacts(run_id);
CREATE INDEX IF NOT EXISTS idx_scenario_versions_run_id ON scenario_versions(run_id);
