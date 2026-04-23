/**
 * AI-powered scenario modification: improve or repair scenario steps using LLM,
 * with optional run feedback context for post-run fixes.
 */

import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { validateAndNormalizeSteps } from './step-quality.js';
import { inferStepType } from './stagehand.js';
import { assembleRunContext } from './run-context-assembler.js';
import type { Scenario, Step } from '../types/index.js';
import type { RunForensicsContext } from '../types/index.js';
import { logger } from '../lib/logger.js';
import { extractPageStory, narrativeBlockForPrompt, type PageStory } from './page-story.js';

const MODIFY_SCHEMA = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(z.string()),
});

const MODIFY_STEP_SCHEMA = z.object({
  instruction: z.string(),
});

export type ModifyScenarioMode = 'pre_run' | 'post_run';

export interface ModifyScenarioInput {
  scenario: Scenario;
  mode: ModifyScenarioMode;
  /** User instruction: what they want to change (e.g. "Don't do that step", "Remove step 2"). */
  userMessage: string;
  runId?: string;
}

export interface ModifyScenarioResult {
  name: string;
  description: string;
  steps: Step[];
}

/** Result of AI scenario generation with optional structured page narrative (null if extraction failed). */
export interface ModifyScenarioResultWithPageStory extends ModifyScenarioResult {
  pageStory: PageStory | null;
}

export interface ModifyScenarioStepInput {
  scenario: Scenario;
  stepIndex: number;
  userMessage: string;
}

export interface ModifyScenarioStepResult {
  instruction: string;
  type: Step['type'];
}

function rewriteExampleUrlsToSite(urlText: string, siteUrl: string): string {
  const s = (urlText || '').trim();
  if (!s) return urlText;
  let siteOrigin: string;
  try {
    siteOrigin = new URL(siteUrl).origin;
  } catch {
    return urlText;
  }

  // Replace any fully-qualified URL that uses placeholder "example" domains with the real site origin.
  // This is a guardrail against LLMs rewriting user-provided domains to reserved examples.
  return s.replace(/https?:\/\/[^\s)"']+/g, (match) => {
    let u: URL;
    try {
      u = new URL(match);
    } catch {
      return match;
    }

    const h = (u.hostname || '').toLowerCase();
    const isExampleHost =
      h === 'example.com' ||
      h.endsWith('.example.com') ||
      h === 'example' ||
      h.endsWith('.example');
    if (!isExampleHost) return match;

    return `${siteOrigin}${u.pathname || ''}${u.search || ''}${u.hash || ''}`;
  });
}

function rewriteExampleUrlsInSteps<T extends { instruction: string }>(
  steps: T[],
  siteUrl: string
): T[] {
  return steps.map((s) => ({ ...s, instruction: rewriteExampleUrlsToSite(s.instruction, siteUrl) }));
}

function buildPreRunInstruction(scenario: Scenario, userMessage: string, narrativeBlock: string): string {
  return `You are modifying a test scenario according to the user's request. Apply exactly what they ask (e.g. remove a step, change text, reorder).

${narrativeBlock}

Current scenario:
- Name: ${scenario.name}
- Description: ${scenario.description}
- Steps:
${scenario.steps.map((s, i) => `  ${i + 1}. [${s.type}] ${s.instruction}`).join('\n')}

User request: "${userMessage}"

Rules:
- Do what the user asked. If they say "don't do that step" or "remove step X", remove it. If they want different text or order, apply that.
- URL integrity: Do NOT rewrite or "anonymize" domains (do not turn real domains into *.example). If you include any URL in a step, keep the real site domain from the scenario's Site URL.
- Each step must remain a plain English instruction. Any step that involves typing MUST include the exact text in quotes (e.g. Type "pricing" in the search box).
- Keep steps atomic: each step should express one primary intent.
- When a request combines multiple intents (for example action + verification), split it into separate ordered steps.
- Put verifications in dedicated assertion-style steps when they are distinct from the user action.
- Prefer assertions on stable, clearly visible end-state evidence. Avoid transient/intermediate checks (e.g. brief loading text like "Checking...") unless the user explicitly asks for that exact transient state.
- Align new or updated steps with the page narrative above; do not add interactions with demo or low-priority sections unless the user request explicitly requires it.
- Return name, description, and steps (array of instruction strings). Keep name/description unless the user asked to change them.`;
}

