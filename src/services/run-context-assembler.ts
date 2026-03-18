/**
 * Assembles full run context (run, scenario snapshot, events, steps, artifacts) for a given runId.
 * Used for LLM failure analysis: query repositories or call this helper for full forensic context.
 */

import path from 'path';
import fs from 'fs';
import type { RunForensicsContext } from '../types/index.js';
import type { Scenario } from '../types/index.js';
import { getRunRepository } from '../repositories/index.js';
import { getRunStepRepository } from '../repositories/index.js';
import { getTelemetryEventRepository } from '../repositories/index.js';
import { getScenarioVersionRepository } from '../repositories/index.js';
import { getArtifactRepository } from '../repositories/index.js';

const MAX_ARTIFACT_CONTENT_BYTES = 512 * 1024;

/**
 * Build full forensics context for a run. Resolves artifact paths from process.cwd() and optionally inlines JSON/text content.
 */
export async function assembleRunContext(
  runId: string,
  options?: { includeArtifactContent?: boolean }
): Promise<RunForensicsContext | null> {
  const runRepo = getRunRepository();
  const run = await runRepo.getById(runId);
  if (!run) return null;

  const scenarioVersion = await getScenarioVersionRepository().getByRunId(runId);
  let scenarioSnapshot: Scenario | null = null;
  if (scenarioVersion?.snapshotJson) {
    try {
      scenarioSnapshot = JSON.parse(scenarioVersion.snapshotJson) as Scenario;
    } catch {
      scenarioSnapshot = null;
    }
  }

  const events = await getTelemetryEventRepository().getByRunId(runId);
  const steps = await getRunStepRepository().getByRunId(runId);
  const artifactRecords = await getArtifactRepository().listByRunId(runId);

  const includeContent = options?.includeArtifactContent ?? true;
  const artifacts = artifactRecords.map(rec => {
    const fullPath = path.isAbsolute(rec.filePath) ? rec.filePath : path.join(process.cwd(), rec.filePath);
    let content: string | undefined;
    if (includeContent && rec.byteSize != null && rec.byteSize <= MAX_ARTIFACT_CONTENT_BYTES) {
      try {
        if (fs.existsSync(fullPath)) {
          content = fs.readFileSync(fullPath, 'utf-8');
        }
      } catch {
        // leave content undefined
      }
    }
    return {
      filePath: rec.filePath,
      stepIndex: rec.stepIndex,
      mimeType: rec.mimeType,
      byteSize: rec.byteSize,
      content,
    };
  });

  return {
    run,
    scenarioSnapshot,
    events,
    steps: steps.map(s => ({
      stepIndex: s.stepIndex,
      instruction: s.instruction,
      stepType: s.stepType,
      status: s.status,
      errorText: s.errorText,
      durationMs: s.durationMs,
    })),
    artifacts,
  };
}
