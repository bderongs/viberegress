/**
 * Postgres implementation of DiscoveryRepository.
 */

import type { DiscoveryRepository, DiscoveryRecord } from './interfaces.js';
import { getPgPool } from '../lib/postgres.js';

interface DiscoveryRow {
  id: string;
  site_url: string;
  status: string;
  input_json: string | null;
  result_json: string | null;
  created_at: string;
  completed_at: string | null;
}

function rowToRecord(row: DiscoveryRow): DiscoveryRecord {
  return {
    id: row.id,
    siteUrl: row.site_url,
    status: row.status as DiscoveryRecord['status'],
    inputJson: row.input_json,
    resultJson: row.result_json,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function createDiscoveryRepository(): DiscoveryRepository {
  const pool = getPgPool();

  return {
    async save(record: DiscoveryRecord): Promise<void> {
      await pool.query(
        `INSERT INTO discoveries (id, site_url, status, input_json, result_json, created_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           site_url = EXCLUDED.site_url,
           status = EXCLUDED.status,
           input_json = EXCLUDED.input_json,
           result_json = EXCLUDED.result_json,
           created_at = EXCLUDED.created_at,
           completed_at = EXCLUDED.completed_at`,
        [
          record.id,
          record.siteUrl,
          record.status,
          record.inputJson ?? null,
          record.resultJson ?? null,
          record.createdAt,
          record.completedAt ?? null,
        ]
      );
    },

    async getById(id: string): Promise<DiscoveryRecord | undefined> {
      const result = await pool.query<DiscoveryRow>('SELECT * FROM discoveries WHERE id = $1', [id]);
      return result.rows[0] ? rowToRecord(result.rows[0]) : undefined;
    },

    async updateStatus(
      id: string,
      status: DiscoveryRecord['status'],
      resultJson?: string | null,
      completedAt?: string
    ): Promise<void> {
      if (resultJson !== undefined && completedAt !== undefined) {
        await pool.query(
          'UPDATE discoveries SET status = $1, result_json = $2, completed_at = $3 WHERE id = $4',
          [status, resultJson, completedAt, id]
        );
      } else if (completedAt !== undefined) {
        await pool.query('UPDATE discoveries SET status = $1, completed_at = $2 WHERE id = $3', [status, completedAt, id]);
      } else {
        await pool.query('UPDATE discoveries SET status = $1 WHERE id = $2', [status, id]);
      }
    },
  };
}
