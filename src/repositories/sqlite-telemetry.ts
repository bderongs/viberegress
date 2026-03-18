/**
 * SQLite implementation of TelemetryEventRepository. Append-only event store for forensics.
 */

import type { TelemetryEventEnvelope, TelemetryPayload } from '../types/index.js';
import type { TelemetryEventRepository } from './interfaces.js';
import { getDb } from '../lib/db.js';

export function createTelemetryEventRepository(): TelemetryEventRepository {
  const db = getDb();

  return {
    append(envelope: TelemetryEventEnvelope<TelemetryPayload>): void {
      const stmt = db.prepare(`
        INSERT INTO telemetry_events (event_id, event_type, occurred_at, run_id, scenario_id, discovery_id, request_id, trace_id, actor, level, payload_json, schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
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
        envelope.schemaVersion
      );
    },

    appendMany(envelopes: TelemetryEventEnvelope<TelemetryPayload>[]): void {
      const stmt = db.prepare(`
        INSERT INTO telemetry_events (event_id, event_type, occurred_at, run_id, scenario_id, discovery_id, request_id, trace_id, actor, level, payload_json, schema_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const run = db.transaction(() => {
        for (const envelope of envelopes) {
          stmt.run(
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
            envelope.schemaVersion
          );
        }
      });
      run();
    },

    getByRunId(runId: string): TelemetryEventEnvelope[] {
      const rows = db.prepare('SELECT * FROM telemetry_events WHERE run_id = ? ORDER BY occurred_at ASC').all(runId) as TelemetryEventRow[];
      return rows.map(rowToEnvelope);
    },

    getByDiscoveryId(discoveryId: string): TelemetryEventEnvelope[] {
      const rows = db.prepare('SELECT * FROM telemetry_events WHERE discovery_id = ? ORDER BY occurred_at ASC').all(discoveryId) as TelemetryEventRow[];
      return rows.map(rowToEnvelope);
    },
  };
}

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
