/**
 * SQLite implementation of RunRepository and RunStepRepository. Persists runs and normalized run_steps.
 */

import type { TestRun, StepResult } from '../types/index.js';
import type { RunRepository, RunStepRecord } from './interfaces.js';
import { getDb } from '../lib/db.js';

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

export function createRunRepository(): RunRepository {
  const db = getDb();

  return {
    save(run: TestRun): void {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO runs (id, scenario_id, scenario_name, started_at, finished_at, status, error_text, steps_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        run.id,
        run.scenarioId,
        run.scenarioName,
        run.startedAt,
        run.finishedAt ?? null,
        run.status,
        run.error ?? null,
        serializeSteps(run.steps)
      );
      // Persist normalized run_steps for querying
      db.prepare('DELETE FROM run_steps WHERE run_id = ?').run(run.id);
      const stepStmt = db.prepare(`
        INSERT INTO run_steps (run_id, step_index, instruction, step_type, status, error_text, duration_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (let i = 0; i < run.steps.length; i++) {
        const s = run.steps[i];
        const stepType = s.type ?? 'act';
        stepStmt.run(
          run.id,
          i,
          s.instruction,
          stepType,
          s.status,
          s.error ?? null,
          s.durationMs ?? null
        );
      }
    },

    getById(id: string): TestRun | undefined {
      const row = db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
      return row ? rowToRun(row) : undefined;
    },

    getByScenarioId(scenarioId: string): TestRun[] {
      const rows = db.prepare('SELECT * FROM runs WHERE scenario_id = ? ORDER BY started_at DESC').all(scenarioId) as RunRow[];
      return rows.map(rowToRun);
    },
  };
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

export function createRunStepRepository() {
  const db = getDb();
  return {
    getByRunId(runId: string): RunStepRecord[] {
      const rows = db.prepare('SELECT run_id, step_index, instruction, step_type, status, error_text, duration_ms FROM run_steps WHERE run_id = ? ORDER BY step_index').all(runId) as RunStepRow[];
      return rows.map(r => ({
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

interface RunStepRow {
  run_id: string;
  step_index: number;
  instruction: string;
  step_type: 'act' | 'extract' | 'assert';
  status: 'pending' | 'pass' | 'fail';
  error_text: string | null;
  duration_ms: number | null;
}
