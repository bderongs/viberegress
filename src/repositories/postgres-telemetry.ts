/**
 * Postgres implementation of TelemetryEventRepository.
 */

import type { TelemetryEventEnvelope, TelemetryPayload } from '../types/index.js';
import type { TelemetryEventRepository } from './interfaces.js';
import { getPgPool } from '../lib/postgres.js';

interface TelemetryEventRow {
  event_id: string;
  event_type: string;
  occurred_at: string;
  run_id: string | null;
  scenario_id: string | null;
  discovery_id: string | null;
  request_id: string | null;
  trace_id: string | null;
  actor: string;
  level: string;
  payload_json: string;
  schema_version: string;
}

function rowToEnvelope(row: TelemetryEventRow): TelemetryEventEnvelope {
  return {
    eventId: row.event_id,
    eventType: row.event_type as TelemetryEventEnvelope['eventType'],
    occurredAt: row.occurred_at,
    runId: row.run_id ?? undefined,
    scenarioId: row.scenario_id ?? undefined,
    discoveryId: row.discovery_id ?? undefined,
    requestId: row.request_id ?? undefined,
    traceId: row.trace_id ?? undefined,
    actor: row.actor as TelemetryEventEnvelope['actor'],
    level: row.level as TelemetryEventEnvelope['level'],
    payload: JSON.parse(row.payload_json) as TelemetryPayload,
    schemaVersion: row.schema_version,
  };
}

export function createTelemetryEventRepository(): TelemetryEventRepository {
  const pool = getPgPool();

  return {
    async append(envelope: TelemetryEventEnvelope<TelemetryPayload>): Promise<void> {
      await pool.query(
        `INSERT INTO telemetry_events
         (event_id, event_type, occurred_at, run_id, scenario_id, discovery_id, request_id, trace_id, actor, level, payload_json, schema_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          envelope.eventId,
          envelope.eventType,
          envelope.occurredAt,
          envelope.runId ?? null,
          envelope.scenarioId ?? null,
          envelope.discoveryId ?? null,
          envelope.requestId ?? null,
          envelope.traceId ?? null,
          envelope.actor,
          envelope.level,
          JSON.stringify(envelope.payload),
          envelope.schemaVersion,
        ]
      );
    },

    async appendMany(envelopes: TelemetryEventEnvelope<TelemetryPayload>[]): Promise<void> {
      for (const envelope of envelopes) {
        await this.append(envelope);
      }
    },

    async getByRunId(runId: string): Promise<TelemetryEventEnvelope[]> {
      const result = await pool.query<TelemetryEventRow>(
        'SELECT * FROM telemetry_events WHERE run_id = $1 ORDER BY occurred_at ASC',
        [runId]
      );
      return result.rows.map(rowToEnvelope);
    },

    async getByDiscoveryId(discoveryId: string): Promise<TelemetryEventEnvelope[]> {
      const result = await pool.query<TelemetryEventRow>(
        'SELECT * FROM telemetry_events WHERE discovery_id = $1 ORDER BY occurred_at ASC',
        [discoveryId]
      );
      return result.rows.map(rowToEnvelope);
    },
  };
}
