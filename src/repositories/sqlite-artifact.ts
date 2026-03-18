/**
 * SQLite implementation of ArtifactRepository. Stores file metadata for run artifacts.
 */

import type { ArtifactRepository, RunArtifactRecord } from './interfaces.js';
import { getDb } from '../lib/db.js';

export function createArtifactRepository(): ArtifactRepository {
  const db = getDb();

  return {
    save(record: RunArtifactRecord): void {
      const stmt = db.prepare(`
        INSERT INTO run_artifacts (id, run_id, step_index, event_id, file_path, checksum_sha256, mime_type, byte_size, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.id,
        record.runId,
        record.stepIndex ?? null,
        record.eventId ?? null,
        record.filePath,
        record.checksumSha256 ?? null,
        record.mimeType ?? null,
        record.byteSize ?? null,
        record.createdAt
      );
    },

    listByRunId(runId: string): RunArtifactRecord[] {
      const rows = db.prepare('SELECT * FROM run_artifacts WHERE run_id = ? ORDER BY step_index ASC, created_at ASC').all(runId) as ArtifactRow[];
      return rows.map(rowToRecord);
    },
  };
}

interface ArtifactRow {
  id: string;
  run_id: string;
  step_index: number | null;
  event_id: string | null;
  file_path: string;
  checksum_sha256: string | null;
  mime_type: string | null;
  byte_size: number | null;
  created_at: string;
}

function rowToRecord(row: ArtifactRow): RunArtifactRecord {
  return {
    id: row.id,
    runId: row.run_id,
    stepIndex: row.step_index,
    eventId: row.event_id,
    filePath: row.file_path,
    checksumSha256: row.checksum_sha256,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    createdAt: row.created_at,
  };
}
