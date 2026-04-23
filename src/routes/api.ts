/**
 * API routes for scenarios, discovery, and runs. Uses repositories and emits telemetry.
 */

import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getScenarioRepository,
  getRunRepository,
  getScenarioVersionRepository,
  getAuthProfileRepository,
  getSiteShareLinkRepository,
  getTelemetryEventRepository,
  getDiscoveryRepository,
  getContentCheckRepository,
} from '../repositories/index.js';
import { scenarioToPublicJson, isValidShareTokenFormat } from '../lib/site-share.js';
import { discoverScenarios, previewSite, runContentCheck, runScenario } from '../services/stagehand.js';
import { validateAndNormalizeSteps } from '../services/step-quality.js';
import {
  modifyScenarioWithAI,
  createScenarioFromPrompt,
  modifyScenarioStepWithAI,
} from '../services/scenario-modifier.js';
import { formatPageStoryForPrompt, STORY_FALLBACK_RULES } from '../services/page-story.js';
import type { PageStory } from '../services/page-story.js';
import { Scenario, TestRun, AuthProfile, AuthProfilePayload } from '../types/index.js';
import { emitTelemetry } from '../lib/telemetry.js';
import { writeArtifact, getArtifactDir } from '../services/artifact-store.js';
import {
  createAuthProfileBodySchema,
  updateAuthProfileBodySchema,
} from '../lib/auth-profile-schema.js';
import { redactAuth } from '../lib/redact.js';
import { parseCookiesFromDevTools } from '../lib/parse-devtools-cookies.js';
import { validateStartingWebpage } from '../lib/starting-webpage.js';
import { authMiddleware } from '../middleware/auth.js';
import type { Owner } from '../types/owner.js';
import { getPgPool } from '../lib/postgres.js';

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isContentCheckEnabled(): boolean {
  return process.env.CONTENT_CHECK_ENABLED !== 'false';
}

const MONTHLY_RUN_LIMIT = 20;
const SCENARIO_VERIFY_MAX_REPAIRS = 1;

function utcMonthWindow(): { periodStartUtc: string; periodEndExclusiveUtc: string } {
  const y = new Date().getUTCFullYear();
  const m = new Date().getUTCMonth();
  const periodStartUtc = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0)).toISOString();
  const periodEndExclusiveUtc = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0, 0)).toISOString();
  return { periodStartUtc, periodEndExclusiveUtc };
}

async function getSignedInMonthlyUsage(userId: string) {
  const { periodStartUtc, periodEndExclusiveUtc } = utcMonthWindow();
  const used = await getRunRepository().countRunsForUserInUtcMonth(
    userId,
    periodStartUtc,
    periodEndExclusiveUtc
  );
  const limit = MONTHLY_RUN_LIMIT;
  const remaining = Math.max(0, limit - used);
  return {
    used,
    limit,
    remaining,
    periodStartUtc,
    periodEndExclusiveUtc,
    periodResetsAtUtc: periodEndExclusiveUtc,
    atLimit: used >= limit,
  };
}

interface ScenarioDraftResult {
  name: string;
  description: string;
  steps: Scenario['steps'];
}

type ScenarioDraftInput = Omit<Scenario, 'id' | 'createdAt' | 'lastStatus'>;

class ScenarioSaveError extends Error {
  scenarioId: string;
  constructor(message: string, scenarioId: string) {
    super(message);
    this.name = 'ScenarioSaveError';
    this.scenarioId = scenarioId;
  }
}

async function verifyAndRepairScenarioDraft(
  draft: ScenarioDraftResult,
  context: {
    scenarioBase: Scenario;
    owner: Owner;
    originalUserMessage: string;
    mode: 'create' | 'modify_before_run' | 'discovery';
    requestId?: string;
    traceId?: string;
    maxRepairs?: number;
    /** Structured narrative from the start URL; strengthens repair prompts when set. */
    pageStory?: PageStory | null;
  }
): Promise<ScenarioDraftResult> {
  const maxRepairs = context.maxRepairs ?? SCENARIO_VERIFY_MAX_REPAIRS;
  let candidate: ScenarioDraftResult = {
    name: draft.name,
    description: draft.description,
    steps: draft.steps,
  };
  let lastError = 'Unknown verification error';

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    emitTelemetry(
      {
        eventType: 'scenario_verification_attempted',
        scenarioId: context.scenarioBase.id,
        attempt: attempt + 1,
        stepCount: candidate.steps.length,
        trace: {
          intent: context.originalUserMessage,
        },
      },
      'scenario_build',
      'info',
      {
        scenarioId: context.scenarioBase.id,
        requestId: context.requestId,
        traceId: context.traceId,
      }
    );
    const startUrl = context.scenarioBase.startingWebpage?.trim() || context.scenarioBase.siteUrl;
    const runResult = await runScenario(
      startUrl,
      candidate.steps,
      () => undefined,
      {
        headless: true,
        authProfileId: context.scenarioBase.authProfileId ?? undefined,
        owner: context.owner,
      }
    );

    if (runResult.passed) {
      emitTelemetry(
        {
          eventType: 'scenario_verification_succeeded',
          scenarioId: context.scenarioBase.id,
          attempt: attempt + 1,
          stepCount: candidate.steps.length,
          trace: {
            intent: context.originalUserMessage,
            rerunResult: { passed: true },
          },
        },
        'scenario_build',
        'info',
        {
          scenarioId: context.scenarioBase.id,
          requestId: context.requestId,
          traceId: context.traceId,
        }
      );
      return candidate;
    }

    lastError = runResult.error || 'Unknown verification error';
    emitTelemetry(
      {
        eventType: 'scenario_verification_failed',
        scenarioId: context.scenarioBase.id,
        attempt: attempt + 1,
        error: lastError,
        trace: {
          intent: context.originalUserMessage,
          verificationError: lastError,
          rerunResult: { passed: false, error: lastError },
        },
      },
      'scenario_build',
      'warn',
      {
        scenarioId: context.scenarioBase.id,
        requestId: context.requestId,
        traceId: context.traceId,
      }
    );
    if (attempt >= maxRepairs) break;
    const narrativeRepair =
      context.pageStory != null ? formatPageStoryForPrompt(context.pageStory) : STORY_FALLBACK_RULES;
    const repairPrompt = [
      `Original user request: "${context.originalUserMessage}"`,
      `Verification failed while replaying this scenario in a real browser: ${lastError}`,
      'Rewrite the scenario so the steps are realistic and executable on this site.',
      'Keep the same goal. Update assertions to match what actually happens after prior actions.',
      'Do not return assumptions that are not visible or verifiable on the page.',
      `URL integrity: Do NOT rewrite or "anonymize" domains (do not turn real domains into *.example). Keep URLs on the same site as this scenario's siteUrl: ${context.scenarioBase.siteUrl}`,
      narrativeRepair,
      'Realign the scenario with this page narrative: prefer the hero, primary CTA, and primary intent; remove or avoid steps that interact with demo or decorative sections unless the original user request explicitly required testing those.',
    ].join('\n');
    emitTelemetry(
      {
        eventType: 'scenario_repair_attempted',
        scenarioId: context.scenarioBase.id,
        attempt: attempt + 1,
        error: lastError,
        trace: {
          intent: context.originalUserMessage,
          verificationError: lastError,
          repairPrompt,
          candidateBeforeRepair: {
            name: candidate.name,
            description: candidate.description,
            steps: candidate.steps.map((s) => s.instruction),
          },
        },
      },
      'scenario_build',
      'info',
      {
        scenarioId: context.scenarioBase.id,
        requestId: context.requestId,
        traceId: context.traceId,
      }
    );

    const scenarioForRepair: Scenario = {
      ...context.scenarioBase,
      name: candidate.name,
      description: candidate.description,
      steps: candidate.steps,
    };
    const repaired = await modifyScenarioWithAI({
      scenario: scenarioForRepair,
      mode: 'pre_run',
      userMessage: repairPrompt,
    });
    candidate = {
      name: repaired.name,
      description: repaired.description,
      steps: repaired.steps,
    };
    emitTelemetry(
      {
        eventType: 'scenario_repair_succeeded',
        scenarioId: context.scenarioBase.id,
        attempt: attempt + 1,
        stepCount: candidate.steps.length,
        trace: {
          intent: context.originalUserMessage,
          verificationError: lastError,
          repairPrompt,
          aiRewrite: {
            name: candidate.name,
            description: candidate.description,
            steps: candidate.steps.map((s) => s.instruction),
          },
          rerunResult: { passed: false, error: lastError },
        },
      },
      'scenario_build',
      'info',
      {
        scenarioId: context.scenarioBase.id,
        requestId: context.requestId,
        traceId: context.traceId,
      }
    );
  }

  throw new Error(`Scenario verification failed after auto-repair: ${lastError}`);
}

