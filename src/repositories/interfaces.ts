/**
 * Repository interfaces for scenario, run, telemetry, artifact, and discovery persistence.
 * Implementations are Postgres-based; interfaces keep services decoupled from storage specifics.
 */

import type {
  Scenario,
  TestRun,
  TelemetryEventEnvelope,
  TelemetryPayload,
  AuthProfile,
  AuthProfilePayload,
  AuthProfileMode,
  PageStory,
} from '../types/index.js';
import type { Owner } from '../types/owner.js';

type MaybePromise<T> = T | Promise<T>;

export interface ScenarioRepository {
  save(scenario: Scenario, owner: Owner): MaybePromise<void>;
  getById(id: string, owner: Owner): MaybePromise<Scenario | undefined>;
  getAll(owner: Owner): MaybePromise<Scenario[]>;
  deleteById(id: string, owner: Owner): MaybePromise<boolean>;
  updateStatus(id: string, status: 'pass' | 'fail', lastRunAt: string, owner: Owner): MaybePromise<void>;
  /** Overwrite name, description, steps, and optional authProfileId/startingWebpage for an existing scenario. */
  updateById(
    id: string,
    data: {
      name: string;
      description: string;
      steps: Scenario['steps'];
      authProfileId?: string | null;
      startingWebpage?: string | null;
      /** When set (including null), updates stored page story JSON. */
      pageStory?: PageStory | null;
    },
    owner: Owner
  ): MaybePromise<void>;
  /** Reassign anonymous session scenarios to a signed-in user. Returns rows updated. */
  claimAnonymousToUser(sessionId: string, userId: string): MaybePromise<number>;
  listByUserIdAndSiteNormalized(userId: string, siteUrlNormalized: string): MaybePromise<Scenario[]>;
}

export interface SiteShareLinkRecord {
  id: string;
  token: string;
  ownerUserId: string;
  siteUrl: string;
  createdAt: string;
  revokedAt: string | null;
  expiresAt: string | null;
  allowPublicRead: boolean;
}

export interface SiteShareLinkRepository {
  create(ownerUserId: string, siteUrlNormalized: string): MaybePromise<SiteShareLinkRecord>;
  listByOwnerAndSite(ownerUserId: string, siteUrlNormalized: string): MaybePromise<SiteShareLinkRecord[]>;
  listRecentByOwner(ownerUserId: string, limit: number): MaybePromise<SiteShareLinkRecord[]>;
  revoke(ownerUserId: string, linkId: string): MaybePromise<boolean>;
  getActiveByToken(token: string): MaybePromise<SiteShareLinkRecord | undefined>;
}

export interface RunRepository {
  save(run: TestRun): MaybePromise<void>;
  getById(id: string): MaybePromise<TestRun | undefined>;
  getByScenarioId(scenarioId: string): MaybePromise<TestRun[]>;
  /** Count runs whose scenarios belong to this user, started in [periodStartUtc, periodEndExclusiveUtc). */
  countRunsForUserInUtcMonth(
    userId: string,
    periodStartUtc: string,
    periodEndExclusiveUtc: string
  ): MaybePromise<number>;
}

export interface TelemetryEventRepository {
  append(envelope: TelemetryEventEnvelope<TelemetryPayload>): MaybePromise<void>;
  appendMany(envelopes: TelemetryEventEnvelope<TelemetryPayload>[]): MaybePromise<void>;
  getByRunId(runId: string): MaybePromise<TelemetryEventEnvelope[]>;
  getByDiscoveryId(discoveryId: string): MaybePromise<TelemetryEventEnvelope[]>;
  getByScenarioId(scenarioId: string): MaybePromise<TelemetryEventEnvelope[]>;
}

export interface RunArtifactRecord {
  id: string;
  runId: string;
  stepIndex: number | null;
  eventId: string | null;
  filePath: string;
  checksumSha256: string | null;
  mimeType: string | null;
  byteSize: number | null;
  createdAt: string;
}

export interface ArtifactRepository {
  save(record: RunArtifactRecord): MaybePromise<void>;
  listByRunId(runId: string): MaybePromise<RunArtifactRecord[]>;
}

export interface DiscoveryRecord {
  id: string;
  siteUrl: string;
  status: 'running' | 'completed' | 'failed';
  inputJson: string | null;
  resultJson: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface DiscoveryRepository {
  save(record: DiscoveryRecord, owner: Owner): MaybePromise<void>;
  getById(id: string, owner: Owner): MaybePromise<DiscoveryRecord | undefined>;
  listByOwner(
    owner: Owner,
    options?: { siteUrl?: string; limit?: number }
  ): MaybePromise<DiscoveryRecord[]>;
  updateStatus(
    id: string,
    owner: Owner,
    status: DiscoveryRecord['status'],
    resultJson?: string | null,
    completedAt?: string
  ): MaybePromise<void>;
}

export interface ContentCheckRecord {
  id: string;
  siteUrl: string;
  status: 'running' | 'completed' | 'failed';
  inputJson: string | null;
  resultJson: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ContentCheckRepository {
  save(record: ContentCheckRecord, owner: Owner): MaybePromise<void>;
  getById(id: string, owner: Owner): MaybePromise<ContentCheckRecord | undefined>;
  listByOwner(
    owner: Owner,
    options?: { siteUrl?: string; limit?: number }
  ): MaybePromise<ContentCheckRecord[]>;
  updateStatus(
    id: string,
    owner: Owner,
    status: ContentCheckRecord['status'],
    resultJson?: string | null,
    completedAt?: string | undefined
  ): MaybePromise<void>;
}

export interface ScenarioVersionRecord {
  id: string;
  scenarioId: string;
  runId: string;
  snapshotJson: string;
  createdAt: string;
}

export interface ScenarioVersionRepository {
  save(record: ScenarioVersionRecord): MaybePromise<void>;
  getByRunId(runId: string): MaybePromise<ScenarioVersionRecord | undefined>;
}

export interface RunStepRecord {
  runId: string;
  stepIndex: number;
  instruction: string;
  stepType: 'act' | 'extract' | 'assert';
  status: 'pending' | 'pass' | 'fail';
  errorText: string | null;
  durationMs: number | null;
}

export interface RunStepRepository {
  getByRunId(runId: string): MaybePromise<RunStepRecord[]>;
}

export interface AuthProfileRepository {
  save(profile: AuthProfile, payload: AuthProfilePayload, owner: Owner): MaybePromise<void>;
  getById(id: string, owner: Owner): MaybePromise<AuthProfile | undefined>;
  /** Returns profile with decrypted payload for runner use. Use only in-memory. */
  getByIdWithPayload(id: string, owner: Owner): MaybePromise<(AuthProfile & { payload: AuthProfilePayload }) | undefined>;
  getAll(owner: Owner): MaybePromise<AuthProfile[]>;
  updateById(
    id: string,
    data: { name?: string; baseUrl?: string; mode?: AuthProfileMode; payload?: AuthProfilePayload },
    owner: Owner
  ): MaybePromise<void>;
  deleteById(id: string, owner: Owner): MaybePromise<boolean>;
  /** Reassign anonymous session profiles to a signed-in user. Returns rows updated. */
  claimAnonymousToUser(sessionId: string, userId: string): MaybePromise<number>;
}
