/**
 * Repository factory and singleton access. Used by routes and services for persistence.
 */

import { createScenarioRepository } from './sqlite-scenario.js';
import { createRunRepository, createRunStepRepository } from './sqlite-run.js';
import { createTelemetryEventRepository } from './sqlite-telemetry.js';
import { createArtifactRepository } from './sqlite-artifact.js';
import { createDiscoveryRepository } from './sqlite-discovery.js';
import { createScenarioVersionRepository } from './sqlite-scenario-version.js';
import { createAuthProfileRepository } from './sqlite-auth-profile.js';
import { createScenarioRepository as createScenarioRepositoryPg } from './postgres-scenario.js';
import { createRunRepository as createRunRepositoryPg, createRunStepRepository as createRunStepRepositoryPg } from './postgres-run.js';
import { createTelemetryEventRepository as createTelemetryEventRepositoryPg } from './postgres-telemetry.js';
import { createArtifactRepository as createArtifactRepositoryPg } from './postgres-artifact.js';
import { createDiscoveryRepository as createDiscoveryRepositoryPg } from './postgres-discovery.js';
import { createScenarioVersionRepository as createScenarioVersionRepositoryPg } from './postgres-scenario-version.js';
import { createAuthProfileRepository as createAuthProfileRepositoryPg } from './postgres-auth-profile.js';
import { hasPostgresConfig } from '../lib/postgres.js';
import type {
  ScenarioRepository,
  RunRepository,
  TelemetryEventRepository,
  ArtifactRepository,
  DiscoveryRepository,
  ScenarioVersionRepository,
  RunStepRepository,
  AuthProfileRepository,
} from './interfaces.js';

let scenarioRepo: ScenarioRepository | null = null;
let runRepo: RunRepository | null = null;
let runStepRepo: RunStepRepository | null = null;
let telemetryRepo: TelemetryEventRepository | null = null;
let artifactRepo: ArtifactRepository | null = null;
let discoveryRepo: DiscoveryRepository | null = null;
let scenarioVersionRepo: ScenarioVersionRepository | null = null;
let authProfileRepo: AuthProfileRepository | null = null;
const usePostgres = hasPostgresConfig();

export function getScenarioRepository(): ScenarioRepository {
  if (!scenarioRepo) scenarioRepo = usePostgres ? createScenarioRepositoryPg() : createScenarioRepository();
  return scenarioRepo;
}

export function getRunRepository(): RunRepository {
  if (!runRepo) runRepo = usePostgres ? createRunRepositoryPg() : createRunRepository();
  return runRepo;
}

export function getRunStepRepository(): RunStepRepository {
  if (!runStepRepo) runStepRepo = usePostgres ? createRunStepRepositoryPg() : createRunStepRepository();
  return runStepRepo;
}

export function getTelemetryEventRepository(): TelemetryEventRepository {
  if (!telemetryRepo) telemetryRepo = usePostgres ? createTelemetryEventRepositoryPg() : createTelemetryEventRepository();
  return telemetryRepo;
}

export function getArtifactRepository(): ArtifactRepository {
  if (!artifactRepo) artifactRepo = usePostgres ? createArtifactRepositoryPg() : createArtifactRepository();
  return artifactRepo;
}

export function getDiscoveryRepository(): DiscoveryRepository {
  if (!discoveryRepo) discoveryRepo = usePostgres ? createDiscoveryRepositoryPg() : createDiscoveryRepository();
  return discoveryRepo;
}

export function getScenarioVersionRepository(): ScenarioVersionRepository {
  if (!scenarioVersionRepo) scenarioVersionRepo = usePostgres ? createScenarioVersionRepositoryPg() : createScenarioVersionRepository();
  return scenarioVersionRepo;
}

export function getAuthProfileRepository(): AuthProfileRepository {
  if (!authProfileRepo) authProfileRepo = usePostgres ? createAuthProfileRepositoryPg() : createAuthProfileRepository();
  return authProfileRepo;
}

export type {
  ScenarioRepository,
  RunRepository,
  TelemetryEventRepository,
  ArtifactRepository,
  DiscoveryRepository,
  ScenarioVersionRepository,
  RunStepRepository,
  AuthProfileRepository,
};
export type { RunArtifactRecord, DiscoveryRecord, ScenarioVersionRecord, RunStepRecord } from './interfaces.js';