async function saveScenarioDraftWithAutoRepair(
  draftInput: ScenarioDraftInput,
  owner: Owner,
  context: {
    mode: 'create' | 'modify_before_run' | 'discovery';
    originalUserMessage: string;
    requestId?: string;
    traceId?: string;
    scenarioId?: string;
    pageStory?: PageStory | null;
  }
): Promise<Scenario> {
  const startValidation = validateStartingWebpage(draftInput.startingWebpage, draftInput.siteUrl);
  if (!startValidation.ok) throw new Error(startValidation.error);
  const validated = validateAndNormalizeSteps(draftInput.steps, {
    name: draftInput.name,
    description: draftInput.description,
  });
  if (!validated.ok) {
    throw new Error(validated.message);
  }

  const scenario: Scenario = {
    ...draftInput,
    steps: validated.steps as Scenario['steps'],
    id: context.scenarioId ?? uuidv4(),
    createdAt: new Date().toISOString(),
    lastStatus: 'never',
  };
  if (context.pageStory !== undefined) {
    scenario.pageStory = context.pageStory;
  }

  emitTelemetry(
    { eventType: 'scenario_generation_started', scenarioId: scenario.id, mode: context.mode, trace: { intent: context.originalUserMessage } },
    'scenario_build',
    'info',
    { scenarioId: scenario.id, requestId: context.requestId, traceId: context.traceId }
  );

  try {
    const verified = await verifyAndRepairScenarioDraft(
      { name: scenario.name, description: scenario.description, steps: scenario.steps },
      {
        scenarioBase: scenario,
        owner,
        originalUserMessage: context.originalUserMessage,
        mode: context.mode,
        requestId: context.requestId,
        traceId: context.traceId,
        pageStory: context.pageStory,
      }
    );
    scenario.name = verified.name;
    scenario.description = verified.description;
    scenario.steps = verified.steps;

    await getScenarioRepository().save(scenario, owner);
    emitTelemetry(
      { eventType: 'scenario_saved', scenarioId: scenario.id, name: scenario.name, stepCount: scenario.steps.length },
      'scenario_build',
      'info',
      { scenarioId: scenario.id, requestId: context.requestId, traceId: context.traceId }
    );
    return scenario;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitTelemetry(
      {
        eventType: 'scenario_generation_failed',
        scenarioId: scenario.id,
        mode: context.mode,
        error: msg,
        trace: {
          intent: context.originalUserMessage,
          verificationError: msg,
          rerunResult: { passed: false, error: msg },
        },
      },
      'scenario_build',
      'warn',
      { scenarioId: scenario.id, requestId: context.requestId, traceId: context.traceId }
    );
    throw new ScenarioSaveError(msg, scenario.id);
  }
}

export const router = Router();

router.get('/config', (_req: Request, res: Response) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL ?? null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
    authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
  });
});

/** Public: read-only scenarios for a valid share token (no auth). */
router.get('/share/:token/site', async (req: Request, res: Response) => {
  const raw = req.params.token || '';
  if (!isValidShareTokenFormat(raw)) {
    return res.status(404).json({ error: 'invalid_or_expired_share_link' });
  }
  const link = await getSiteShareLinkRepository().getActiveByToken(raw);
  if (!link) {
    return res.status(404).json({ error: 'invalid_or_expired_share_link' });
  }
  const scenarios = await getScenarioRepository().listByUserIdAndSiteNormalized(link.ownerUserId, link.siteUrl);
  res.json({
    siteUrl: link.siteUrl,
    scenarios: scenarios.map(scenarioToPublicJson),
    sharedView: true,
  });
});

router.use((req: Request, res: Response, next) => {
  void authMiddleware(req, res, next);
});

router.get('/auth/me', (req: Request, res: Response) => {
  const o = req.owner!;
  res.json({
    isAnonymous: o.type === 'anonymous',
    user:
      o.type === 'user' && req.authUser
        ? { id: req.authUser.id, email: req.authUser.email ?? null }
        : null,
  });
});

router.get('/usage', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.json({
      isAnonymous: true,
      monthlyRunsUsed: null,
      monthlyRunsLimit: null,
      monthlyRunsRemaining: null,
      periodStartUtc: null,
      periodResetsAtUtc: null,
      atLimit: false,
      checkoutUrl: '/billing',
    });
  }
  const u = await getSignedInMonthlyUsage(req.owner!.id);
  res.json({
    isAnonymous: false,
    monthlyRunsUsed: u.used,
    monthlyRunsLimit: u.limit,
    monthlyRunsRemaining: u.remaining,
    periodStartUtc: u.periodStartUtc,
    periodResetsAtUtc: u.periodResetsAtUtc,
    atLimit: u.atLimit,
    checkoutUrl: '/billing',
  });
});

router.post('/auth/claim-session', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.status(401).json({ error: 'Sign in required' });
  }
  const { sessionId } = req.body as { sessionId?: string };
  if (!sessionId || typeof sessionId !== 'string' || !SESSION_UUID.test(sessionId.trim())) {
    return res.status(400).json({ error: 'Invalid sessionId' });
  }
  const userId = req.owner!.id;
  const nS = await getScenarioRepository().claimAnonymousToUser(sessionId, userId);
  const nP = await getAuthProfileRepository().claimAnonymousToUser(sessionId, userId);
  res.json({ ok: true, scenariosClaimed: nS, authProfilesClaimed: nP });
});

router.post('/sites/:siteUrl/share-links', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.status(403).json({ error: 'Sign in required' });
  }
  let siteUrlDecoded: string;
  try {
    siteUrlDecoded = decodeURIComponent(req.params.siteUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid site URL' });
  }
  const norm = normalizeSiteUrlForMatch(siteUrlDecoded);
  const existing = await getScenarioRepository().listByUserIdAndSiteNormalized(req.owner!.id, norm);
  if (!existing.length) {
    return res.status(404).json({ error: 'No scenarios for this site' });
  }
  const link = await getSiteShareLinkRepository().create(req.owner!.id, norm);
  res.status(201).json({
    id: link.id,
    token: link.token,
    siteUrl: link.siteUrl,
    createdAt: link.createdAt,
    sharePath: `/share/${link.token}`,
  });
});