function summarizeRunContext(ctx: RunForensicsContext): string {
  const lines: string[] = [
    `Run status: ${ctx.run.status}`,
    ctx.run.error ? `Run error: ${ctx.run.error}` : '',
    'Step results:',
    ...ctx.steps.map(
      (s) => `  Step ${s.stepIndex + 1}: ${s.status}${s.errorText ? ` - ${s.errorText}` : ''}`
    ),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildPostRunInstruction(
  scenario: Scenario,
  runContext: RunForensicsContext,
  userMessage: string,
  narrativeBlock: string
): string {
  const runSummary = summarizeRunContext(runContext);
  return `You are modifying a test scenario. The user has seen a run and is asking for a change. Apply their request; you can use the run feedback below as context.

${narrativeBlock}

Current scenario:
- Name: ${scenario.name}
- Description: ${scenario.description}
- Steps:
${scenario.steps.map((s, i) => `  ${i + 1}. [${s.type}] ${s.instruction}`).join('\n')}

Run feedback (for context):
${runSummary}

User request: "${userMessage}"

Rules:
- Do what the user asked (e.g. "don't do that step", "fix the step that failed", "use a different search term").
- URL integrity: Do NOT rewrite or "anonymize" domains (do not turn real domains into *.example). If you include any URL in a step, keep the real site domain from the scenario's Site URL.
- Each step must be a plain English instruction. Any step that involves typing MUST include the exact text in quotes.
- Keep steps atomic: each step should express one primary intent.
- When a request combines multiple intents (for example action + verification), split it into separate ordered steps.
- Put verifications in dedicated assertion-style steps when they are distinct from the user action.
- Align steps with the page narrative above; avoid demo-only or decorative flows unless the user explicitly asks.
- Return name, description, and steps (array of instruction strings).`;
}

function buildCreateFromPromptInstruction(siteUrl: string, userMessage: string, narrativeBlock: string): string {
  return `You are creating a new test scenario for this website. The user describes what they want to test.

Site URL: ${siteUrl}
User request: "${userMessage}"

${narrativeBlock}

Rules:
- Create a short scenario name and description that match the request.
- URL integrity: Do NOT rewrite or "anonymize" domains (do not turn real domains into *.example). If you include any URL in a step, it must stay on the same site domain as the Site URL above.
- Steps must be plain English instructions. Any step that involves typing MUST include the exact text in quotes (e.g. Type "pricing" in the search box).
- Use a small number of steps (typically 3–8) that a browser could execute: navigate, click, type, assert text or visibility.
- Follow the page narrative above for the primary user journey on this URL; do not add steps that interact with demo or decorative sections listed above unless the user explicitly asks to test those.
- Return name, description, and steps (array of instruction strings).`;
}

function buildModifySingleStepInstruction(
  scenario: Scenario,
  stepIndex: number,
  userMessage: string
): string {
  const target = scenario.steps[stepIndex];
  return `You are editing exactly one step in a test scenario based on the user's request.

Scenario:
- Name: ${scenario.name}
- Description: ${scenario.description}
- Steps:
${scenario.steps.map((s, i) => `  ${i + 1}. [${s.type}] ${s.instruction}`).join('\n')}

Target step to edit:
- Step ${stepIndex + 1}: [${target.type}] ${target.instruction}

User request: "${userMessage}"

Rules:
- Edit only step ${stepIndex + 1}. Do not add/remove/reorder steps.
- URL integrity: Do NOT rewrite or "anonymize" domains (do not turn real domains into *.example). If you include any URL in the step, keep the real site domain from the scenario's siteUrl.
- Return only the updated instruction text for that step.
- Use plain English.
- If the step involves typing, include exact typed text in quotes (e.g. Type "pricing" in the search box).`;
}

function cleanInstruction(raw: string): string {
  return raw
    .replace(/^\d+[\.\):]?\s*/, '')
    .replace(/^(act|assert|extract)[:\s]+/i, '')
    .trim();
}

/**
 * Parses and validates raw AI output into a scenario result. Throws on invalid schema,
 * empty steps, or step validation failure. Used by modifyScenarioWithAI and by tests.
 */
export function parseAndValidateModifyResult(raw: unknown): ModifyScenarioResult {
  const parsed = MODIFY_SCHEMA.safeParse(raw);
  if (!parsed.success) {
    throw new Error('AI returned invalid scenario shape: ' + parsed.error.message);
  }

  const { name, description, steps: rawSteps } = parsed.data;
  if (!rawSteps.length) {
    throw new Error('AI returned no steps');
  }

  const stepsWithTypes = rawSteps.map((instruction) => ({
    instruction: cleanInstruction(instruction),
    type: inferStepType(cleanInstruction(instruction)),
  }));

  const validated = validateAndNormalizeSteps(stepsWithTypes, { name, description });
  if (!validated.ok) {
    throw new Error(validated.message);
  }

  return { name, description, steps: validated.steps as Step[] };
}

/**
 * Modifies a scenario using AI. For post_run mode, runId must be provided and run context
 * will be loaded. Returns normalized name, description, and steps. Throws if AI output
 * is invalid or validation fails (no mutation).
 */
export async function modifyScenarioWithAI(input: ModifyScenarioInput): Promise<ModifyScenarioResultWithPageStory> {
  const { scenario, mode, runId, userMessage } = input;
  const msg = (userMessage ?? '').trim();
  if (!msg) throw new Error('userMessage is required (e.g. "Don\'t do that step", "Remove step 2")');
  logger.info('scenario_modify_start', { scenarioId: scenario.id, mode, runId });

  let runContext: RunForensicsContext | null = null;
  if (mode === 'post_run') {
    if (!runId) {
      throw new Error('runId is required for post_run modification');
    }
    runContext = await assembleRunContext(runId, { includeArtifactContent: false });
    if (!runContext) {
      throw new Error(`Run not found: ${runId}`);
    }
  }

  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    localBrowserLaunchOptions: { headless: true },
  });

  await stagehand.init();
  const page = stagehand.page;

  const urlToLoad = scenario.startingWebpage?.trim() || scenario.siteUrl;
  try {
    await page.goto(urlToLoad, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const pageStory = await extractPageStory(page);
    const narrativeBlock = narrativeBlockForPrompt(pageStory);
    const instruction =
      mode === 'pre_run'
        ? buildPreRunInstruction(scenario, input.userMessage, narrativeBlock)
        : buildPostRunInstruction(scenario, runContext!, input.userMessage, narrativeBlock);

    const raw = await page.extract({
      instruction,
      schema: MODIFY_SCHEMA,
    });

    const result = parseAndValidateModifyResult(raw);
    result.steps = rewriteExampleUrlsInSteps(result.steps, scenario.siteUrl);
    logger.info('scenario_modify_success', { scenarioId: scenario.id, mode, stepCount: result.steps.length });
    return { ...result, pageStory };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('AI returned invalid scenario shape')) {
      logger.warn('scenario_modify_invalid_schema', { scenarioId: scenario.id, mode, error: err.message });
    } else if (err instanceof Error && err.message === 'AI returned no steps') {
      logger.warn('scenario_modify_empty_steps', { scenarioId: scenario.id, mode });
    } else if (err instanceof Error && err.message.includes('Step ') && err.message.includes('input action')) {
      logger.warn('scenario_modify_validation_failed', { scenarioId: scenario.id, mode, message: err.message });
    }
    throw err;
  } finally {
    await stagehand.close();
  }
}

