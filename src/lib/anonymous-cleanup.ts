/**
 * Remove anonymous scenarios and auth profiles older than 24h (orphaned after browser close).
 */

import type Database from 'better-sqlite3';

export function cleanupStaleAnonymousData(db: Database.Database): void {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const scenarioIds = db
    .prepare(
      `SELECT id FROM scenarios WHERE owner_type = 'anonymous' AND created_at < ?`
    )
    .all(cutoff) as { id: string }[];

  for (const { id } of scenarioIds) {
    db.transaction(() => {
      db.prepare('DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ?)').run(id);
      db.prepare('DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ?)').run(id);
      db.prepare('DELETE FROM scenario_versions WHERE scenario_id = ?').run(id);
      db.prepare('DELETE FROM runs WHERE scenario_id = ?').run(id);
      db.prepare('DELETE FROM scenarios WHERE id = ?').run(id);
    })();
  }

  db.prepare(`DELETE FROM auth_profiles WHERE owner_type = 'anonymous' AND created_at < ?`).run(cutoff);
}
