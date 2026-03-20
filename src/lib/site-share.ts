/**
 * Helpers for magic-link site sharing (public read-only payloads).
 */

import type { Scenario } from '../types/index.js';

export type PublicScenario = Pick<
  Scenario,
  'id' | 'name' | 'description' | 'siteUrl' | 'steps' | 'createdAt' | 'lastStatus' | 'startingWebpage' | 'lastRunAt'
>;

export function scenarioToPublicJson(s: Scenario): PublicScenario {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    siteUrl: s.siteUrl,
    steps: s.steps,
    createdAt: s.createdAt,
    lastStatus: s.lastStatus,
    startingWebpage: s.startingWebpage,
    lastRunAt: s.lastRunAt,
  };
}

/** Token must be opaque URL-safe string from our generator. */
export function isValidShareTokenFormat(token: string): boolean {
  const t = (token || '').trim();
  return /^[A-Za-z0-9_-]{32,128}$/.test(t);
}