export interface CreateScenarioFromPromptInput {
  siteUrl: string;
  userMessage: string;
  /** URL to load for AI context; defaults to siteUrl if not set. */
  startUrl?: string;
}

/**
 * Creates a new scenario from a user prompt by loading the site and asking the AI
 * to generate name, description, and steps. Returns normalized result for the API to persist.
 */
export async function createScenarioFromPrompt(
  input: CreateScenarioFromPromptInput
): Promise<ModifyScenarioResultWithPageStory> {
  const { siteUrl, userMessage, startUrl } = input;
  const msg = (userMessage ?? '').trim();
  if (!msg) throw new Error('userMessage is required (e.g. "Check the pricing page", "Test login flow")');
  if (!siteUrl?.trim()) throw new Error('siteUrl is required');
  const urlToLoad = (startUrl && startUrl.trim()) ? startUrl.trim() : siteUrl.trim();
  logger.info('scenario_create_from_prompt_start', { siteUrl });

  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    localBrowserLaunchOptions: { headless: true },
  });

  await stagehand.init();
  const page = stagehand.page;

  try {
    await page.goto(urlToLoad, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const pageStory = await extractPageStory(page);
    const narrativeBlock = narrativeBlockForPrompt(pageStory);
    const instruction = buildCreateFromPromptInstruction(siteUrl, msg, narrativeBlock);
    const raw = await page.extract({
      instruction,
      schema: MODIFY_SCHEMA,
    });

    const result = parseAndValidateModifyResult(raw);
    result.steps = rewriteExampleUrlsInSteps(result.steps, siteUrl);
    logger.info('scenario_create_from_prompt_success', { siteUrl, stepCount: result.steps.length });
    return { ...result, pageStory };
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('AI returned invalid scenario shape')) {
      logger.warn('scenario_create_from_prompt_invalid_schema', { siteUrl, error: err.message });
    } else if (err instanceof Error && err.message === 'AI returned no steps') {
      logger.warn('scenario_create_from_prompt_empty_steps', { siteUrl });
    }
    throw err;
  } finally {
    await stagehand.close();
  }
}

