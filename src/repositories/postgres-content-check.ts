/**
 * Postgres implementation of ContentCheckRepository.
 */

import type { ContentCheckRepository, ContentCheckRecord } from './interfaces.js';
import type { Owner } from '../types/owner.js';
import { getPgPool } from '../lib/postgres.js';

function ownerDb(owner: Owner): { ownerType: string; ownerId: string } {
  if (owner.type === 'user') return { ownerType: 'user', ownerId: owner.id };
  return { ownerType: 'anonymous', ownerId: owner.id };
}

interface ContentCheckRow {
  id: string;
  site_url: string;
  status: string;
  input_json: string | null;
  result_json: string | null;
  created_at: string;
  completed_at: string | null;
}

function rowToRecord(row: ContentCheckRow): ContentCheckRecord {
  return {
    id: row.id,
    siteUrl: row.site_url,
    status: row.status as ContentCheckRecord['status'],
    inputJson: row.input_json,
    resultJson: row.result_json,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function createContentCheckRepository(): ContentCheckRepository {
  const pool = getPgPool();

  return {
    async save(record: ContentCheckRecord, owner: Owner): Promise<void> {
      const { ownerType, ownerId } = ownerDb(owner);
      await pool.query(
        `INSERT INTO content_checks (
          id, site_url, status, input_json, result_json, created_at, completed_at,
          owner_type, owner_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (id) DO UPDATE SET
           site_url = EXCLUDED.site_url,
           status = EXCLUDED.status,
           input_json = EXCLUDED.input_json,
           result_json = EXCLUDED.result_json,
           created_at = EXCLUDED.created_at,
           completed_at = EXCLUDED.completed_at,
           owner_type = EXCLUDED.owner_type,
           owner_id = EXCLUDED.owner_id`,
        [
          record.id,
          record.siteUrl,
          record.status,
          record.inputJson ?? null,
          record.resultJson ?? null,
          record.createdAt,
          record.completedAt ?? null,
          ownerType,
          ownerId,
        ]
      );
    },

    async getById(id: string, owner: Owner): Promise<ContentCheckRecord | undefined> {
      const { ownerType, ownerId } = ownerDb(owner);
      const result = await pool.query<ContentCheckRow>(
        `SELECT * FROM content_checks WHERE id = $1 AND owner_type = $2 AND owner_id = $3`,
        [id, ownerType, ownerId]
      );
      return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
    },

    async listByOwner(
      owner: Owner,
      options?: { siteUrl?: string; limit?: number }
    ): Promise<ContentCheckRecord[]> {
      const { ownerType, ownerId } = ownerDb(owner);
      const limit = Math.min(100, Math.max(1, options?.limit ?? 50));
      const site = options?.siteUrl?.trim() || null;
      const result = await pool.query<ContentCheckRow>(
        `SELECT * FROM content_checks
         WHERE owner_type = $1 AND owner_id = $2
         AND ($3::text IS NULL OR site_url = $3)
         ORDER BY created_at DESC
         LIMIT $4`,
        [ownerType, ownerId, site, limit]
      );
      return result.rows.map(rowToRecord);
    },

    async updateStatus(
      id: string,
      owner: Owner,
      status: ContentCheckRecord['status'],
      resultJson?: string | null,
      completedAt?: string
    ): Promise<void> {
      const { ownerType, ownerId } = ownerDb(owner);
      if (resultJson !== undefined && completedAt !== undefined) {
        await pool.query(
          `UPDATE content_checks SET status = $1, result_json = $2, completed_at = $3
           WHERE id = $4 AND owner_type = $5 AND owner_id = $6`,
          [status, resultJson, completedAt, id, ownerType, ownerId]
        );
      } else if (completedAt !== undefined) {
        await pool.query(
          `UPDATE content_checks SET status = $1, completed_at = $2
           WHERE id = $3 AND owner_type = $4 AND owner_id = $5`,
          [status, completedAt, id, ownerType, ownerId]
        );
      } else {
        await pool.query(
          `UPDATE content_checks SET status = $1 WHERE id = $2 AND owner_type = $3 AND owner_id = $4`,
          [status, id, ownerType, ownerId]
        );
      }
    },
  };
}
