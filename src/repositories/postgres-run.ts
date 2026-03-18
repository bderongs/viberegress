/**
 * Postgres implementation of RunRepository and RunStepRepository.
 */

import type { TestRun, StepResult } from '../types/index.js';
import type { RunRepository, RunStepRecord, RunStepRepository } from './interfaces.js';
import { getPgPool } from '../lib/postgres.js';

function serializeSteps(steps: StepResult[]): string {
  return JSON.stringify(steps);
}

function deserializeSteps(stepsJson: string | null): StepResult[] {
  if (!stepsJson) return [];
  return JSON.parse(stepsJson) as StepResult[];
}

interface RunRow {
  id: string;
  scenario_id: string;
  scenario_name: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  error_text: string | null;
  steps_json: string | null;
}

function rowToRun(row: RunRow): TestRun {
  return {
    id: row.id,
    scenarioId: row.scenario_id,
    scenarioName: row.scenario_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    status: row.status as TestRun['status'],
    error: row.error_text ?? undefined,
    steps: deserializeSteps(row.steps_json),
  };
}

export function createRunRepository(): RunRepository {
  const pool = getPgPool();

  return {
    async save(run: TestRun): Promise<void> {
      await pool.query(
        `INSERT INTO runs (id, scenario_id, scenario_name, started_at, finished_at, status, error_text, steps_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET
           scenario_id = EXCLUDED.scenario_id,
           scenario_name = EXCLUDED.scenario_name,
           started_at = EXCLUDED.started_at,
           finished_at = EXCLUDED.finished_at,
           status = EXCLUDED.status,
           error_text = EXCLUDED.error_text,
           steps_json = EXCLUDED.steps_json`,
        [
          run.id,
          run.scenarioId,
          run.scenarioName,
          run.startedAt,
          run.finishedAt ?? null,
          run.status,
          run.error ?? null,
          serializeSteps(run.steps),
        ]
      );

      await pool.query('DELETE FROM run_steps WHERE run_id = $1', [run.id]);
      for (let i = 0; i < run.steps.length; i++) {
        const s = run.steps[i];
        const stepType = s.type ?? 'act';
        await pool.query(
          `INSERT INTO run_steps (run_id, step_index, instruction, step_type, status, error_text, duration_ms)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [run.id, i, s.instruction, stepType, s.status, s.error ?? null, s.durationMs ?? null]
        );
      }
    },

    async getById(id: string): Promise<TestRun | undefined> {
      const result = await pool.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
      return result.rows[0] ? rowToRun(result.rows[0]) : undefined;
    },

    async getByScenarioId(scenarioId: string): Promise<TestRun[]> {
      const result = await pool.query<RunRow>(
        'SELECT * FROM runs WHERE scenario_id = $1 ORDER BY started_at DESC',
        [scenarioId]
      );
      return result.rows.map(rowToRun);
    },

    async countRunsForUserInUtcMonth(
      userId: string,
      periodStartUtc: string,
      periodEndExclusiveUtc: string
    ): Promise<number> {
      const result = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c
         FROM runs r
         INNER JOIN scenarios s ON s.id = r.scenario_id
         WHERE s.owner_type = 'user' AND s.owner_id = $1
           AND r.started_at >= $2 AND r.started_at < $3`,
        [userId, periodStartUtc, periodEndExclusiveUtc]
      );
      const row = result.rows[0];
      return row ? parseInt(row.c, 10) || 0 : 0;
    },
  };
}

interface RunStepRow {
  run_id: string;
  step_index: number;
  instruction: string;
  step_type: 'act' | 'extract' | 'assert';
  status: 'pending' | 'pass' | 'fail';
  error_text: string | null;
  duration_ms: number | null;
}

export function createRunStepRepository(): RunStepRepository {
  const pool = getPgPool();
  return {
    async getByRunId(runId: string): Promise<RunStepRecord[]> {
      const result = await pool.query<RunStepRow>(
        `SELECT run_id, step_index, instruction, step_type, status, error_text, duration_ms
         FROM run_steps
         WHERE run_id = $1
         ORDER BY step_index`,
        [runId]
      );
      return result.rows.map((r) => ({
        runId: r.run_id,
        stepIndex: r.step_index,
        instruction: r.instruction,
        stepType: r.step_type,
        status: r.status,
        errorText: r.error_text,
        durationMs: r.duration_ms,
      }));
    },
  };
}
