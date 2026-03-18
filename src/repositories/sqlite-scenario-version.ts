/**
 * SQLite implementation of ScenarioVersionRepository. Stores scenario snapshot per run for forensics.
 */

import type { ScenarioVersionRepository, ScenarioVersionRecord } from './interfaces.js';
import { getDb } from '../lib/db.js';

export function createScenarioVersionRepository(): ScenarioVersionRepository {
  const db = getDb();

  return {
    save(record: ScenarioVersionRecord): void {
      const stmt = db.prepare(`
        INSERT INTO scenario_versions (id, scenario_id, run_id, snapshot_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(record.id, record.scenarioId, record.runId, record.snapshotJson, record.createdAt);
    },

    getByRunId(runId: string): ScenarioVersionRecord | undefined {
      const row = db.prepare('SELECT * FROM scenario_versions WHERE run_id = ?').get(runId) as ScenarioVersionRow | undefined;
      return row ? { id: row.id, scenarioId: row.scenario_id, runId: row.run_id, snapshotJson: row.snapshot_json, createdAt: row.created_at } : undefined;
    },
  };
}

interface ScenarioVersionRow {
  id: string;
  scenario_id: string;
  run_id: string;
  snapshot_json: string;
  created_at: string;
}
