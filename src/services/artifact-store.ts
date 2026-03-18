/**
 * Writes run artifacts to disk under a deterministic layout and records metadata in the DB.
 * Layout: artifacts/runs/{runId}/{stepIndex}/{filename}.{ext}; sha256 and size stored for integrity.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { getArtifactRepository } from '../repositories/index.js';
import type { RunArtifactRecord } from '../repositories/interfaces.js';
import { logger } from '../lib/logger.js';

const ARTIFACTS_BASE = process.env.ARTIFACTS_BASE ?? path.join(process.cwd(), 'data', 'artifacts');

function safeSegment(value: string | number): string {
  const s = String(value).replace(/[^a-zA-Z0-9_-]/g, '_');
  return s || 'unknown';
}

/**
 * Resolve directory for a run step. stepIndex can be a number or 'run' for run-level artifacts.
 */
export function getArtifactDir(runId: string, stepIndex: number | null): string {
  const stepDir = stepIndex !== null ? String(stepIndex) : 'run';
  return path.join(ARTIFACTS_BASE, 'runs', safeSegment(runId), stepDir);
}

/**
 * Write content to a file under artifacts/runs/{runId}/{stepIndex}/{name}.{ext}, then record in DB.
 */
export function writeArtifact(params: {
  runId: string;
  stepIndex: number | null;
  name: string;
  content: Buffer | string;
  mimeType: string;
  eventId?: string | null;
}): RunArtifactRecord | null {
  const { runId, stepIndex, name, content, mimeType, eventId } = params;
  const dir = getArtifactDir(runId, stepIndex);
  const ext = mimeTypeToExt(mimeType);
  const filename = `${safeSegment(name)}${ext}`;
  const filePath = path.join(dir, filename);

  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf-8');
  const checksumSha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const byteSize = buf.length;
  const createdAt = new Date().toISOString();

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, buf);
  } catch (err) {
    logger.error('Failed to write artifact file', { filePath, error: err instanceof Error ? err.message : String(err) });
    return null;
  }

  const id = uuidv4();
  const record: RunArtifactRecord = {
    id,
    runId,
    stepIndex,
    eventId: eventId ?? null,
    filePath: path.relative(process.cwd(), filePath),
    checksumSha256,
    mimeType,
    byteSize,
    createdAt,
  };

  Promise.resolve(getArtifactRepository().save(record)).catch((e) => {
    logger.error('Failed to save artifact record', { id, error: e instanceof Error ? e.message : String(e) });
  });

  return record;
}

function mimeTypeToExt(mimeType: string): string {
  const map: Record<string, string> = {
    'application/json': '.json',
    'text/html': '.html',
    'image/png': '.png',
    'image/jpeg': '.jpg',
  };
  return map[mimeType] ?? '.bin';
}