router.get('/sites/:siteUrl/share-links', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.status(403).json({ error: 'Sign in required' });
  }
  let siteUrlDecoded: string;
  try {
    siteUrlDecoded = decodeURIComponent(req.params.siteUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid site URL' });
  }
  const norm = normalizeSiteUrlForMatch(siteUrlDecoded);
  const links = await getSiteShareLinkRepository().listByOwnerAndSite(req.owner!.id, norm);
  res.json(
    links.map((l) => ({
      id: l.id,
      token: l.token,
      siteUrl: l.siteUrl,
      createdAt: l.createdAt,
      revokedAt: l.revokedAt,
      expiresAt: l.expiresAt,
      active: !l.revokedAt,
      sharePath: l.revokedAt ? null : `/share/${l.token}`,
    }))
  );
});

router.delete('/sites/:siteUrl/share-links/:linkId', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.status(403).json({ error: 'Sign in required' });
  }
  const ok = await getSiteShareLinkRepository().revoke(req.owner!.id, req.params.linkId);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

router.get('/share-links/recent', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.status(403).json({ error: 'Sign in required' });
  }
  const links = await getSiteShareLinkRepository().listRecentByOwner(req.owner!.id, 15);
  res.json(
    links.map((l) => ({
      id: l.id,
      token: l.token,
      siteUrl: l.siteUrl,
      createdAt: l.createdAt,
      sharePath: `/share/${l.token}`,
    }))
  );
});

/**
 * Delete a whole site workspace for the current owner: scenarios (and their runs/artifacts via FK cascades),
 * plus discovery/content-check history and share links for that site.
 *
 * "Site" is defined by normalized siteUrl (trailing slash removed).
 */
router.delete('/sites/:siteUrl', async (req: Request, res: Response) => {
  let siteUrlDecoded: string;
  try {
    siteUrlDecoded = decodeURIComponent(req.params.siteUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid site URL' });
  }
  const siteNorm = normalizeSiteUrlForMatch(siteUrlDecoded);

  const owner = req.owner!;
  const ownerType = owner.type === 'user' ? 'user' : 'anonymous';
  const ownerId = owner.id;

  const pool = getPgPool();
  const deleted: {
    scenarios: number;
    discoveries: number;
    contentChecks: number;
    shareLinks: number;
  } = { scenarios: 0, discoveries: 0, contentChecks: 0, shareLinks: 0 };

  const scenariosRes = await pool.query(
    `DELETE FROM scenarios
     WHERE owner_type = $1 AND owner_id = $2
       AND regexp_replace(site_url, '/$', '') = $3`,
    [ownerType, ownerId, siteNorm]
  );
  deleted.scenarios = scenariosRes.rowCount ?? 0;

  const discoveriesRes = await pool.query(
    `DELETE FROM discoveries
     WHERE owner_type = $1 AND owner_id = $2
       AND regexp_replace(site_url, '/$', '') = $3`,
    [ownerType, ownerId, siteNorm]
  );
  deleted.discoveries = discoveriesRes.rowCount ?? 0;

  const contentRes = await pool.query(
    `DELETE FROM content_checks
     WHERE owner_type = $1 AND owner_id = $2
       AND regexp_replace(site_url, '/$', '') = $3`,
    [ownerType, ownerId, siteNorm]
  );
  deleted.contentChecks = contentRes.rowCount ?? 0;

  if (owner.type === 'user') {
    const shareRes = await pool.query(
      `DELETE FROM site_share_links
       WHERE owner_user_id = $1
         AND regexp_replace(site_url, '/$', '') = $2`,
      [owner.id, siteNorm]
    );
    deleted.shareLinks = shareRes.rowCount ?? 0;
  }

  emitTelemetry(
    {
      eventType: 'site_deleted',
      siteUrl: siteNorm,
      deleted,
    },
    'discovery',
    'info',
    { requestId: req.requestId, traceId: req.traceId }
  );

  res.json({ ok: true, siteUrl: siteNorm, deleted });
});

router.get('/scenarios', async (req: Request, res: Response) => {
  res.json(await getScenarioRepository().getAll(req.owner!));
});

router.get('/scenarios/:id', async (req: Request, res: Response) => {
  const s = await getScenarioRepository().getById(req.params.id, req.owner!);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
});

router.get('/scenarios/:id/build-logs', async (req: Request, res: Response) => {
  const scenario = await getScenarioRepository().getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });
  const events = await getTelemetryEventRepository().getByScenarioId(req.params.id);
  const buildEvents = events.filter((e) => e.actor === 'scenario_build');
  res.json(buildEvents);
});

router.patch('/scenarios/:id', async (req: Request, res: Response) => {
  const scenario = await getScenarioRepository().getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });
  const body = req.body as {
    authProfileId?: string | null;
    name?: string;
    description?: string;
    steps?: Scenario['steps'];
    startingWebpage?: string | null;
  };
  const name = body.name ?? scenario.name;
  const description = body.description ?? scenario.description;
  const steps = body.steps ?? scenario.steps;
  const authProfileId = body.authProfileId !== undefined ? body.authProfileId : scenario.authProfileId;
  const startingWebpage = body.startingWebpage !== undefined ? body.startingWebpage : scenario.startingWebpage;
  const validation = validateStartingWebpage(startingWebpage, scenario.siteUrl);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  await getScenarioRepository().updateById(
    req.params.id,
    {
      name,
      description,
      steps,
      authProfileId,
      startingWebpage: startingWebpage ?? null,
    },
    req.owner!
  );
  res.json(await getScenarioRepository().getById(req.params.id, req.owner!));
});

router.delete('/scenarios/:id', async (req: Request, res: Response) => {
  const repo = getScenarioRepository();
  const deleted = await repo.deleteById(req.params.id, req.owner!);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  emitTelemetry(
    { eventType: 'scenario_deleted', scenarioId: req.params.id },
    'scenario_build',
    'info',
    { requestId: req.requestId, traceId: req.traceId }
  );
  res.json({ ok: true });
});

router.post('/scenarios/create-from-prompt', async (req: Request, res: Response) => {
  const { siteUrl, userMessage, startingWebpage: bodyStartingWebpage } = req.body as {
    siteUrl?: string;
    userMessage?: string;
    startingWebpage?: string | null;
  };
  if (!siteUrl || typeof siteUrl !== 'string' || !siteUrl.trim()) {
    return res.status(400).json({ error: 'siteUrl is required' });
  }
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return res.status(400).json({ error: 'userMessage is required (e.g. "Check the pricing page", "Test login")' });
  }
  const siteUrlTrimmed = siteUrl.trim();
  const validation = validateStartingWebpage(bodyStartingWebpage, siteUrlTrimmed);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  const startingWebpage =
    typeof bodyStartingWebpage === 'string' && bodyStartingWebpage.trim() ? bodyStartingWebpage.trim() : null;

  try {
    const result = await createScenarioFromPrompt({
      siteUrl: siteUrlTrimmed,
      userMessage: userMessage.trim(),
      startUrl: startingWebpage ?? siteUrlTrimmed,
    });
    const scenario = await saveScenarioDraftWithAutoRepair(
      {
        name: result.name,
        description: result.description,
        steps: result.steps,
        siteUrl: siteUrlTrimmed,
        startingWebpage: startingWebpage ?? undefined,
        authProfileId: null,
      },
      req.owner!,
      {
        mode: 'create',
        originalUserMessage: userMessage.trim(),
        requestId: req.requestId,
        traceId: req.traceId,
        pageStory: result.pageStory,
      }
    );
    res.json(scenario);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

router.post('/scenarios/:id/modify-before-run', async (req: Request, res: Response) => {
  const { userMessage } = req.body as { userMessage?: string };
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return res.status(400).json({ error: 'userMessage is required (e.g. "Don\'t do that step", "Remove step 2")' });
  }

  const repo = getScenarioRepository();
  const scenario = await repo.getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });

  try {
    emitTelemetry(
      {
        eventType: 'scenario_generation_started',
        scenarioId: scenario.id,
        mode: 'modify_before_run',
        trace: { intent: userMessage.trim() },
      },
      'scenario_build',
      'info',
      { scenarioId: scenario.id, requestId: req.requestId, traceId: req.traceId }
    );
    const result = await modifyScenarioWithAI({ scenario, mode: 'pre_run', userMessage: userMessage.trim() });
    const verified = await verifyAndRepairScenarioDraft(
      {
        name: result.name,
        description: result.description,
        steps: result.steps,
      },
      {
        scenarioBase: {
          ...scenario,
          name: result.name,
          description: result.description,
          steps: result.steps,
        },
        owner: req.owner!,
        originalUserMessage: userMessage.trim(),
        mode: 'modify_before_run',
        requestId: req.requestId,
        traceId: req.traceId,
        pageStory: result.pageStory,
      }
    );
    await repo.updateById(
      scenario.id,
      {
        name: verified.name,
        description: verified.description,
        steps: verified.steps,
        pageStory: result.pageStory ?? null,
      },
      req.owner!
    );
    const updated = await repo.getById(scenario.id, req.owner!)!;
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitTelemetry(
      {
        eventType: 'scenario_generation_failed',
        scenarioId: scenario.id,
        mode: 'modify_before_run',
        error: msg,
        trace: { intent: userMessage.trim(), verificationError: msg, rerunResult: { passed: false, error: msg } },
      },
      'scenario_build',
      'warn',
      { scenarioId: scenario.id, requestId: req.requestId, traceId: req.traceId }
    );
    res.status(400).json({ error: msg });
  }
});

