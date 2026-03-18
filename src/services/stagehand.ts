import fs from 'fs';
import path from 'path';
import { Stagehand, type LocalBrowserLaunchOptions } from '@browserbasehq/stagehand';
import { z } from 'zod';
import { getArtifactDir } from './artifact-store.js';
import { validateAndNormalizeSteps, isInputLikeInstruction, hasConcreteInputValue } from './step-quality.js';
import { DiscoveryResult, Step, AuthProfilePayload } from '../types/index.js';
import type { Owner } from '../types/owner.js';
import { getAuthProfileRepository } from '../repositories/index.js';

const TRACE_FILENAME = 'trace.zip';
const STEP_SNAPSHOT_FILENAME = 'snapshot.jpg';

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
          // Run-time guard: do not execute input-like steps without a concrete value (would produce fill("")).
          if (isInputLikeInstruction(step.instruction) && !hasConcreteInputValue(step.instruction)) {
            throw new Error(
              `Step ${i + 1} is an input action but has no concrete value to type. ` +
              'Edit the scenario: use a quoted string in the instruction, e.g. Type "pricing" in the search box.'
            );
          }
          // act() with iframes: true so chat widgets and inputs inside iframes are found and used.
          await page.act({ action: step.instruction, iframes: true });
          // Allow dynamic content (modals, chat, iframes) to open before the next step.
          await new Promise((r) => setTimeout(r, POST_ACT_SETTLE_MS));
        }

        await captureStepSnapshot(page, runId, i);
        onStepComplete(i, 'pass', undefined, Date.now() - start);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        await captureStepSnapshot(page, runId, i);
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
