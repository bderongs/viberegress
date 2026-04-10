/**
 * Domain and telemetry types for scenarios, runs, discovery, and event sourcing.
 * Used by services, routes, and persistence layer.
 */

export type { PageStory } from '../services/page-story.js';

/** Structured page summary from discovery extract (matches stagehand DiscoveryPageSummaryRaw). */
export interface DiscoveryPageSummaryPersisted {
  url: string;
  title: string;
  summary: string;
  headingSignals: string[];
  primaryActions: string[];
  hasMeaningfulForm: boolean;
  formFields: Array<{
    label: string;
    controlKind: 'text' | 'email' | 'textarea' | 'select' | 'other';
    requiredGuess: boolean;
    optionLabels?: string[];
  }>;
  submitActionLabels: string[];
}

export interface CrawlPageSnapshot {
  url: string;
  source: string;
  extractedAt: string;
  raw: DiscoveryPageSummaryPersisted;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  steps: Step[];
  siteUrl: string;
  /** Discovery/runtime hint: this scenario likely needs signed-in access. */
  requireAuth?: boolean;
  /** Last extracted page story (create/modify-from-prompt), persisted for reuse. */
  pageStory?: import('../services/page-story.js').PageStory | null;
  /** Discovery/runtime hint: how reliable this scenario currently is. */
  verificationStatus?: 'verified' | 'repaired' | 'unverified';
  /** Optional reason when verificationStatus is unverified. */
  verificationError?: string;
  /** Optional URL where the scenario starts; must be same site as siteUrl. Falls back to siteUrl if unset. */
  startingWebpage?: string | null;
  createdAt: string;
  lastRunAt?: string;
  lastStatus?: 'pass' | 'fail' | 'never';
  /** Optional auth profile to use when running this scenario. */
  authProfileId?: string | null;
  /** Discovery hint: journey drifted from original CTA intent. */
  intentDrift?: { detected: boolean; reason: string };
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

/** Lightweight first load of a URL before scenario vs content flow (title, headline, summary). */
export interface SitePreviewResult {
  siteUrl: string;
  resolvedUrl: string;
  title: string;
  /** Primary on-page headline when available (else mirrors title). */
  mainHeadline: string;
  summary: string;
  requireAuth: boolean;
}

export interface DiscoveryResult {
  siteUrl: string;
  /** Full copy/paste log for discovery analysis and debugging. */
  discoveryLog?: string;
  intentTraces?: Array<{
    intent: { label: string; actionInstruction: string; priority: number; sourceSection: string };
    observedOutcome: {
      url: string;
      pageClass: string;
      title: string;
      requireAuth: boolean;
      summary: string;
    };
    evidence: { headingSignals: string[]; primaryActions: string[] };
  }>;
  visitedPages?: Array<{ url: string; title: string; summary: string; requireAuth: boolean }>;
  crawlMeta?: { selectedCtas: string[]; crawlErrors: string[] };
  /** Heuristic target for how many scenarios this discovery aimed to produce. */
  targetScenarioCount?: number;
  /** Number of homepage intent candidates extracted before selection. */
  candidateIntentCount?: number;
  /** Full per-page extract payloads from the crawl (home + journey hops). */
  crawlPageSnapshots?: CrawlPageSnapshot[];
  scenarios: Omit<Scenario, 'id' | 'createdAt' | 'lastStatus'>[];
}

/** Persona + copy review for a site (advisory; not a regression gate). */
export interface ContentCheckPersonaUsed {
  /** Effective persona description used for judgment. */
  text: string;
  source: 'user' | 'inferred';
  /** 0–1; 1 when user supplied text. */
  confidence: number;
}

export interface ContentCheckEvidenceSnippet {
  /** Short verbatim or tight paraphrase from page copy (from crawl summaries). */
  quote: string;
  note?: string;
}

export interface ContentCheckPageJudgment {
  url: string;
  title: string;
  /** 0–100 advisory scores. */
  fit: number;
  clarity: number;
  trust: number;
  /** Higher = more friction for the persona. */
  friction: number;
  strengths: string[];
  risks: string[];
  recommendations: string[];
  evidenceSnippets: ContentCheckEvidenceSnippet[];
}

export interface ContentCheckResult {
  siteUrl: string;
  resolvedHomeUrl: string;
  personaUsed: ContentCheckPersonaUsed;
  /** Cross-page takeaway for the persona. */
  siteSummary?: string;
  pages: ContentCheckPageJudgment[];
  crawlErrors?: string[];
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
  | {
      eventType: 'site_preview_completed';
      siteUrl: string;
      resolvedUrl: string;
      headless: boolean;
      authProfileId?: string | null;
    }
  | { eventType: 'site_preview_failed'; siteUrl: string; error: string }
  | { eventType: 'discovery_started'; siteUrl: string; headless: boolean; authProfileId?: string | null }
  | {
      eventType: 'discovery_completed';
      siteUrl: string;
      scenarioCount: number;
      visitedPages?: Array<{ url: string; requireAuth: boolean }>;
      selectedCtas?: string[];
      crawlErrors?: string[];
      intentCount?: number;
      verifiedCount?: number;
      repairedCount?: number;
      unverifiedCount?: number;
      targetScenarioCount?: number;
      candidateIntentCount?: number;
    }
  | { eventType: 'discovery_failed'; siteUrl: string; error: string }
  | {
      eventType: 'content_check_started';
      siteUrl: string;
      headless: boolean;
      authProfileId?: string | null;
      inferPersona: boolean;
    }
  | {
      eventType: 'content_check_completed';
      siteUrl: string;
      resolvedHomeUrl: string;
      pageCount: number;
      personaSource: 'user' | 'inferred';
      durationMs: number;
      crawlErrorCount?: number;
    }
  | { eventType: 'content_check_failed'; siteUrl: string; error: string };

/** Scenario build/save flow event payloads */
export interface ScenarioRepairTrace {
  intent?: string;
  verificationError?: string;
  repairPrompt?: string;
  candidateBeforeRepair?: { name: string; description: string; steps: string[] };
  aiRewrite?: { name: string; description: string; steps: string[] };
  rerunResult?: { passed: boolean; error?: string };
}

export type ScenarioBuildEventPayload =
  | { eventType: 'scenario_saved'; scenarioId: string; name: string; stepCount: number }
  | { eventType: 'scenario_deleted'; scenarioId: string }
  | { eventType: 'scenario_generation_started'; scenarioId: string; mode: 'create' | 'modify_before_run' | 'discovery'; trace?: ScenarioRepairTrace }
  | { eventType: 'scenario_verification_attempted'; scenarioId: string; attempt: number; stepCount: number; trace?: ScenarioRepairTrace }
  | { eventType: 'scenario_verification_succeeded'; scenarioId: string; attempt: number; stepCount: number; trace?: ScenarioRepairTrace }
  | { eventType: 'scenario_verification_failed'; scenarioId: string; attempt: number; error: string; trace?: ScenarioRepairTrace }
  | { eventType: 'scenario_repair_attempted'; scenarioId: string; attempt: number; error: string; trace?: ScenarioRepairTrace }
  | { eventType: 'scenario_repair_succeeded'; scenarioId: string; attempt: number; stepCount: number; trace?: ScenarioRepairTrace }
  | { eventType: 'scenario_generation_failed'; scenarioId: string; mode: 'create' | 'modify_before_run' | 'discovery'; error: string; trace?: ScenarioRepairTrace };

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