router.post('/scenarios/:id/modify-step', async (req: Request, res: Response) => {
  const body = req.body as { stepIndex?: number; userMessage?: string };
  if (!Number.isInteger(body.stepIndex)) {
    return res.status(400).json({ error: 'stepIndex must be an integer' });
  }
  const stepIndex = body.stepIndex as number;
  const userMessage = body.userMessage;
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return res.status(400).json({ error: 'userMessage is required (e.g. "Use \\"contact\\" in this step")' });
  }

  const repo = getScenarioRepository();
  const scenario = await repo.getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });
  if (stepIndex < 0 || stepIndex >= scenario.steps.length) {
    return res.status(400).json({ error: `stepIndex out of range (0-${Math.max(0, scenario.steps.length - 1)})` });
  }

  try {
    const updatedStep = await modifyScenarioStepWithAI({
      scenario,
      stepIndex,
      userMessage: userMessage.trim(),
    });
    const nextSteps = [...scenario.steps];
    nextSteps[stepIndex] = updatedStep;
    await repo.updateById(
      scenario.id,
      {
        name: scenario.name,
        description: scenario.description,
        steps: nextSteps,
        authProfileId: scenario.authProfileId,
      },
      req.owner!
    );
    const updated = await repo.getById(scenario.id, req.owner!)!;
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

router.post('/scenarios/:id/modify-after-run', async (req: Request, res: Response) => {
  const { runId, userMessage } = req.body as { runId?: string; userMessage?: string };
  if (!runId) return res.status(400).json({ error: 'runId is required' });
  if (!userMessage || typeof userMessage !== 'string' || !userMessage.trim()) {
    return res.status(400).json({ error: 'userMessage is required (e.g. "Don\'t do that step", "Fix the step that failed")' });
  }

  const repo = getScenarioRepository();
  const runRepo = getRunRepository();
  const scenario = await repo.getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });

  const run = await runRepo.getById(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.scenarioId !== scenario.id) {
    return res.status(400).json({ error: 'Run does not belong to this scenario' });
  }

  try {
    const result = await modifyScenarioWithAI({ scenario, mode: 'post_run', runId, userMessage: userMessage.trim() });
    await repo.updateById(scenario.id, { name: result.name, description: result.description, steps: result.steps }, req.owner!);
    const updated = await repo.getById(scenario.id, req.owner!)!;
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

// --- Auth profiles (CRUD) ---

router.get('/auth-profiles', async (req: Request, res: Response) => {
  res.json(await getAuthProfileRepository().getAll(req.owner!));
});

router.get('/auth-profiles/:id', async (req: Request, res: Response) => {
  const profile = await getAuthProfileRepository().getById(req.params.id, req.owner!);
  if (!profile) return res.status(404).json({ error: 'Not found' });
  res.json(profile);
});

router.post('/auth-profiles', async (req: Request, res: Response) => {
  const parsed = createAuthProfileBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Check name, site URL, and mode. Add a cookie paste or Advanced JSON.',
      details: parsed.error.flatten(),
    });
  }
  const { name, baseUrl, mode, cookiesPaste, payload: rawPayload } = parsed.data;
  let payload: AuthProfilePayload = rawPayload ?? {};
  if (cookiesPaste?.trim()) {
    try {
      const cookies = parseCookiesFromDevTools(cookiesPaste.trim());
      payload = { ...payload, cookies };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(400).json({ error: msg });
    }
  }
  if (!payload.cookies?.length && !payload.extraHTTPHeaders && !payload.storageStateJson) {
    return res.status(400).json({
      error: 'Add a cookie paste from Chrome after login, or JSON in Advanced (headers or session export).',
    });
  }
  const id = uuidv4();
  const now = new Date().toISOString();
  const profile: AuthProfile = { id, name, baseUrl, mode, createdAt: now, updatedAt: now };
  try {
    await getAuthProfileRepository().save(profile, payload, req.owner!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: redactAuth(msg) });
  }
  res.status(201).json(await getAuthProfileRepository().getById(id, req.owner!));
});

router.patch('/auth-profiles/:id', async (req: Request, res: Response) => {
  const repo = getAuthProfileRepository();
  const existing = await repo.getById(req.params.id, req.owner!);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  const parsed = updateAuthProfileBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Check the fields you changed. Name and URL must stay valid.',
      details: parsed.error.flatten(),
    });
  }
  const { cookiesPaste, payload: rawPayload, ...updates } = parsed.data;
  let payloadToPersist: AuthProfilePayload | undefined;
  if (cookiesPaste?.trim() || rawPayload !== undefined) {
    const existingWithPayload = await repo.getByIdWithPayload(req.params.id, req.owner!);
    if (!existingWithPayload) return res.status(404).json({ error: 'Not found' });
    payloadToPersist = rawPayload ? { ...rawPayload } : { ...existingWithPayload.payload };
    if (cookiesPaste?.trim()) {
      try {
        const cookies = parseCookiesFromDevTools(cookiesPaste.trim());
        payloadToPersist = { ...payloadToPersist, cookies };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: msg });
      }
    }
    if (!payloadToPersist.cookies?.length && !payloadToPersist.extraHTTPHeaders && !payloadToPersist.storageStateJson) {
      return res.status(400).json({
        error: 'After this change, the profile needs cookies, headers, or session JSON—add a paste or Advanced JSON.',
      });
    }
  }
  try {
    await repo.updateById(req.params.id, { ...updates, ...(payloadToPersist && { payload: payloadToPersist }) }, req.owner!);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: redactAuth(msg) });
  }
  res.json(await repo.getById(req.params.id, req.owner!));
});

