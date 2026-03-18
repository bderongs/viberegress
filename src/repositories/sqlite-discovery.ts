/**
 * SQLite implementation of DiscoveryRepository. Persists discovery runs and results.
 */

import type { DiscoveryRepository, DiscoveryRecord } from './interfaces.js';
import { getDb } from '../lib/db.js';

export function createDiscoveryRepository(): DiscoveryRepository {
  const db = getDb();

  return {
    save(record: DiscoveryRecord): void {
      const stmt = db.prepare(`
        INSERT OR REPLACE INTO discoveries (id, site_url, status, input_json, result_json, created_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id,
        record.siteUrl,
        record.status,
        record.inputJson ?? null,
        record.resultJson ?? null,
        record.createdAt,
        record.completedAt ?? null
      );
    },

    getById(id: string): DiscoveryRecord | undefined {
      const row = db.prepare('SELECT * FROM discoveries WHERE id = ?').get(id) as DiscoveryRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },

    updateStatus(id: string, status: DiscoveryRecord['status'], resultJson?: string | null, completedAt?: string): void {
      const existing = db.prepare('SELECT id FROM discoveries WHERE id = ?').get(id);
      if (!existing) return;
      if (resultJson !== undefined && completedAt !== undefined) {
        db.prepare('UPDATE discoveries SET status = ?, result_json = ?, completed_at = ? WHERE id = ?').run(status, resultJson, completedAt, id);
      } else if (completedAt !== undefined) {
        db.prepare('UPDATE discoveries SET status = ?, completed_at = ? WHERE id = ?').run(status, completedAt, id);
      } else {
        db.prepare('UPDATE discoveries SET status = ? WHERE id = ?').run(status, id);
      }
    },
  };
}

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
