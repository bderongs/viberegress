import fs from 'fs';
import path from 'path';
import { Stagehand, type LocalBrowserLaunchOptions } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { getArtifactDir } from './artifact-store.js';
import {
  validateAndNormalizeSteps,
  isInputLikeInstruction,
  hasConcreteInputValue,
  normalizeInputInstruction,
} from './step-quality.js';
import { DiscoveryResult, Step, AuthProfilePayload } from '../types/index.js';
import type { Owner } from '../types/owner.js';
import { getAuthProfileRepository } from '../repositories/index.js';

const TRACE_FILENAME = 'trace.zip';
const STEP_SNAPSHOT_FILENAME = 'snapshot.jpg';
const STEP_ACTION_LOG_FILENAME = 'action-log.json';
const ATOMIC_ACTION_MAX_ATTEMPTS = 2;

type AtomicActionKind = 'act' | 'verify';

interface AtomicAction {
  kind: AtomicActionKind;
  label: string;
  action?: string;
  verifyInstruction?: string;
  targetHint?: string;
}

interface AtomicActionLog {
  kind: AtomicActionKind;
  label: string;
  attempt: number;
  status: 'pass' | 'fail';
  action?: string;
  verifyInstruction?: string;
  observeHint?: string;
  error?: string;
}

function extractQuotedValues(instruction: string): string[] {
  const out: string[] = [];
  const re = /["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(instruction)) !== null) out.push(m[1]);
  return out;
}

function hasSubmitIntent(instruction: string): boolean {
  return /\b(click|tap|press)\b.*\b(submit|send|valider|confirm|continuer)\b/i.test(instruction);
}

export function planAtomicActionsForStep(instruction: string): AtomicAction[] | null {
  const lower = instruction.toLowerCase();
  const hasFirstName = /\b(first name|given name|prénom|prenom)\b/i.test(instruction);
  const hasEmail = /\b(email address|email|adresse email|courriel)\b/i.test(instruction);

  if (hasFirstName && hasEmail) {
    const quoted = extractQuotedValues(instruction);
    const firstNameValue = quoted[0] ?? 'Test User';
    const emailValue = quoted[1] ?? 'test@example.com';
    const actions: AtomicAction[] = [
      {
        kind: 'act',
        label: 'fill_first_name',
        targetHint: 'first name input (first name, given name, prénom)',
        action: `Type "${firstNameValue}" in the first name field (first name, given name, prénom).`,
      },
      {
        kind: 'verify',
        label: 'verify_first_name',
        verifyInstruction: `Confirm a first-name field (first name, given name, prénom) is currently filled with "${firstNameValue}".`,
      },
      {
        kind: 'act',
        label: 'fill_email',
        targetHint: 'email input (email, email address, adresse email, courriel)',
        action: `Type "${emailValue}" in the email field (email, email address, adresse email, courriel).`,
      },
      {
        kind: 'verify',
        label: 'verify_email',
        verifyInstruction: `Confirm an email field (email, email address, adresse email, courriel) is currently filled with "${emailValue}".`,
      },
    ];
    if (hasSubmitIntent(instruction)) {
      actions.push({
        kind: 'act',
        label: 'submit_form',
        targetHint: 'submit button',
        action: 'Click the submit button to send the form.',
      });
    }
    return actions;
  }

  return null;
}

async function observeTargetHint(
  page: { observe?: (input: { instruction: string; iframes?: boolean }) => Promise<unknown> },
  targetHint: string
): Promise<string | undefined> {
  if (!page.observe) return undefined;
  try {
    const observed = await page.observe({
      instruction: `Find the best element for: ${targetHint}. Return the most relevant target.`,
      iframes: true,
    });
    const asText = typeof observed === 'string' ? observed : JSON.stringify(observed);
    return asText?.slice(0, 300);
  } catch {
    return undefined;
  }
}

async function executeAtomicActions(
  page: {
    act: (input: { action: string; iframes?: boolean }) => Promise<unknown>;
    extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{ passed: boolean; reason: string }>;
    observe?: (input: { instruction: string; iframes?: boolean }) => Promise<unknown>;
  },
  actions: AtomicAction[],
  logs: AtomicActionLog[]
): Promise<void> {
  for (const action of actions) {
    let success = false;
    let lastError = '';
    for (let attempt = 1; attempt <= ATOMIC_ACTION_MAX_ATTEMPTS; attempt++) {
      let observeHint: string | undefined;
      try {
        if (action.kind === 'act') {
          if (!action.action) throw new Error('Missing atomic action text');
          let actionText = action.action;
          if (attempt > 1 && action.targetHint) {
            observeHint = await observeTargetHint(page, action.targetHint);
            if (observeHint) {
              actionText = `${action.action} Prefer target matching this observed hint: ${observeHint}`;
            }
          }
          await page.act({ action: actionText, iframes: true });
          logs.push({ kind: action.kind, label: action.label, attempt, status: 'pass', action: actionText, observeHint });
        } else {
          if (!action.verifyInstruction) throw new Error('Missing atomic verify instruction');
          const result = await page.extract({
            instruction: `${action.verifyInstruction} Return true only if clearly verified.`,
            schema: z.object({ passed: z.boolean(), reason: z.string() }),
            iframes: true,
          });
          if (!result.passed) throw new Error(result.reason || 'Verification failed');
          logs.push({
            kind: action.kind,
            label: action.label,
            attempt,
            status: 'pass',
            verifyInstruction: action.verifyInstruction,
          });
        }
        success = true;
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        logs.push({
          kind: action.kind,
          label: action.label,
          attempt,
          status: 'fail',
          action: action.action,
          verifyInstruction: action.verifyInstruction,
          observeHint,
          error: lastError,
        });
      }
    }
    if (!success) {
      throw new Error(`Atomic action "${action.label}" failed: ${lastError}`);
    }
  }
}

/** Build Stagehand localBrowserLaunchOptions: base headless + optional auth cookies/headers. */
function buildLaunchOptions(
  headless: boolean,
  authPayload?: AuthProfilePayload | null
): { headless: boolean; args?: string[]; ignoreDefaultArgs?: string[]; cookies?: AuthProfilePayload['cookies']; extraHTTPHeaders?: Record<string, string> } {
  const base = getLaunchOptions(headless);
  if (!authPayload) return base;

  const cookies: Array<{ name: string; value: string; domain: string; path: string; expires?: number; httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None' }> = (authPayload.cookies ?? []).map(c => ({ ...c, path: c.path ?? '/' }));
  if (authPayload.storageStateJson) {
    try {
      const state = JSON.parse(authPayload.storageStateJson) as { cookies?: Array<{ name: string; value: string; domain: string; path?: string }> };
      if (state.cookies?.length) cookies.push(...state.cookies.map(c => ({ ...c, path: c.path ?? '/' })));
    } catch {
      // ignore malformed storage state
    }
  }
  const out = { ...base };
  if (cookies.length) (out as Record<string, unknown>).cookies = cookies;
  if (authPayload.extraHTTPHeaders && Object.keys(authPayload.extraHTTPHeaders).length > 0) {
    (out as Record<string, unknown>).extraHTTPHeaders = authPayload.extraHTTPHeaders;
  }
  return out as ReturnType<typeof getLaunchOptions> & { cookies?: typeof cookies; extraHTTPHeaders?: Record<string, string> };
}

export function inferStepType(instruction: string): Step['type'] {
  const lower = instruction.toLowerCase();
  if (/\b(check|verify|assert|ensure|confirm|should|expect|visible|present|exist)\b/.test(lower)) return 'assert';
  if (/\b(read|get|extract|find|what is|what are|list|show)\b/.test(lower)) return 'extract';
  return 'act';
}

export async function discoverScenarios(
  siteUrl: string,
  options?: { headless?: boolean; authProfileId?: string; owner?: Owner }
): Promise<DiscoveryResult> {
  const headless = options?.headless ?? true;
  let authPayload: AuthProfilePayload | undefined;
  if (options?.authProfileId) {
    if (!options?.owner) throw new Error('owner required when using auth profile');
    const withPayload = await getAuthProfileRepository().getByIdWithPayload(options.authProfileId, options.owner);
    if (!withPayload) throw new Error('Auth profile not found: ' + options.authProfileId);
    authPayload = withPayload.payload;
  }
  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    localBrowserLaunchOptions: buildLaunchOptions(headless, authPayload) as LocalBrowserLaunchOptions,
  });

  await stagehand.init();
  const page = stagehand.page;

  try {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const result = await page.extract({
      instruction: `You are analysing a website to identify the most important user scenarios for non-regression testing.
A "scenario" is a sequence of steps a real user would take to accomplish a goal (e.g. "sign up", "add item to cart", "use the search", "contact support").

Look at this page carefully and generate 3 to 5 realistic test scenarios.

Rules:
- Each scenario has a short name (max 5 words), a one-sentence description, and 3-6 steps
- Each step is a plain English instruction describing what a user does or what should be verified
- Steps must be concrete and testable (e.g. "Click the Sign Up button", "Verify the confirmation message is visible")
- Determinism without brittleness: avoid hardcoded dynamic business content (exact dates/times, exact prices, exact inventory counts, exact session titles likely to change). Prefer structural checks like "verify a date/time is displayed", "verify a price is shown", "select the first visible session/card", "verify details panel for the selected item is visible"
- INPUT RULE (mandatory): Any step that involves typing, entering, filling, writing, or searching MUST include the exact text to type in quotes. Good: Type "pricing" in the search box; Enter "test@example.com" in the email field; Type "Hello, I need help" in the message field. Bad: "Type a keyword", "Enter your email", "Type a relevant phrase", "Search for something" — these are forbidden because they give no concrete value
- For chat, contact forms, or search: use quoted literal content (e.g. Type "Hello" in the message field then Click the Send button). Never a single vague step like "Send a message to support"
- Focus on the most critical user paths — things that must never be broken`,
      schema: z.object({
        scenarios: z.array(z.object({
          name: z.string(),
          description: z.string(),
          steps: z.array(z.string()),
        })),
      }),
    });

    return {
      siteUrl,
      scenarios: result.scenarios.map(s => {
        const rawSteps = s.steps.map(instruction => {
          const cleaned = instruction
            .replace(/^\d+[\.\):]?\s*/,'')
            .replace(/^(act|assert|extract)[:\s]+/i,'')
            .trim();
          return {
            instruction: cleaned,
            type: inferStepType(cleaned),
          };
        });
        const validated = validateAndNormalizeSteps(rawSteps, {
          name: s.name,
          description: s.description,
        });
        if (!validated.ok) {
          throw new Error(`Scenario "${s.name}": ${validated.message}`);
        }
        return {
          name: s.name,
          description: s.description,
          siteUrl,
          steps: validated.steps as Step[],
        };
      }),
    };
  } finally {
    await stagehand.close();
  }
}