router.get('/auth-profiles/:id/validity', async (req: Request, res: Response) => {
  const profile = await getAuthProfileRepository().getByIdWithPayload(req.params.id, req.owner!);
  if (!profile) return res.status(404).json({ error: 'Not found' });
  const cookies = profile.payload.cookies ?? [];
  if (!cookies.length) {
    return res.json({
      status: 'unknown',
      label: profile.payload.storageStateJson ? 'Session JSON' : 'Add cookie paste',
      totalCookies: 0,
      expiringSoonCount: 0,
      expiredCount: 0,
    });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const soonSec = nowSec + 7 * 24 * 60 * 60;
  let expirableCount = 0;
  let expiredCount = 0;
  let expiringSoonCount = 0;

  for (const c of cookies) {
    const expires = c.expires;
    if (typeof expires !== 'number' || !Number.isFinite(expires) || expires <= 0) {
      continue;
    }
    expirableCount++;
    if (expires <= nowSec) expiredCount++;
    else if (expires <= soonSec) expiringSoonCount++;
  }

  if (expirableCount === 0) {
    return res.json({
      status: 'unknown',
      label: 'No expiry data',
      totalCookies: cookies.length,
      expiringSoonCount: 0,
      expiredCount: 0,
    });
  }
  if (expiredCount === expirableCount) {
    return res.json({
      status: 'expired',
      label: 'Expired',
      totalCookies: cookies.length,
      expiringSoonCount,
      expiredCount,
    });
  }
  if (expiredCount > 0 || expiringSoonCount > 0) {
    return res.json({
      status: 'warning',
      label: expiredCount > 0 ? `${expiredCount} expired` : 'Expires soon',
      totalCookies: cookies.length,
      expiringSoonCount,
      expiredCount,
    });
  }
  return res.json({
    status: 'valid',
    label: 'OK',
    totalCookies: cookies.length,
    expiringSoonCount: 0,
    expiredCount: 0,
  });
});

router.delete('/auth-profiles/:id', async (req: Request, res: Response) => {
  const deleted = await getAuthProfileRepository().deleteById(req.params.id, req.owner!);
  if (!deleted) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

/** First load only: title, headline, summary — then user picks scenarios vs content check. */
router.post('/site-preview', async (req: Request, res: Response) => {
  const { url, headless, authProfileId } = req.body as {
    url?: string;
    headless?: boolean;
    authProfileId?: string;
  };
  if (!url) return res.status(400).json({ error: 'url is required' });
  const headlessOpt = headless !== undefined ? headless : true;
  try {
    const result = await previewSite(url, {
      headless: headlessOpt,
      authProfileId: authProfileId || undefined,
      owner: req.owner!,
    });
    emitTelemetry(
      {
        eventType: 'site_preview_completed',
        siteUrl: url,
        resolvedUrl: result.resolvedUrl,
        headless: headlessOpt,
        authProfileId: authProfileId ?? null,
      },
      'discovery',
      'info',
      { requestId: req.requestId, traceId: req.traceId }
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitTelemetry(
      { eventType: 'site_preview_failed', siteUrl: url, error: redactAuth(msg) },
      'discovery',
      'error',
      { requestId: req.requestId, traceId: req.traceId }
    );
    res.status(500).json({ error: redactAuth(msg) });
  }
});

/** Persona / copy review crawl + judgment (isolated from discovery). */
router.post('/content-check', async (req: Request, res: Response) => {
  if (!isContentCheckEnabled()) {
    return res.status(503).json({ error: 'Content check is temporarily disabled.' });
  }
  const { url, headless, authProfileId, persona, maxExtraPages } = req.body as {
    url?: string;
    headless?: boolean;
    authProfileId?: string;
    persona?: string;
    maxExtraPages?: number;
  };
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url is required' });
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'url must be http or https' });
  }

  const headlessOpt = headless !== undefined ? headless : true;
  let maxExtra = 3;
  if (typeof maxExtraPages === 'number' && Number.isFinite(maxExtraPages)) {
    maxExtra = Math.floor(maxExtraPages);
  }
  maxExtra = Math.max(0, Math.min(8, maxExtra));

  const contentCheckId = uuidv4();
  const contentCheckRepo = getContentCheckRepository();
  const contentCheckCreatedAt = new Date().toISOString();
  await contentCheckRepo.save(
    {
      id: contentCheckId,
      siteUrl: url.trim(),
      status: 'running',
      inputJson: JSON.stringify({
        headless: headlessOpt,
        authProfileId: authProfileId ?? null,
        persona: persona ?? null,
        maxExtraPages: maxExtra,
      }),
      resultJson: null,
      createdAt: contentCheckCreatedAt,
      completedAt: null,
    },
    req.owner!
  );

  const started = Date.now();
  emitTelemetry(
    {
      eventType: 'content_check_started',
      siteUrl: url.trim(),
      headless: headlessOpt,
      authProfileId: authProfileId ?? null,
    },
    'discovery',
    'info',
    { requestId: req.requestId, traceId: req.traceId }
  );

  try {
    const result = await runContentCheck(url.trim(), {
      headless: headlessOpt,
      authProfileId: authProfileId || undefined,
      owner: req.owner!,
      persona: typeof persona === 'string' ? persona : undefined,
      maxExtraPages: maxExtra,
      requestId: req.requestId,
      traceId: req.traceId,
    });
    const completedAt = new Date().toISOString();
    await contentCheckRepo.updateStatus(
      contentCheckId,
      req.owner!,
      'completed',
      JSON.stringify(result),
      completedAt
    );
    emitTelemetry(
      {
        eventType: 'content_check_completed',
        siteUrl: url.trim(),
        resolvedHomeUrl: result.resolvedHomeUrl,
        pageCount: result.pages.length,
        personaSource: result.personaUsed.source,
        durationMs: Date.now() - started,
        crawlErrorCount: result.crawlErrors?.length ?? 0,
      },
      'discovery',
      'info',
      { requestId: req.requestId, traceId: req.traceId }
    );
    res.json({ ...result, contentCheckId, contentCheckPersisted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await contentCheckRepo.updateStatus(
      contentCheckId,
      req.owner!,
      'failed',
      JSON.stringify({ error: redactAuth(msg) }),
      new Date().toISOString()
    );
    emitTelemetry(
      { eventType: 'content_check_failed', siteUrl: url.trim(), error: redactAuth(msg) },
      'discovery',
      'error',
      { requestId: req.requestId, traceId: req.traceId }
    );
    res.status(500).json({ error: redactAuth(msg), contentCheckId, contentCheckPersisted: true });
  }
});

router.get('/discoveries', async (req: Request, res: Response) => {
  const siteUrl = typeof req.query.siteUrl === 'string' ? req.query.siteUrl.trim() : undefined;
  const items = await getDiscoveryRepository().listByOwner(req.owner!, {
    siteUrl: siteUrl || undefined,
    limit: 50,
  });
  res.json({
    items: items.map((r) => ({
      id: r.id,
      siteUrl: r.siteUrl,
      status: r.status,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    })),
  });
});

router.get('/discoveries/:id', async (req: Request, res: Response) => {
  const rec = await getDiscoveryRepository().getById(req.params.id, req.owner!);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  let result: unknown = null;
  let resultParseError: string | null = null;
  if (rec.resultJson) {
    try {
      result = JSON.parse(rec.resultJson) as unknown;
    } catch {
      resultParseError = 'invalid_json';
    }
  }
  let input: unknown = null;
  if (rec.inputJson) {
    try {
      input = JSON.parse(rec.inputJson) as unknown;
    } catch {
      input = null;
    }
  }
  res.json({
    id: rec.id,
    siteUrl: rec.siteUrl,
    status: rec.status,
    createdAt: rec.createdAt,
    completedAt: rec.completedAt,
    input,
    result,
    resultParseError,
  });
});

router.get('/content-checks', async (req: Request, res: Response) => {
  const siteUrl = typeof req.query.siteUrl === 'string' ? req.query.siteUrl.trim() : undefined;
  const items = await getContentCheckRepository().listByOwner(req.owner!, {
    siteUrl: siteUrl || undefined,
    limit: 50,
  });
  res.json({
    items: items.map((r) => ({
      id: r.id,
      siteUrl: r.siteUrl,
      status: r.status,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
    })),
  });
});

router.get('/content-checks/:id', async (req: Request, res: Response) => {
  const rec = await getContentCheckRepository().getById(req.params.id, req.owner!);
  if (!rec) return res.status(404).json({ error: 'Not found' });
  let result: unknown = null;
  let resultParseError: string | null = null;
  if (rec.resultJson) {
    try {
      result = JSON.parse(rec.resultJson) as unknown;
    } catch {
      resultParseError = 'invalid_json';
    }
  }
  let input: unknown = null;
  if (rec.inputJson) {
    try {
      input = JSON.parse(rec.inputJson) as unknown;
    } catch {
      input = null;
    }
  }
  res.json({
    id: rec.id,
    siteUrl: rec.siteUrl,
    status: rec.status,
    createdAt: rec.createdAt,
    completedAt: rec.completedAt,
    input,
    result,
    resultParseError,
  });
});

router.post('/discover', async (req: Request, res: Response) => {
  const { url, headless, authProfileId } = req.body as {
    url?: string;
    headless?: boolean;
    authProfileId?: string;
  };
  if (!url) return res.status(400).json({ error: 'url is required' });

  const discoveryId = uuidv4();
  const headlessOpt = headless !== undefined ? headless : true;
  const discoveryRepo = getDiscoveryRepository();
  const discoveryCreatedAt = new Date().toISOString();
  await discoveryRepo.save(
    {
      id: discoveryId,
      siteUrl: typeof url === 'string' ? url.trim() : String(url),
      status: 'running',
      inputJson: JSON.stringify({ headless: headlessOpt, authProfileId: authProfileId ?? null }),
      resultJson: null,
      createdAt: discoveryCreatedAt,
      completedAt: null,
    },
    req.owner!
  );

  emitTelemetry(
    {
      eventType: 'discovery_started',
      siteUrl: url,
      headless: headlessOpt,
      authProfileId: authProfileId ?? null,
    },
    'discovery',
    'info',
    { discoveryId, requestId: req.requestId, traceId: req.traceId }
  );

  try {
    const result = await discoverScenarios(url, {
      headless: headlessOpt,
      authProfileId: authProfileId || undefined,
      owner: req.owner!,
      discoveryId,
      requestId: req.requestId,
      traceId: req.traceId,
    });
    await discoveryRepo.updateStatus(
      discoveryId,
      req.owner!,
      'completed',
      JSON.stringify(result),
      new Date().toISOString()
    );
    emitTelemetry(
      {
        eventType: 'discovery_completed',
        siteUrl: url,
        scenarioCount: result.scenarios.length,
        visitedPages: (result.visitedPages || []).map((p) => ({ url: p.url, requireAuth: p.requireAuth })),
        selectedCtas: result.crawlMeta?.selectedCtas || [],
        crawlErrors: result.crawlMeta?.crawlErrors || [],
        intentCount: (result.intentTraces || []).length,
        verifiedCount: result.scenarios.filter((s) => s.verificationStatus === 'verified').length,
        repairedCount: result.scenarios.filter((s) => s.verificationStatus === 'repaired').length,
        unverifiedCount: result.scenarios.filter((s) => s.verificationStatus === 'unverified').length,
        targetScenarioCount: result.targetScenarioCount,
        candidateIntentCount: result.candidateIntentCount,
      },
      'discovery',
      'info',
      { discoveryId, requestId: req.requestId, traceId: req.traceId }
    );
    res.json({ ...result, discoveryId, discoveryPersisted: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await discoveryRepo.updateStatus(
      discoveryId,
      req.owner!,
      'failed',
      JSON.stringify({ error: redactAuth(msg) }),
      new Date().toISOString()
    );
    emitTelemetry(
      { eventType: 'discovery_failed', siteUrl: url, error: redactAuth(msg) },
      'discovery',
      'error',
      { discoveryId, requestId: req.requestId, traceId: req.traceId }
    );
    res.status(500).json({ error: redactAuth(msg), discoveryId, discoveryPersisted: true });
  }
});

router.post('/scenarios', async (req: Request, res: Response) => {
  const { scenarios } = req.body as { scenarios: ScenarioDraftInput[] };
  if (!scenarios?.length) return res.status(400).json({ error: 'scenarios array required' });
  const saved: Scenario[] = [];
  const failed: Array<{ scenarioName: string; error: string; scenarioId?: string }> = [];
  for (const s of scenarios) {
    try {
      const scenario = await saveScenarioDraftWithAutoRepair(
        s,
        req.owner!,
        {
          mode: 'discovery',
          originalUserMessage: `Discovery scenario: ${s.name}`,
          requestId: req.requestId,
          traceId: req.traceId,
        }
      );
      saved.push(scenario);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({
        scenarioName: s.name,
        error: msg,
        ...(err instanceof ScenarioSaveError ? { scenarioId: err.scenarioId } : {}),
      });
    }
  }
  if (!saved.length) {
    return res.status(400).json({
      error: failed[0]?.error || 'Failed to save scenarios',
      failed,
    });
  }
  if (failed.length) {
    return res.status(207).json({
      saved,
      failed,
      partial: true,
    });
  }
  res.json(saved);
});

router.post('/scenarios/save-one-from-discovery', async (req: Request, res: Response) => {
  const { scenario } = req.body as { scenario?: ScenarioDraftInput };
  if (!scenario) return res.status(400).json({ error: 'scenario is required' });
  const scenarioId = uuidv4();
  try {
    const saved = await saveScenarioDraftWithAutoRepair(
      scenario,
      req.owner!,
      {
        mode: 'discovery',
        originalUserMessage: `Discovery scenario: ${scenario.name}`,
        requestId: req.requestId,
        traceId: req.traceId,
        scenarioId,
      }
    );
    res.json(saved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const failedScenarioId = err instanceof ScenarioSaveError ? err.scenarioId : scenarioId;
    const events = await getTelemetryEventRepository().getByScenarioId(failedScenarioId);
    const buildLogs = events.filter((e) => e.actor === 'scenario_build').slice(-40);
    res.status(400).json({ error: msg, scenarioName: scenario.name, scenarioId: failedScenarioId, buildLogs });
  }
});

function normalizeSiteUrlForMatch(url: string): string {
  return (url || '').replace(/\/$/, '');
}

async function executeScenarioRunPipeline(
  scenario: Scenario,
  owner: Owner,
  opts: { headless?: boolean; authProfileId?: string | undefined },
  emitStep: (p: { index: number; status: string; error?: string; durationMs?: number }) => void,
  onRunReady: (run: TestRun) => void,
  ctx: { requestId?: string; traceId?: string }
): Promise<{ run: TestRun; clientError: string | undefined; traceUrl: string | undefined }> {
  const runId = uuidv4();
  const run: TestRun = {
    id: runId,
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    startedAt: new Date().toISOString(),
    status: 'running',
    steps: scenario.steps.map(s => ({ instruction: s.instruction, status: 'pending' as const, type: s.type })),
  };

  await getRunRepository().save(run);
  await getScenarioVersionRepository().save({
    id: uuidv4(),
    scenarioId: scenario.id,
    runId,
    snapshotJson: JSON.stringify(scenario),
    createdAt: new Date().toISOString(),
  });

  emitTelemetry(
    {
      eventType: 'run_started',
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      stepCount: scenario.steps.length,
      headless: opts.headless,
      authProfileId: opts.authProfileId ?? null,
    },
    'run',
    'info',
    { runId, scenarioId: scenario.id, requestId: ctx.requestId, traceId: ctx.traceId }
  );

  onRunReady(run);

  const telemetryCtx = { runId, scenarioId: scenario.id, requestId: ctx.requestId, traceId: ctx.traceId };
  let passed = false;
  let error: string | undefined;
  let tracePath: string | undefined;
  const startUrl = scenario.startingWebpage?.trim() || scenario.siteUrl;
  try {
    const result = await runScenario(
      startUrl,
      scenario.steps,
      (index, status, stepError, durationMs) => {
        const step = scenario.steps[index];
        run.steps[index] = {
          instruction: step.instruction,
          status,
          type: step.type,
          error: stepError,
          durationMs,
        };
        void Promise.resolve(getRunRepository().save(run)).catch(() => undefined);
        writeArtifact({
          runId,
          stepIndex: index,
          name: 'step-result',
          content: JSON.stringify(
            {
              instruction: step.instruction,
              type: step.type,
              status,
              durationMs: durationMs ?? null,
              error: stepError ?? null,
            },
            null,
            2
          ),
          mimeType: 'application/json',
        });
        if (status === 'pass') {
          emitTelemetry(
            { eventType: 'run_step_completed', stepIndex: index, durationMs: durationMs ?? 0 },
            'run',
            'info',
            telemetryCtx
          );
        } else {
          emitTelemetry(
            {
              eventType: 'run_step_failed',
              stepIndex: index,
              error: stepError ?? 'Unknown error',
              durationMs: durationMs ?? 0,
            },
            'run',
            'warn',
            telemetryCtx
          );
        }
        emitStep({ index, status, error: stepError, durationMs });
      },
      {
        runId,
        headless: opts.headless,
        authProfileId: opts.authProfileId,
        owner,
        onStepStart(index, instruction, stepType) {
          emitTelemetry(
            { eventType: 'run_step_started', stepIndex: index, instruction, stepType },
            'run',
            'info',
            telemetryCtx
          );
        },
      }
    );
    passed = result.passed;
    error = result.error;
    tracePath = result.tracePath;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  run.status = passed ? 'pass' : 'fail';
  run.finishedAt = new Date().toISOString();
  run.error = error;
  await getRunRepository().save(run);
  await getScenarioRepository().updateStatus(scenario.id, passed ? 'pass' : 'fail', run.finishedAt, owner);

  const traceUrl = tracePath ? `/api/runs/${runId}/trace` : undefined;
  const clientError = error ? redactAuth(error) : undefined;
  writeArtifact({
    runId,
    stepIndex: null,
    name: 'run-summary',
    content: JSON.stringify(
      {
        runId,
        scenarioId: scenario.id,
        scenarioName: scenario.name,
        status: run.status,
        error: run.error ?? null,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        steps: run.steps,
        traceUrl: traceUrl ?? null,
      },
      null,
      2
    ),
    mimeType: 'application/json',
  });

  if (passed) {
    emitTelemetry({ eventType: 'run_completed', status: 'pass' }, 'run', 'info', {
      runId,
      scenarioId: scenario.id,
      requestId: ctx.requestId,
      traceId: ctx.traceId,
    });
  } else {
    emitTelemetry(
      { eventType: 'run_failed', status: 'fail', error: redactAuth(error ?? 'Unknown') },
      'run',
      'warn',
      { runId, scenarioId: scenario.id, requestId: ctx.requestId, traceId: ctx.traceId }
    );
  }

  return { run, clientError, traceUrl };
}

router.post('/sites/:siteUrl/run-all', async (req: Request, res: Response) => {
  let siteUrlDecoded: string;
  try {
    siteUrlDecoded = decodeURIComponent(req.params.siteUrl);
  } catch {
    return res.status(400).json({ error: 'Invalid site URL' });
  }
  const target = normalizeSiteUrlForMatch(siteUrlDecoded);
  const all = await getScenarioRepository().getAll(req.owner!);
  const forSite = all.filter(s => normalizeSiteUrlForMatch(s.siteUrl || '') === target);
  if (!forSite.length) {
    return res.status(404).json({ error: 'No scenarios for this site' });
  }

  const { headless } = req.body as { headless?: boolean };
  const headlessOpt = headless !== undefined ? headless : undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const ctx = { requestId: req.requestId, traceId: req.traceId };
  send({
    type: 'batchStart',
    total: forSite.length,
    scenarios: forSite.map(s => ({ id: s.id, name: s.name })),
  });

  let passedCount = 0;
  let failedCount = 0;

  for (const scenario of forSite) {
    if (req.owner!.type === 'user') {
      const usage = await getSignedInMonthlyUsage(req.owner!.id);
      if (usage.atLimit) {
        send({
          type: 'monthlyLimitExceeded',
          scenarioId: scenario.id,
          error: 'monthly_limit_exceeded',
          used: usage.used,
          limit: usage.limit,
          remaining: usage.remaining,
          periodStartUtc: usage.periodStartUtc,
          periodEndExclusiveUtc: usage.periodEndExclusiveUtc,
          checkoutUrl: '/billing',
        });
        break;
      }
    }
    const authProfileId = scenario.authProfileId ?? undefined;
    const { run, clientError, traceUrl } = await executeScenarioRunPipeline(
      scenario,
      req.owner!,
      { headless: headlessOpt, authProfileId },
      p =>
        send({
          type: 'step',
          scenarioId: scenario.id,
          index: p.index,
          status: p.status,
          error: p.error,
          durationMs: p.durationMs,
        }),
      runReady =>
        send({
          type: 'scenarioStart',
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          runId: runReady.id,
          stepCount: runReady.steps.length,
        }),
      ctx
    );
    if (run.status === 'pass') passedCount += 1;
    else failedCount += 1;
    send({
      type: 'scenarioDone',
      scenarioId: scenario.id,
      runId: run.id,
      status: run.status,
      error: clientError,
      traceUrl: traceUrl ?? undefined,
    });
  }

  send({
    type: 'batchDone',
    total: forSite.length,
    passed: passedCount,
    failed: failedCount,
  });
  res.end();
});

router.post('/scenarios/:id/run', async (req: Request, res: Response) => {
  const scenario = await getScenarioRepository().getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });

  if (req.owner!.type === 'user') {
    const usage = await getSignedInMonthlyUsage(req.owner!.id);
    if (usage.atLimit) {
      return res.status(402).json({
        error: 'monthly_limit_exceeded',
        used: usage.used,
        limit: usage.limit,
        remaining: usage.remaining,
        periodStartUtc: usage.periodStartUtc,
        periodEndExclusiveUtc: usage.periodEndExclusiveUtc,
        checkoutUrl: '/billing',
      });
    }
  }

  const { headless, authProfileId: requestAuthProfileId } = req.body as {
    headless?: boolean;
    authProfileId?: string;
  };
  const headlessOpt = headless !== undefined ? headless : undefined;
  const authProfileId = requestAuthProfileId ?? scenario.authProfileId ?? undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const ctx = { requestId: req.requestId, traceId: req.traceId };
  const { run, clientError, traceUrl } = await executeScenarioRunPipeline(
    scenario,
    req.owner!,
    { headless: headlessOpt, authProfileId },
    p => send({ type: 'step', index: p.index, status: p.status, error: p.error, durationMs: p.durationMs }),
    runReady => send({ type: 'start', run: runReady }),
    ctx
  );

  send({ type: 'done', status: run.status, error: clientError, traceUrl: traceUrl ?? undefined });
  res.end();
});

/**
 * Run a scenario from a shared site link. Caller must be signed in; run counts against caller's monthly quota.
 * Auth cookies/profiles are resolved as the link owner (scenario author).
 */
router.post('/share/:token/scenarios/:id/run', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.status(401).json({ error: 'Sign in required to run shared scenarios' });
  }
  const raw = req.params.token || '';
  if (!isValidShareTokenFormat(raw)) {
    return res.status(404).json({ error: 'invalid_or_expired_share_link' });
  }
  const link = await getSiteShareLinkRepository().getActiveByToken(raw);
  if (!link) {
    return res.status(404).json({ error: 'invalid_or_expired_share_link' });
  }
  const scenarioOwner: Owner = { type: 'user', id: link.ownerUserId };
  const scenario = await getScenarioRepository().getById(req.params.id, scenarioOwner);
  if (!scenario) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (normalizeSiteUrlForMatch(scenario.siteUrl) !== normalizeSiteUrlForMatch(link.siteUrl)) {
    return res.status(403).json({ error: 'scenario_not_in_shared_site' });
  }

  const usage = await getSignedInMonthlyUsage(req.owner!.id);
  if (usage.atLimit) {
    return res.status(402).json({
      error: 'monthly_limit_exceeded',
      used: usage.used,
      limit: usage.limit,
      remaining: usage.remaining,
      periodStartUtc: usage.periodStartUtc,
      periodEndExclusiveUtc: usage.periodEndExclusiveUtc,
      checkoutUrl: '/billing',
    });
  }

  const { headless, authProfileId: requestAuthProfileId } = req.body as {
    headless?: boolean;
    authProfileId?: string;
  };
  const headlessOpt = headless !== undefined ? headless : undefined;
  const authProfileId = requestAuthProfileId ?? scenario.authProfileId ?? undefined;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data: object) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  const ctx = { requestId: req.requestId, traceId: req.traceId };
  const { run, clientError, traceUrl } = await executeScenarioRunPipeline(
    scenario,
    scenarioOwner,
    { headless: headlessOpt, authProfileId },
    p => send({ type: 'step', index: p.index, status: p.status, error: p.error, durationMs: p.durationMs }),
    runReady => send({ type: 'start', run: runReady }),
    ctx
  );

  const shareTraceUrl = traceUrl
    ? `/api/share/${encodeURIComponent(raw)}/runs/${run.id}/trace`
    : undefined;
  send({ type: 'done', status: run.status, error: clientError, traceUrl: shareTraceUrl ?? undefined });
  res.end();
});

router.get('/share/:token/runs/:runId/trace', async (req: Request, res: Response) => {
  if (req.owner!.type !== 'user') {
    return res.status(401).json({ error: 'Sign in required' });
  }
  const raw = req.params.token || '';
  if (!isValidShareTokenFormat(raw)) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  const link = await getSiteShareLinkRepository().getActiveByToken(raw);
  if (!link) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  const run = await getRunRepository().getById(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  const scenario = await getScenarioRepository().getById(run.scenarioId, {
    type: 'user',
    id: link.ownerUserId,
  });
  if (
    !scenario ||
    normalizeSiteUrlForMatch(scenario.siteUrl) !== normalizeSiteUrlForMatch(link.siteUrl)
  ) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  const traceDir = getArtifactDir(req.params.runId, null);
  const traceFile = path.join(traceDir, 'trace.zip');
  if (!fs.existsSync(traceFile)) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="trace.zip"');
  res.sendFile(path.resolve(traceFile));
});

async function runBelongsToOwner(runId: string, owner: Owner | undefined): Promise<boolean> {
  if (!owner) return false;
  const run = await getRunRepository().getById(runId);
  if (!run) return false;
  return !!(await getScenarioRepository().getById(run.scenarioId, owner));
}

router.get('/runs/:runId/trace', async (req: Request, res: Response) => {
  const { runId } = req.params;
  if (!(await runBelongsToOwner(runId, req.owner))) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  const traceDir = getArtifactDir(runId, null);
  const traceFile = path.join(traceDir, 'trace.zip');
  if (!fs.existsSync(traceFile)) {
    return res.status(404).json({ error: 'Trace not found' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="trace.zip"');
  res.sendFile(path.resolve(traceFile));
});

router.get('/runs/:runId/steps/:stepIndex/snapshot', async (req: Request, res: Response) => {
  const { runId, stepIndex } = req.params;
  if (!(await runBelongsToOwner(runId, req.owner))) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  const parsedStepIndex = Number.parseInt(stepIndex, 10);
  if (!Number.isInteger(parsedStepIndex) || parsedStepIndex < 0) {
    return res.status(400).json({ error: 'Invalid step index' });
  }
  const snapshotPath = path.join(getArtifactDir(runId, parsedStepIndex), 'snapshot.jpg');
  if (!fs.existsSync(snapshotPath)) {
    return res.status(404).json({ error: 'Snapshot not found' });
  }
  res.setHeader('Content-Type', 'image/jpeg');
  res.sendFile(path.resolve(snapshotPath));
});

router.get('/runs/:runId/steps/:stepIndex/action-log', async (req: Request, res: Response) => {
  const { runId, stepIndex } = req.params;
  if (!(await runBelongsToOwner(runId, req.owner))) {
    return res.status(404).json({ error: 'Action log not found' });
  }
  const parsedStepIndex = Number.parseInt(stepIndex, 10);
  if (!Number.isInteger(parsedStepIndex) || parsedStepIndex < 0) {
    return res.status(400).json({ error: 'Invalid step index' });
  }
  const actionLogPath = path.join(getArtifactDir(runId, parsedStepIndex), 'action-log.json');
  if (!fs.existsSync(actionLogPath)) {
    return res.status(404).json({ error: 'Action log not found' });
  }
  res.setHeader('Content-Type', 'application/json');
  res.sendFile(path.resolve(actionLogPath));
});

/** Run details for in-app trace timeline: run + steps with redacted errors, traceUrl if present. */
router.get('/runs/:runId/details', async (req: Request, res: Response) => {
  const { runId } = req.params;
  if (!(await runBelongsToOwner(runId, req.owner))) {
    return res.status(404).json({ error: 'Run not found' });
  }
  const run = await getRunRepository().getById(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const traceDir = getArtifactDir(runId, null);
  const traceUrl = fs.existsSync(path.join(traceDir, 'trace.zip'))
    ? `/api/runs/${runId}/trace`
    : undefined;

  const steps = run.steps.map((s, i) => ({
    stepIndex: i,
    instruction: s.instruction,
    type: s.type ?? 'act',
    status: s.status,
    durationMs: s.durationMs ?? null,
    error: s.error ? redactAuth(s.error) : null,
    snapshotUrl: fs.existsSync(path.join(getArtifactDir(runId, i), 'snapshot.jpg'))
      ? `/api/runs/${runId}/steps/${i}/snapshot`
      : null,
    actionLogUrl: fs.existsSync(path.join(getArtifactDir(runId, i), 'action-log.json'))
      ? `/api/runs/${runId}/steps/${i}/action-log`
      : null,
  }));

  res.json({
    runId: run.id,
    scenarioId: run.scenarioId,
    scenarioName: run.scenarioName,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt ?? null,
    error: run.error ? redactAuth(run.error) : null,
    steps,
    traceUrl: traceUrl ?? null,
  });
});

router.get('/scenarios/:id/runs', async (req: Request, res: Response) => {
  const scenario = await getScenarioRepository().getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });
  res.json(await getRunRepository().getByScenarioId(req.params.id));
});