/**
 * Modifies exactly one scenario step with AI and returns normalized instruction + inferred type.
 * Throws on invalid output or validation failure.
 */
export async function modifyScenarioStepWithAI(
  input: ModifyScenarioStepInput
): Promise<ModifyScenarioStepResult> {
  const { scenario, stepIndex, userMessage } = input;
  const msg = (userMessage ?? '').trim();
  if (!msg) throw new Error('userMessage is required (e.g. "Use \\"contact\\" instead of \\"pricing\\"")');
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= scenario.steps.length) {
    throw new Error(`stepIndex out of range (0-${Math.max(0, scenario.steps.length - 1)})`);
  }
  logger.info('scenario_modify_step_start', { scenarioId: scenario.id, stepIndex });

  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    localBrowserLaunchOptions: { headless: true },
  });

  await stagehand.init();
  const page = stagehand.page;

  const urlToLoad = scenario.startingWebpage?.trim() || scenario.siteUrl;
  try {
    await page.goto(urlToLoad, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const instruction = buildModifySingleStepInstruction(scenario, stepIndex, msg);
    const raw = await page.extract({
      instruction,
      schema: MODIFY_STEP_SCHEMA,
    });
    const parsed = MODIFY_STEP_SCHEMA.safeParse(raw);
    if (!parsed.success) {
      throw new Error('AI returned invalid step shape: ' + parsed.error.message);
    }

    const cleaned = cleanInstruction(parsed.data.instruction);
    const withFixedUrls = rewriteExampleUrlsToSite(cleaned, scenario.siteUrl);
    const inferredType = inferStepType(withFixedUrls);
    const validated = validateAndNormalizeSteps([{ instruction: withFixedUrls, type: inferredType }], {
      name: scenario.name,
      description: scenario.description,
    });
    if (!validated.ok) {
      throw new Error(validated.message);
    }

    const normalized = validated.steps[0] as Step;
    logger.info('scenario_modify_step_success', { scenarioId: scenario.id, stepIndex, type: normalized.type });
    return normalized;
  } finally {
    await stagehand.close();
  }
}
