/**
 * Domain and telemetry types for scenarios, runs, discovery, and event sourcing.
 * Used by services, routes, and persistence layer.
 */

export interface Scenario {
  id: string;
  name: string;
  description: string;
  steps: Step[];
  siteUrl: string;
  /** Optional URL where the scenario starts; must be same site as siteUrl. Falls back to siteUrl if unset. */
  startingWebpage?: string | null;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: 'pass' | 'fail' | 'never';
  /** Optional auth profile to use when running this scenario. */
  authProfileId?: string | null;
}

export interface Step {
  instruction: string;
  type: 'act' | 'extract' | 'assert';
}

export interface TestRun {
  id: string;
  scenarioId: string;
  scenarioName: string;
  startedAt: string;
  finishedAt?: string;
  status: 'running' | 'pass' | 'fail';
  steps: StepResult[];
  error?: string;
}

export interface StepResult {
  instruction: string;
  status: 'pass' | 'fail' | 'pending';
  type?: Step['type'];
  error?: string;
  durationMs?: number;
}

export interface DiscoveryResult {
  siteUrl: string;
  scenarios: Omit<Scenario, 'id' | 'createdAt' | 'lastStatus'>[];
}

// --- Auth profiles (encrypted at rest) ---

export type AuthProfileMode = 'session' | 'headers_cookies' | 'hybrid';

/** Cookie shape for request auth (Playwright-compatible). */
export interface AuthCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Decrypted payload for an auth profile. Never log or emit. */
export interface AuthProfilePayload {
  cookies?: AuthCookie[];
  extraHTTPHeaders?: Record<string, string>;
  /** JSON string of Playwright storage state (cookies + localStorage/sessionStorage). */
  storageStateJson?: string;
}

/** Auth profile as stored (payload encrypted in DB). */
export interface AuthProfile {
  id: string;
  name: string;
  baseUrl: string;
  mode: AuthProfileMode;
  createdAt: string;
  updatedAt: string;
}

// --- Telemetry event envelope and event-type unions ---

export const TELEMETRY_SCHEMA_VERSION = '1';

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export type TelemetryActor = 'api' | 'discovery' | 'scenario_build' | 'run';

/** Discovery-flow event payloads */
export type DiscoveryEventPayload =
  | { eventType: 'discovery_started'; siteUrl: string; headless: boolean; authProfileId?: string | null }
  | { eventType: 'discovery_completed'; siteUrl: string; scenarioCount: number }
  | { eventType: 'discovery_failed'; siteUrl: string; error: string };

/** Scenario build/save flow event payloads */
export type ScenarioBuildEventPayload =
  | { eventType: 'scenario_saved'; scenarioId: string; name: string; stepCount: number }
  | { eventType: 'scenario_deleted'; scenarioId: string };

/** Run-flow event payloads */
export type RunEventPayload =
  | {
      eventType: 'run_started';
      scenarioId: string;
      scenarioName: string;
      stepCount: number;
      headless?: boolean;
      authProfileId?: string | null;
    }
  | { eventType: 'run_step_started'; stepIndex: number; instruction: string; stepType: Step['type'] }
  | { eventType: 'run_step_completed'; stepIndex: number; durationMs: number }
  | { eventType: 'run_step_failed'; stepIndex: number; error: string; durationMs: number }
  | { eventType: 'run_completed'; status: 'pass' }
  | { eventType: 'run_failed'; status: 'fail'; error: string };

/** Request lifecycle (ingress) payloads */
export type RequestEventPayload =
  | { eventType: 'request_started'; method: string; path: string }
  | { eventType: 'request_completed'; method: string; path: string; statusCode: number; durationMs: number }
  | { eventType: 'request_failed'; method: string; path: string; error: string };

export type TelemetryPayload =
  | DiscoveryEventPayload
  | ScenarioBuildEventPayload
  | RunEventPayload
  | RequestEventPayload;

export interface TelemetryEventEnvelope<T extends TelemetryPayload = TelemetryPayload> {
  eventId: string;
  eventType: T['eventType'];
  occurredAt: string;
  runId?: string;
  scenarioId?: string;
  discoveryId?: string;
  requestId?: string;
  traceId?: string;
  actor: TelemetryActor;
  level: TelemetryLevel;
  payload: T;
  schemaVersion: string;
}

/** Assembled run context for LLM failure analysis (query by runId). */
export interface RunForensicsContext {
  run: TestRun;
  scenarioSnapshot: Scenario | null;
  events: TelemetryEventEnvelope[];
  steps: Array<{ stepIndex: number; instruction: string; stepType: Step['type']; status: string; errorText: string | null; durationMs: number | null }>;
  artifacts: Array<{ filePath: string; stepIndex: number | null; mimeType: string | null; byteSize: number | null; content?: string }>;
}
