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
} from '../repositories/index.js';
import { discoverScenarios, runScenario } from '../services/stagehand.js';
import { validateAndNormalizeSteps } from '../services/step-quality.js';
import { modifyScenarioWithAI, createScenarioFromPrompt, modifyScenarioStepWithAI } from '../services/scenario-modifier.js';
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

const SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const router = Router();

router.get('/config', (_req: Request, res: Response) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL ?? null,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? null,
    authConfigured: Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
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

router.get('/scenarios', async (req: Request, res: Response) => {
  res.json(await getScenarioRepository().getAll(req.owner!));
});

router.get('/scenarios/:id', async (req: Request, res: Response) => {
  const s = await getScenarioRepository().getById(req.params.id, req.owner!);
  if (!s) return res.status(404).json({ error: 'Not found' });
  res.json(s);
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
    const scenario: Scenario = {
      id: uuidv4(),
      name: result.name,
      description: result.description,
      steps: result.steps,
      siteUrl: siteUrlTrimmed,
      startingWebpage: startingWebpage ?? undefined,
      createdAt: new Date().toISOString(),
      lastStatus: 'never',
    };
    await getScenarioRepository().save(scenario, req.owner!);
    emitTelemetry(
      { eventType: 'scenario_saved', scenarioId: scenario.id, name: scenario.name, stepCount: scenario.steps.length },
      'scenario_build',
      'info',
      { scenarioId: scenario.id, requestId: req.requestId, traceId: req.traceId }
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
    const result = await modifyScenarioWithAI({ scenario, mode: 'pre_run', userMessage: userMessage.trim() });
    await repo.updateById(scenario.id, { name: result.name, description: result.description, steps: result.steps }, req.owner!);
    const updated = await repo.getById(scenario.id, req.owner!)!;
    res.json(updated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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

router.post('/discover', async (req: Request, res: Response) => {
  const { url, headless, authProfileId } = req.body as {
    url?: string;
    headless?: boolean;
    authProfileId?: string;
  };
  if (!url) return res.status(400).json({ error: 'url is required' });

  const discoveryId = uuidv4();
  const headlessOpt = headless !== undefined ? headless : true;
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
    });
    emitTelemetry(
      { eventType: 'discovery_completed', siteUrl: url, scenarioCount: result.scenarios.length },
      'discovery',
      'info',
      { discoveryId, requestId: req.requestId, traceId: req.traceId }
    );
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitTelemetry(
      { eventType: 'discovery_failed', siteUrl: url, error: redactAuth(msg) },
      'discovery',
      'error',
      { discoveryId, requestId: req.requestId, traceId: req.traceId }
    );
    res.status(500).json({ error: redactAuth(msg) });
  }
});

router.post('/scenarios', async (req: Request, res: Response) => {
  const { scenarios } = req.body as { scenarios: Omit<Scenario, 'id' | 'createdAt' | 'lastStatus'>[] };
  if (!scenarios?.length) return res.status(400).json({ error: 'scenarios array required' });

  for (const s of scenarios) {
    const v = validateStartingWebpage(s.startingWebpage, s.siteUrl);
    if (!v.ok) return res.status(400).json({ error: v.error, scenarioName: s.name });
  }

  const validatedList = scenarios.map(s => {
    const validated = validateAndNormalizeSteps(s.steps, {
      name: s.name,
      description: s.description,
    });
    return { scenario: s, validated };
  });
  const firstFail = validatedList.find(({ validated }) => !validated.ok);
  if (firstFail) {
    const { scenario: s, validated } = firstFail;
    return res.status(400).json({
      error: (validated as { ok: false; stepIndex: number; message: string }).message,
      stepIndex: (validated as { ok: false; stepIndex: number; message: string }).stepIndex,
      scenarioName: s.name,
    });
  }

  const repo = getScenarioRepository();
  const saved = await Promise.all(validatedList.map(async ({ scenario: s, validated }) => {
    const scenario: Scenario = {
      ...s,
      steps: (validated as { ok: true; steps: Scenario['steps'] }).steps,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      lastStatus: 'never',
    };
    await repo.save(scenario, req.owner!);
    emitTelemetry(
      { eventType: 'scenario_saved', scenarioId: scenario.id, name: scenario.name, stepCount: scenario.steps.length },
      'scenario_build',
      'info',
      { scenarioId: scenario.id, requestId: req.requestId, traceId: req.traceId }
    );
    return scenario;
  }));

  res.json(saved);
});

router.post('/scenarios/:id/run', async (req: Request, res: Response) => {
  const scenario = await getScenarioRepository().getById(req.params.id, req.owner!);
  if (!scenario) return res.status(404).json({ error: 'Not found' });

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
      headless: headlessOpt,
      authProfileId: authProfileId ?? null,
    },
    'run',
    'info',
    { runId, scenarioId: scenario.id, requestId: req.requestId, traceId: req.traceId }
  );

  send({ type: 'start', run });

  const telemetryCtx = { runId, scenarioId: scenario.id, requestId: req.requestId, traceId: req.traceId };
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
        content: JSON.stringify({
          instruction: step.instruction,
          type: step.type,
          status,
          durationMs: durationMs ?? null,
          error: stepError ?? null,
        }, null, 2),
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
      send({ type: 'step', index, status, error: stepError, durationMs });
    },
    {
      runId,
      headless: headlessOpt,
      authProfileId,
      owner: req.owner!,
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
  await getScenarioRepository().updateStatus(scenario.id, passed ? 'pass' : 'fail', run.finishedAt, req.owner!);

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
      requestId: req.requestId,
      traceId: req.traceId,
    });
  } else {
    emitTelemetry(
      { eventType: 'run_failed', status: 'fail', error: redactAuth(error ?? 'Unknown') },
      'run',
      'warn',
      { runId, scenarioId: scenario.id, requestId: req.requestId, traceId: req.traceId }
    );
  }

  send({ type: 'done', status: run.status, error: clientError, traceUrl: traceUrl ?? undefined });
  res.end();
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
