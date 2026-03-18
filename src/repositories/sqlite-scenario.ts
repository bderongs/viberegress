/**
 * SQLite implementation of ScenarioRepository. Persists scenarios with steps as JSON.
 */

import type { Scenario, Step } from '../types/index.js';
import type { Owner } from '../types/owner.js';
import type { ScenarioRepository } from './interfaces.js';
import { getDb } from '../lib/db.js';
import { tryAssignLegacyOwner } from '../lib/legacy-owner.js';

function serializeSteps(steps: Step[]): string {
  return JSON.stringify(steps);
}

function deserializeSteps(stepsJson: string): Step[] {
  return JSON.parse(stepsJson) as Step[];
}

function ownerDb(owner: Owner): { ownerType: string; ownerId: string } {
  if (owner.type === 'user') return { ownerType: 'user', ownerId: owner.id };
  return { ownerType: 'anonymous', ownerId: owner.id };
}

export function createScenarioRepository(): ScenarioRepository {
  const db = getDb();

  return {
    save(scenario: Scenario, owner: Owner): void {
      const { ownerType, ownerId } = ownerDb(owner);
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO scenarios (
          id, name, description, site_url, steps_json, created_at, last_run_at, last_status,
          auth_profile_id, starting_webpage, owner_type, owner_id
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        scenario.id,
        scenario.name,
        scenario.description,
        scenario.siteUrl,
        serializeSteps(scenario.steps),
        scenario.createdAt,
        scenario.lastRunAt ?? null,
        scenario.lastStatus ?? null,
        scenario.authProfileId ?? null,
        scenario.startingWebpage ?? null,
        ownerType,
        ownerId
      );
    },

    getById(id: string, owner: Owner): Scenario | undefined {
      const { ownerType, ownerId } = ownerDb(owner);
      const row = db
        .prepare('SELECT * FROM scenarios WHERE id = ? AND owner_type = ? AND owner_id = ?')
        .get(id, ownerType, ownerId) as Row | undefined;
      return row ? rowToScenario(row) : undefined;
    },

    getAll(owner: Owner): Scenario[] {
      if (owner.type === 'user') {
        tryAssignLegacyOwner(db, owner.id);
      }
      const { ownerType, ownerId } = ownerDb(owner);
      const rows = db
        .prepare('SELECT * FROM scenarios WHERE owner_type = ? AND owner_id = ? ORDER BY created_at DESC')
        .all(ownerType, ownerId) as Row[];
      return rows.map(rowToScenario);
    },

    deleteById(id: string, owner: Owner): boolean {
      const { ownerType, ownerId } = ownerDb(owner);
      const exists = db
        .prepare('SELECT 1 FROM scenarios WHERE id = ? AND owner_type = ? AND owner_id = ?')
        .get(id, ownerType, ownerId);
      if (!exists) return false;
      const run = db.transaction(() => {
        db.prepare('DELETE FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ?)').run(id);
        db.prepare('DELETE FROM run_artifacts WHERE run_id IN (SELECT id FROM runs WHERE scenario_id = ?)').run(id);
        db.prepare('DELETE FROM scenario_versions WHERE scenario_id = ?').run(id);
        db.prepare('DELETE FROM runs WHERE scenario_id = ?').run(id);
        const result = db.prepare('DELETE FROM scenarios WHERE id = ? AND owner_type = ? AND owner_id = ?').run(
          id,
          ownerType,
          ownerId
        );
        return result.changes > 0;
      })();
      return run;
    },

    updateStatus(id: string, status: 'pass' | 'fail', lastRunAt: string, owner: Owner): void {
      const { ownerType, ownerId } = ownerDb(owner);
      db.prepare(
        'UPDATE scenarios SET last_status = ?, last_run_at = ? WHERE id = ? AND owner_type = ? AND owner_id = ?'
      ).run(status, lastRunAt, id, ownerType, ownerId);
    },

    updateById(
      id: string,
      data: {
        name: string;
        description: string;
        steps: Step[];
        authProfileId?: string | null;
        startingWebpage?: string | null;
      },
      owner: Owner
    ): void {
      const { ownerType, ownerId } = ownerDb(owner);
      const existing = db
        .prepare('SELECT auth_profile_id, starting_webpage FROM scenarios WHERE id = ? AND owner_type = ? AND owner_id = ?')
        .get(id, ownerType, ownerId) as
        | { auth_profile_id: string | null; starting_webpage: string | null }
        | undefined;
      if (!existing) return;
      const authProfileId = data.authProfileId !== undefined ? data.authProfileId : existing.auth_profile_id ?? null;
      const startingWebpage =
        data.startingWebpage !== undefined ? data.startingWebpage : existing.starting_webpage ?? null;
      db.prepare(
        'UPDATE scenarios SET name = ?, description = ?, steps_json = ?, auth_profile_id = ?, starting_webpage = ? WHERE id = ? AND owner_type = ? AND owner_id = ?'
      ).run(
        data.name,
        data.description,
        serializeSteps(data.steps),
        authProfileId,
        startingWebpage,
        id,
        ownerType,
        ownerId
      );
    },

    claimAnonymousToUser(sessionId: string, userId: string): number {
      const sid = sessionId.trim().toLowerCase();
      const r = db
        .prepare(
          `UPDATE scenarios SET owner_type = 'user', owner_id = ? WHERE owner_type = 'anonymous' AND owner_id = ?`
        )
        .run(userId, sid);
      return r.changes;
    },
  };
}

interface Row {
  id: string;
  name: string;
  description: string;
  site_url: string;
  starting_webpage?: string | null;
  steps_json: string;
  created_at: string;
  last_run_at: string | null;
  last_status: string | null;
  auth_profile_id?: string | null;
}

function rowToScenario(row: Row): Scenario {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    siteUrl: row.site_url,
    startingWebpage: row.starting_webpage ?? undefined,
    steps: deserializeSteps(row.steps_json),
    createdAt: row.created_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: (row.last_status as Scenario['lastStatus']) ?? undefined,
    authProfileId: row.auth_profile_id ?? undefined,
  };
}
