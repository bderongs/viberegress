/**
 * Postgres implementation of ScenarioVersionRepository.
 */

import type { ScenarioVersionRepository, ScenarioVersionRecord } from './interfaces.js';
import { getPgPool } from '../lib/postgres.js';

interface ScenarioVersionRow {
  id: string;
  scenario_id: string;
  run_id: string;
  snapshot_json: string;
  created_at: string;
}

export function createScenarioVersionRepository(): ScenarioVersionRepository {
  const pool = getPgPool();

  return {
    async save(record: ScenarioVersionRecord): Promise<void> {
      await pool.query(
        `INSERT INTO scenario_versions (id, scenario_id, run_id, snapshot_json, created_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [record.id, record.scenarioId, record.runId, record.snapshotJson, record.createdAt]
      );
    },

    async getByRunId(runId: string): Promise<ScenarioVersionRecord | undefined> {
      const result = await pool.query<ScenarioVersionRow>(
        'SELECT * FROM scenario_versions WHERE run_id = $1',
        [runId]
      );
      const row = result.rows[0];
      if (!row) return undefined;
      return {
        id: row.id,
        scenarioId: row.scenario_id,
        runId: row.run_id,
        snapshotJson: row.snapshot_json,
        createdAt: row.created_at,
      };
    },
  };
}