function getLaunchOptions(headless: boolean): { headless: boolean; args?: string[]; ignoreDefaultArgs?: string[] } {
  const base = { headless };
  if (headless) {
    // Use Chrome's "new" headless mode for better parity with headed (chat widgets, iframes, rendering).
    return {
      ...base,
      args: ['--disable-blink-features=AutomationControlled', '--headless=new'],
      ignoreDefaultArgs: ['--headless'],
    };
  }
  return base;
}

/** Delay after an act() so dynamic content (modals, chat widgets, iframes) can open before the next step. */
const POST_ACT_SETTLE_MS = 5000;

export async function runScenario(
  siteUrl: string,
  steps: Step[],
  onStepComplete: (index: number, status: 'pass' | 'fail', error?: string, durationMs?: number) => void,
  options?: {
    headless?: boolean;
    onStepStart?: (index: number, instruction: string, stepType: Step['type']) => void;
    runId?: string;
    authProfileId?: string;
    owner?: Owner;
  }
): Promise<{ passed: boolean; error?: string; tracePath?: string }> {
  // Request option takes precedence; else env HEADLESS (HEADLESS=false shows browser for dev)
  const headless = options?.headless ?? process.env.HEADLESS !== 'false';
  const runId = options?.runId;
  let authPayload: AuthProfilePayload | undefined;
  if (options?.authProfileId) {
    if (!options.owner) throw new Error('owner required when using auth profile');
    const withPayload = await getAuthProfileRepository().getByIdWithPayload(options.authProfileId, options.owner);
    if (!withPayload) throw new Error('Auth profile not found: ' + options.authProfileId);
    authPayload = withPayload.payload;
  }

  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    localBrowserLaunchOptions: buildLaunchOptions(headless, authPayload) as LocalBrowserLaunchOptions,
  });

  await stagehand.init();
  const page = stagehand.page;

  let tracePath: string | undefined;
  if (runId) {
    const traceDir = getArtifactDir(runId, null);
    fs.mkdirSync(traceDir, { recursive: true });
    tracePath = path.join(traceDir, TRACE_FILENAME);
    await stagehand.context.tracing.start({ screenshots: true, snapshots: true });
  }

  try {
    // Navigate once — the browser session stays open across all steps.
    // Each act() operates on the current page state, so step N+1 sees
    // whatever navigation or DOM changes step N caused.
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      options?.onStepStart?.(i, step.instruction, step.type);
      const start = Date.now();

      let actionLogs: AtomicActionLog[] = [];
      try {
        if (step.type === 'assert') {
          // Assertions: verify a condition is true on the current page (include iframes for chat/widgets).
          const result = await page.extract({
            instruction: `Is the following currently true on this page? "${step.instruction}". Only return true if you can clearly confirm it.`,
            schema: z.object({
              passed: z.boolean(),
              reason: z.string(),
            }),
            iframes: true,
          });
          if (!result.passed) {
            throw new Error(result.reason);
          }
        } else {
          // Runtime guard: input-like steps must have concrete values to type.
          // If they don't, try to normalize them using deterministic defaults (better form-filling).
          let actionInstruction = step.instruction;
          if (isInputLikeInstruction(step.instruction) && !hasConcreteInputValue(step.instruction)) {
            const normalized = normalizeInputInstruction(step.instruction);
            if (hasConcreteInputValue(normalized)) {
              actionInstruction = normalized;
            } else {
              throw new Error(
                `Step ${i + 1} is an input action but has no concrete value to type. ` +
                  'Edit the scenario: use a quoted string in the instruction, e.g. Type "pricing" in the search box.'
              );
            }
          }
          const plannedActions = planAtomicActionsForStep(actionInstruction);
          if (plannedActions && plannedActions.length) {
            await executeAtomicActions(page, plannedActions, actionLogs);
          } else {
            // act() with iframes: true so chat widgets and inputs inside iframes are found and used.
            await page.act({ action: actionInstruction, iframes: true });
            actionLogs.push({
              kind: 'act',
              label: 'single_step_act',
              attempt: 1,
              status: 'pass',
              action: actionInstruction,
            });
          }
          // Allow dynamic content (modals, chat, iframes) to open before the next step.
          await new Promise((r) => setTimeout(r, POST_ACT_SETTLE_MS));
        }

        await captureStepSnapshot(page, runId, i);
        await captureStepActionLog(runId, i, actionLogs);
        onStepComplete(i, 'pass', undefined, Date.now() - start);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await captureStepSnapshot(page, runId, i);
        await captureStepActionLog(runId, i, actionLogs);
        onStepComplete(i, 'fail', errorMsg, Date.now() - start);
        return { passed: false, error: `Step ${i + 1} failed: ${errorMsg}`, tracePath: runId ? TRACE_FILENAME : undefined };
      }
    }

    return { passed: true, tracePath: runId ? TRACE_FILENAME : undefined };
  } finally {
    if (tracePath) {
      try {
        await stagehand.context.tracing.stop({ path: tracePath });
      } catch (_) {
        // ignore if tracing was not started or already stopped
      }
    }
    await stagehand.close();
  }
}

async function captureStepSnapshot(
  page: { screenshot: (options: { path: string; type: 'jpeg'; quality: number; fullPage: boolean }) => Promise<unknown> },
  runId: string | undefined,
  stepIndex: number
): Promise<void> {
  if (!runId) return;
  const snapshotDir = getArtifactDir(runId, stepIndex);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const snapshotPath = path.join(snapshotDir, STEP_SNAPSHOT_FILENAME);
  try {
    await page.screenshot({
      path: snapshotPath,
      type: 'jpeg',
      quality: 60,
      fullPage: true,
    });
  } catch {
    // Snapshot capture should never fail the run.
  }
}

async function captureStepActionLog(
  runId: string | undefined,
  stepIndex: number,
  actionLogs: AtomicActionLog[]
): Promise<void> {
  if (!runId) return;
  const snapshotDir = getArtifactDir(runId, stepIndex);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const logPath = path.join(snapshotDir, STEP_ACTION_LOG_FILENAME);
  try {
    fs.writeFileSync(logPath, JSON.stringify({ actions: actionLogs }, null, 2), 'utf8');
  } catch {
    // Action log capture should never fail the run.
  }
}
