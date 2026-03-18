/**
 * Helpers to build and persist telemetry event envelopes. Used by routes and stagehand service.
 */

import { v4 as uuidv4 } from 'uuid';
import type { TelemetryEventEnvelope, TelemetryPayload, TelemetryLevel, TelemetryActor } from '../types/index.js';
import { TELEMETRY_SCHEMA_VERSION } from '../types/index.js';
import { getTelemetryEventRepository } from '../repositories/index.js';
import { logger } from './logger.js';

export interface RequestContext {
  requestId: string;
  traceId: string;
}

function createEnvelope<T extends TelemetryPayload>(
  payload: T,
  actor: TelemetryActor,
  level: TelemetryLevel,
  context: Partial<{ runId: string; scenarioId: string; discoveryId: string; requestId: string; traceId: string }>
): TelemetryEventEnvelope<T> {
  return {
    eventId: uuidv4(),
    eventType: payload.eventType,
    occurredAt: new Date().toISOString(),
    runId: context.runId,
    scenarioId: context.scenarioId,
    discoveryId: context.discoveryId,
    requestId: context.requestId,
    traceId: context.traceId,
    actor,
    level,
    payload,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
  };
}

export function emitTelemetry<T extends TelemetryPayload>(
  payload: T,
  actor: TelemetryActor,
  level: TelemetryLevel = 'info',
  context: Partial<{ runId: string; scenarioId: string; discoveryId: string; requestId: string; traceId: string }> = {}
): void {
  const envelope = createEnvelope(payload, actor, level, context);
  Promise.resolve(getTelemetryEventRepository().append(envelope)).catch((err) => {
    logger.error('Failed to persist telemetry event', {
      eventId: envelope.eventId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}
