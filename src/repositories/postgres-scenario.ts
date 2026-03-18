/**
 * Postgres implementation of ScenarioRepository.
 */

import type { Scenario, Step } from '../types/index.js';
import type { Owner } from '../types/owner.js';
import type { ScenarioRepository } from './interfaces.js';
import { getPgPool } from '../lib/postgres.js';

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

interface Row {
  id: string;
  name: string;
  description: string;
  site_url: string;
  starting_webpage: string | null;
  steps_json: string;
  created_at: string;
  last_run_at: string | null;
  last_status: string | null;
  auth_profile_id: string | null;
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

export function createScenarioRepository(): ScenarioRepository {
  const pool = getPgPool();

  return {
    async save(scenario: Scenario, owner: Owner): Promise<void> {
      const { ownerType, ownerId } = ownerDb(owner);
      await pool.query(
        `INSERT INTO scenarios (
          id, name, description, site_url, steps_json, created_at, last_run_at, last_status,
          auth_profile_id, starting_webpage, owner_type, owner_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          description = EXCLUDED.description,
          site_url = EXCLUDED.site_url,
          steps_json = EXCLUDED.steps_json,
          created_at = EXCLUDED.created_at,
          last_run_at = EXCLUDED.last_run_at,
          last_status = EXCLUDED.last_status,
          auth_profile_id = EXCLUDED.auth_profile_id,
          starting_webpage = EXCLUDED.starting_webpage,
          owner_type = EXCLUDED.owner_type,
          owner_id = EXCLUDED.owner_id`,
        [
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
          ownerId,
        ]
      );
    },

    async getById(id: string, owner: Owner): Promise<Scenario | undefined> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query<Row>(
        `SELECT * FROM scenarios
         WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      return result.rows[0] ? rowToScenario(result.rows[0]) : undefined;
    },

    async getAll(owner: Owner): Promise<Scenario[]> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query<Row>(
        `SELECT * FROM scenarios
         WHERE owner_type = $1 AND owner_id = $2
         ORDER BY created_at DESC`,
        [ownerType, ownerId]
      );
      return result.rows.map(rowToScenario);
    },

    async deleteById(id: string, owner: Owner): Promise<boolean> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query(
        `DELETE FROM scenarios WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      return (result.rowCount ?? 0) > 0;
    },

    async updateStatus(id: string, status: 'pass' | 'fail', lastRunAt: string, owner: Owner): Promise<void> {
      const { ownerType, ownerId } = ownerDb(owner);
      await pool.query(
        `UPDATE scenarios
         SET last_status = $1, last_run_at = $2
         WHERE id = $3 AND owner_type = $4 AND owner_id = $5`,
        [status, lastRunAt, id, ownerType, ownerId]
      );
    },

    async updateById(
      id: string,
      data: {
        name: string;
        description: string;
        steps: Step[];
        authProfileId?: string | null;
        startingWebpage?: string | null;
      },
      owner: Owner
    ): Promise<void> {
      const { ownerType, ownerId } = ownerDb(owner);
      const existingResult = await pool.query<{ auth_profile_id: string | null; starting_webpage: string | null }>(
        `SELECT auth_profile_id, starting_webpage
         FROM scenarios
         WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      const existing = existingResult.rows[0];
      if (!existing) return;
      const authProfileId = data.authProfileId !== undefined ? data.authProfileId : existing.auth_profile_id ?? null;
      const startingWebpage =
        data.startingWebpage !== undefined ? data.startingWebpage : existing.starting_webpage ?? null;
      await pool.query(
        `UPDATE scenarios
         SET name = $1, description = $2, steps_json = $3, auth_profile_id = $4, starting_webpage = $5
         WHERE id = $6 AND owner_type = $7 AND owner_id = $8`,
        [data.name, data.description, serializeSteps(data.steps), authProfileId, startingWebpage, id, ownerType, ownerId]
      );
    },

    async claimAnonymousToUser(sessionId: string, userId: string): Promise<number> {
      const sid = sessionId.trim().toLowerCase();
      const result = await pool.query(
        `UPDATE scenarios
         SET owner_type = 'user', owner_id = $1
         WHERE owner_type = 'anonymous' AND owner_id = $2`,
        [userId, sid]
      );
      return result.rowCount ?? 0;
    },
  };
}
