/**
 * Repository factory and singleton access. Used by routes and services for persistence.
 */

import { createScenarioRepository as createScenarioRepositoryPg } from './postgres-scenario.js';
import { createRunRepository as createRunRepositoryPg, createRunStepRepository as createRunStepRepositoryPg } from './postgres-run.js';
import { createTelemetryEventRepository as createTelemetryEventRepositoryPg } from './postgres-telemetry.js';
import { createArtifactRepository as createArtifactRepositoryPg } from './postgres-artifact.js';
import { createDiscoveryRepository as createDiscoveryRepositoryPg } from './postgres-discovery.js';
import { createContentCheckRepository as createContentCheckRepositoryPg } from './postgres-content-check.js';
import { createScenarioVersionRepository as createScenarioVersionRepositoryPg } from './postgres-scenario-version.js';
import { createAuthProfileRepository as createAuthProfileRepositoryPg } from './postgres-auth-profile.js';
import { createSiteShareLinkRepository as createSiteShareLinkRepositoryPg } from './postgres-site-share.js';
import type {
  ScenarioRepository,
  RunRepository,
  TelemetryEventRepository,
  ArtifactRepository,
  DiscoveryRepository,
  ContentCheckRepository,
  ScenarioVersionRepository,
  RunStepRepository,
  AuthProfileRepository,
  SiteShareLinkRepository,
} from './interfaces.js';

let scenarioRepo: ScenarioRepository | null = null;
let runRepo: RunRepository | null = null;
let runStepRepo: RunStepRepository | null = null;
let telemetryRepo: TelemetryEventRepository | null = null;
let artifactRepo: ArtifactRepository | null = null;
let discoveryRepo: DiscoveryRepository | null = null;
let contentCheckRepo: ContentCheckRepository | null = null;
let scenarioVersionRepo: ScenarioVersionRepository | null = null;
let authProfileRepo: AuthProfileRepository | null = null;
let siteShareLinkRepo: SiteShareLinkRepository | null = null;

export function getScenarioRepository(): ScenarioRepository {
  if (!scenarioRepo) scenarioRepo = createScenarioRepositoryPg();
  return scenarioRepo;
}

export function getRunRepository(): RunRepository {
  if (!runRepo) runRepo = createRunRepositoryPg();
  return runRepo;
}

export function getRunStepRepository(): RunStepRepository {
  if (!runStepRepo) runStepRepo = createRunStepRepositoryPg();
  return runStepRepo;
}

export function getTelemetryEventRepository(): TelemetryEventRepository {
  if (!telemetryRepo) telemetryRepo = createTelemetryEventRepositoryPg();
  return telemetryRepo;
}

export function getArtifactRepository(): ArtifactRepository {
  if (!artifactRepo) artifactRepo = createArtifactRepositoryPg();
  return artifactRepo;
}

export function getDiscoveryRepository(): DiscoveryRepository {
  if (!discoveryRepo) discoveryRepo = createDiscoveryRepositoryPg();
  return discoveryRepo;
}

export function getContentCheckRepository(): ContentCheckRepository {
  if (!contentCheckRepo) contentCheckRepo = createContentCheckRepositoryPg();
  return contentCheckRepo;
}

export function getScenarioVersionRepository(): ScenarioVersionRepository {
  if (!scenarioVersionRepo) scenarioVersionRepo = createScenarioVersionRepositoryPg();
  return scenarioVersionRepo;
}

export function getAuthProfileRepository(): AuthProfileRepository {
  if (!authProfileRepo) authProfileRepo = createAuthProfileRepositoryPg();
  return authProfileRepo;
}

export function getSiteShareLinkRepository(): SiteShareLinkRepository {
  if (!siteShareLinkRepo) siteShareLinkRepo = createSiteShareLinkRepositoryPg();
  return siteShareLinkRepo;
}

export type {
  ScenarioRepository,
  RunRepository,
  TelemetryEventRepository,
  ArtifactRepository,
  DiscoveryRepository,
  ContentCheckRepository,
  ScenarioVersionRepository,
  RunStepRepository,
  AuthProfileRepository,
  SiteShareLinkRepository,
};
export type {
  RunArtifactRecord,
  DiscoveryRecord,
  ContentCheckRecord,
  ScenarioVersionRecord,
  RunStepRecord,
} from './interfaces.js';
