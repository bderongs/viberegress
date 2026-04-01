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
import { DiscoveryResult, Step, AuthProfilePayload, Scenario } from '../types/index.js';
import type { Owner } from '../types/owner.js';
import { getAuthProfileRepository } from '../repositories/index.js';

const TRACE_FILENAME = 'trace.zip';
const STEP_SNAPSHOT_FILENAME = 'snapshot.jpg';
const STEP_ACTION_LOG_FILENAME = 'action-log.json';
const ATOMIC_ACTION_MAX_ATTEMPTS = 2;
const DISCOVERY_MAX_CLICKS = 5;
const DISCOVERY_MAX_VISITED_PAGES = 6;
// Discovery is allowed to be slower than a single navigation because it can now build
// multi-act journeys (e.g. pricing -> checkout).
const DISCOVERY_MAX_MS = 180_000;

// For each scan, trace journeys starting from the top-priority homepage CTAs.
// Baseline target is 3; richer pages can scale up modestly via a soft heuristic.
const DISCOVERY_JOURNEY_BASELINE_TARGET = 3;
const DISCOVERY_JOURNEY_MAX_TARGET = 6;
// Max acts after the first CTA act. Total acts = 1 + DISCOVERY_JOURNEY_MAX_HOPS.
const DISCOVERY_JOURNEY_MAX_HOPS = 5; // up to ~7 pages including home

const DISCOVERY_JOURNEY_SETTLE_MS = 1800;
type DiscoveryStrictness = 'lenient' | 'medium' | 'strict';
const DISCOVERY_STRICTNESS: DiscoveryStrictness =
  process.env.DISCOVERY_STRICTNESS === 'lenient' || process.env.DISCOVERY_STRICTNESS === 'strict'
    ? process.env.DISCOVERY_STRICTNESS
    : 'medium';
type DiscoveryLogVerbosity = 'concise' | 'verbose';
const DISCOVERY_LOG_VERBOSITY: DiscoveryLogVerbosity = process.env.DISCOVERY_LOG_VERBOSITY === 'verbose' ? 'verbose' : 'concise';

interface DiscoveryVisitedPage {
  url: string;
  title: string;
  summary: string;
  requireAuth: boolean;
}

interface DiscoveryCtaCandidate {
  label: string;
  action: string;
}

interface DiscoveryIntentLog {
  label: string;
  actionInstruction: string;
  priority: number;
  sourceSection: string;
  status: 'accepted' | 'deduped' | 'failed';
  reason?: string;
  firstHopOutcome?: { url: string; title: string; requireAuth: boolean };
  finalOutcome?: { url: string; title: string; requireAuth: boolean };
  verificationStatus?: 'verified' | 'repaired' | 'unverified';
  verificationError?: string;
  traceText?: string;
}

interface IntentContract {
  goal: string;
  expectedEvidenceHints: string[];
  avoidActions: string[];
}

interface JourneyDepthSignals {
  strictness: DiscoveryStrictness;
  meaningfulActCount: number;
  hopCount: number;
  stateChanged: boolean;
  samePageLoop: boolean;
  hasOutcomeEvidence: boolean;
  hasIntentArtifacts: boolean;
  score: number;
  weakReason?: string;
}

interface DiscoveryDebugEvent {
  stepKey: 'summarizeCurrentPage' | 'nextActionDecision' | 'replanDecision' | 'fallbackDeepen' | 'finalAssert';
  schemaName: string;
  attempt: number;
  status: 'ok' | 'error';
  hopIndex: number;
  startedAt: string;
  durationMs: number;
  contextSnapshot: {
    intentLabel: string;
    url?: string;
    title?: string;
  };
  errorClass?: string;
  errorMessage?: string;
}

interface DiscoveryFailureDigestEntry {
  stepKey: string;
  errorClass: string;
  count: number;
  intents: string[];
}

interface DiscoveryTraceFailureDetails {
  failingStepKey: DiscoveryDebugEvent['stepKey'] | 'unknown';
  hopIndex: number;
  errorClass: string;
  errorMessage: string;
  debugTraceText: string;
}

class DiscoveryTraceError extends Error {
  details: DiscoveryTraceFailureDetails;

  constructor(message: string, details: DiscoveryTraceFailureDetails) {
    super(message);
    this.name = 'DiscoveryTraceError';
    this.details = details;
  }
}

function normalizeList(xs: string[] | undefined): string[] {
  return (xs || []).map((s) => (s || '').trim().toLowerCase()).filter(Boolean);
}

function truncateText(value: string, maxLen = 240): string {
  if (!value) return '';
  if (value.length <= maxLen) return value;
  return `${value.slice(0, maxLen - 3)}...`;
}

function redactSensitiveText(value: string): string {
  if (!value) return '';
  return value
    .replace(/[A-Za-z0-9_\-]{24,}/g, '[REDACTED_TOKEN]')
    .replace(/(bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
}

function normalizeErrorClass(rawMessage: string): string {
  const msg = (rawMessage || '').toLowerCase();
  if (msg.includes('response did not match schema') || msg.includes('no object generated')) return 'SchemaMismatch';
  if (msg.includes('timeout')) return 'Timeout';
  if (msg.includes('navigation')) return 'NavigationError';
  if (msg.includes('auth')) return 'AuthGate';
  return 'UnknownError';
}

function formatDebugTrace(events: DiscoveryDebugEvent[], verbosity: DiscoveryLogVerbosity = DISCOVERY_LOG_VERBOSITY): string {
  if (!events.length) return 'DEBUG TRACE\n- no debug events';
  const lines: string[] = ['DEBUG TRACE'];
  for (const e of events) {
    const base = `- hop=${e.hopIndex} step=${e.stepKey} attempt=${e.attempt} status=${e.status} schema=${e.schemaName} durationMs=${e.durationMs}`;
    const context = ` context=url:${truncateText(e.contextSnapshot.url || 'n/a', 80)} title:${truncateText(e.contextSnapshot.title || 'n/a', 80)}`;
    const err = e.status === 'error' ? ` errorClass=${e.errorClass || 'UnknownError'} error="${truncateText(e.errorMessage || 'n/a', 180)}"` : '';
    const verbose = verbosity === 'verbose' ? ` startedAt=${e.startedAt} intent=${truncateText(e.contextSnapshot.intentLabel || 'n/a', 40)}` : '';
    lines.push(`${base}${context}${err}${verbose}`);
  }
  return lines.join('\n');
}

function jaccardDistance(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : 1 - inter / union;
}

function computeProgressScore(prev: { url: string; headingSignals: string[]; primaryActions: string[] }, next: { url: string; headingSignals: string[]; primaryActions: string[] }, intent: IntentContract): number {
  const prevUrl = (prev.url || '').trim();
  const nextUrl = (next.url || '').trim();
  const urlChanged = prevUrl && nextUrl && prevUrl !== nextUrl;

  const headingsDelta = jaccardDistance(normalizeList(prev.headingSignals), normalizeList(next.headingSignals));
  const actionsDelta = jaccardDistance(normalizeList(prev.primaryActions), normalizeList(next.primaryActions));

  const intentTokens = normalizeList(intent.expectedEvidenceHints).flatMap((h) => h.split(/\s+/g)).filter((t) => t.length >= 4);
  const hay = `${(next.headingSignals || []).join(' ')} ${(next.primaryActions || []).join(' ')}`.toLowerCase();
  const newEvidence = intentTokens.some((t) => hay.includes(t));

  let score = 0;
  if (urlChanged) score += 50;
  score += Math.min(25, Math.round(headingsDelta * 25));
  score += Math.min(25, Math.round(actionsDelta * 25));
  if (newEvidence) score = Math.min(100, score + 10);
  return score;
}

function isFindBrowseBookIntent(intentLabel: string): boolean {
  const l = (intentLabel || '').toLowerCase();
  return /(find|browse|search|trouver|chercher|réserver|reserver|book|booking|session)/i.test(l);
}

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

type StepExecutionMode = 'assert_extract' | 'single_step_act' | 'atomic_actions';

interface StepDecisionLog {
  stepInstructionOriginal: string;
  stepInstructionExecuted: string;
  executionMode: StepExecutionMode;
  finalStatus: 'pass' | 'fail';
  finalError: string | null;
  assertReason?: string;
  actions: AtomicActionLog[];
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

function normalizeHost(hostname: string): string {
  return (hostname || '').replace(/^www\./i, '').toLowerCase();
}

function normalizeUrlForDiscovery(raw: string, baseOrigin?: string): string {
  if (!raw) return '';
  try {
    const u = new URL(raw, baseOrigin);
    const h = normalizeHost(u.hostname);
    const p = u.pathname.replace(/\/$/, '') || '/';
    const q = u.search || '';
    return `${u.protocol}//${h}${p}${q}`;
  } catch {
    return (raw || '').replace(/\/$/, '').trim();
  }
}

function sameSite(urlA: string, urlB: string): boolean {
  try {
    const a = new URL(urlA);
    const b = new URL(urlB);
    return normalizeHost(a.hostname) === normalizeHost(b.hostname);
  } catch {
    return false;
  }
}

function isLikelyAuthDestination(urlText: string, title: string, summary: string): boolean {
  const hay = `${urlText} ${title} ${summary}`.toLowerCase();
  return /(sign[\s-]?in|log[\s-]?in|sign[\s-]?up|create account|register|auth|connexion|inscription|se connecter|compte)/i.test(hay);
}

function classifyPage(urlText: string, title: string, summary: string): string {
  const hay = `${urlText} ${title} ${summary}`.toLowerCase();
  if (/(sign[\s-]?up|register|inscription|create account)/i.test(hay)) return 'signup';
  if (/(sign[\s-]?in|log[\s-]?in|connexion|se connecter)/i.test(hay)) return 'login';
  if (/\bpricing\b|tarif|price/.test(hay)) return 'pricing';
  if (/\bcheckout\b|payment|paiement|stripe/.test(hay)) return 'checkout';
  if (/\btest\b|questionnaire|big five|ipip/.test(hay)) return 'test_intro';
  if (/dashboard|tableau de bord|workspace/.test(hay)) return 'dashboard';
  return 'content';
}

function isLikelyDestructiveCta(label: string): boolean {
  const l = (label || '').toLowerCase();
  return /(logout|log out|delete|remove|terminate|cancel account|close account|unsubscribe|supprimer|déconnexion)/i.test(l);
}

function buildIntentContract(intent: { label: string; sourceSection: string }): IntentContract {
  const goal = `User intent from CTA "${intent.label}" in ${intent.sourceSection} section. Keep this same intent through the journey.`;
  const expectedEvidenceHints = [intent.label, 'primary destination content', 'next-step CTA aligned with original intent'];
  const avoidActions = ['contact team', 'chat support', 'newsletter', 'legal page', 'social links'];
  return { goal, expectedEvidenceHints, avoidActions };
}

function assertTextForOutcome(outcome: { pageClass: string; title: string; requireAuth: boolean }): string {
  if (outcome.pageClass === 'signup') return 'Verify that a sign-up page or account-creation form is visible.';
  if (outcome.pageClass === 'login') return 'Verify that a sign-in page or login form is visible.';
  if (outcome.pageClass === 'pricing') return 'Verify that a pricing section/page is visible.';
  if (outcome.pageClass === 'checkout') return 'Verify that a checkout or payment flow is visible.';
  if (outcome.pageClass === 'test_intro') return 'Verify that the test introduction or questionnaire page is visible.';
  if (outcome.requireAuth) return 'Verify that an authentication gate is visible before continuing.';
  return `Verify that the destination page "${outcome.title}" is visible.`;
}

/** Parsed journey continuation decision; tolerates loose model output (strings for numbers, enum variants). */
interface JourneyDecisionRow {
  done: boolean;
  doneReason: 'completed' | 'progressed' | 'stalled' | 'blocked';
  doneDetails: string;
  nextActionInstruction?: string;
  rationale: string;
  intentAlignmentScore: number;
  whyAligned: string;
}

function normalizeJourneyDoneReason(raw: unknown): JourneyDecisionRow['doneReason'] {
  const allowed: JourneyDecisionRow['doneReason'][] = ['completed', 'progressed', 'stalled', 'blocked'];
  let s = String(raw ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
  if (allowed.includes(s as JourneyDecisionRow['doneReason'])) return s as JourneyDecisionRow['doneReason'];
  if (s === 'complete') return 'completed';
  if (s === 'progress' || s === 'forward') return 'progressed';
  if (s === 'stall') return 'stalled';
  if (s === 'block') return 'blocked';
  s = s.replace(/_/g, '');
  for (const k of allowed) {
    if (s.includes(k)) return k;
  }
  return 'stalled';
}

function coerceJourneyDone(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (raw === false || raw === 0) return false;
  const t = String(raw).toLowerCase().trim();
  return t === 'true' || t === 'yes' || t === '1';
}

function coerceJourneyAlignmentScore(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.min(100, Math.max(0, raw));
  const n = parseFloat(String(raw ?? '').replace(/,/g, ''));
  if (Number.isFinite(n)) return Math.min(100, Math.max(0, n));
  return 50;
}

/**
 * Plain Zod object only (no .transform / .pipe) — Stagehand introspects schema._def.shape and breaks on ZodEffects.
 * Normalize outputs with parseJourneyDecisionRow after extract.
 */
const journeyDecisionRawSchema = z.object({
  done: z.union([z.boolean(), z.string(), z.number()]),
  doneReason: z.union([z.enum(['completed', 'progressed', 'stalled', 'blocked']), z.string()]).optional(),
  doneDetails: z.union([z.string(), z.number()]).optional().nullable(),
  nextActionInstruction: z.string().optional().nullable(),
  rationale: z.union([z.string(), z.number()]).optional().nullable(),
  intentAlignmentScore: z.union([z.number(), z.string()]).optional().nullable(),
  whyAligned: z.union([z.string(), z.number()]).optional().nullable(),
});

type JourneyDecisionRaw = z.infer<typeof journeyDecisionRawSchema>;

function parseJourneyDecisionRow(raw: JourneyDecisionRaw): JourneyDecisionRow {
  return {
    done: coerceJourneyDone(raw.done),
    doneReason: normalizeJourneyDoneReason(raw.doneReason),
    doneDetails: String(raw.doneDetails ?? ''),
    nextActionInstruction:
      raw.nextActionInstruction != null && String(raw.nextActionInstruction).trim()
        ? String(raw.nextActionInstruction).trim()
        : undefined,
    rationale: String(raw.rationale ?? ''),
    intentAlignmentScore: coerceJourneyAlignmentScore(raw.intentAlignmentScore),
    whyAligned: String(raw.whyAligned ?? ''),
  };
}

function normalizeFinalAssertInstruction(candidate: string, fallback: string): string {
  let t = (candidate || '').trim();
  if (!t) return fallback;
  const lower = t.toLowerCase();
  if (
    /^write one final verification assertion/i.test(lower) ||
    /^output a single sentence/i.test(lower) ||
    /^\s*constraints:/i.test(lower) ||
    /^intent contract:/i.test(lower) ||
    /^current page context:/i.test(lower)
  ) {
    return fallback;
  }
  if (!/^verify that\b/i.test(lower)) {
    const idx = lower.indexOf('verify that');
    if (idx >= 0) t = t.slice(idx).trim();
    else return fallback;
  }
  return t.length > 800 ? `${t.slice(0, 797)}...` : t;
}

function hasOutcomeEvidenceFromObserved(observed: {
  title: string;
  summary: string;
  headingSignals: string[];
  primaryActions: string[];
}): boolean {
  const hay = `${observed.title} ${observed.summary} ${(observed.headingSignals || []).join(' ')} ${(observed.primaryActions || []).join(' ')}`.toLowerCase();
  return /(result|results|search|filter|category|categories|listing|catalog|item|session|book|booking|reserve|réserver|trouver|chercher|sélectionner|details|détails|continue|next|start|checkout|payment|pricing|plan)/i.test(
    hay
  );
}

function hasIntentArtifacts(intentLabel: string, observed: { title: string; summary: string; headingSignals: string[]; primaryActions: string[] }): boolean {
  const tokens = normalizeList([intentLabel])
    .flatMap((x) => x.split(/\s+/g))
    .filter((t) => t.length >= 4);
  const hay = `${observed.title} ${observed.summary} ${(observed.headingSignals || []).join(' ')} ${(observed.primaryActions || []).join(' ')}`.toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

function evaluateJourneyDepth(input: {
  strictness: DiscoveryStrictness;
  baseUrl: string;
  firstHopUrl: string;
  finalUrl: string;
  hopTraces: Array<{ actionInstruction: string }>;
  finalObserved: { title: string; summary: string; headingSignals: string[]; primaryActions: string[] };
  intentLabel: string;
  stallReason?: string;
  intentDrift?: { detected: boolean; reason: string };
}): JourneyDepthSignals {
  const baseNorm = normalizeUrlForDiscovery(input.baseUrl);
  const firstNorm = normalizeUrlForDiscovery(input.firstHopUrl, new URL(input.baseUrl).origin);
  const finalNorm = normalizeUrlForDiscovery(input.finalUrl, new URL(input.baseUrl).origin);
  const meaningfulActCount = input.hopTraces.length;
  const hopCount = input.hopTraces.length;
  const stateChanged = Boolean(firstNorm && finalNorm && firstNorm !== finalNorm);
  const samePageLoop = Boolean(finalNorm && baseNorm && finalNorm === baseNorm);
  const hasOutcomeEvidence = hasOutcomeEvidenceFromObserved(input.finalObserved);
  const hasIntentEvidence = hasIntentArtifacts(input.intentLabel, input.finalObserved);
  const hasIntentSignal = hasOutcomeEvidence || hasIntentEvidence;

  let score = 0;
  if (stateChanged) score += 40;
  score += Math.min(30, meaningfulActCount * 10);
  if (hasOutcomeEvidence) score += 20;
  if (hasIntentEvidence) score += 10;
  if (samePageLoop) score -= 30;
  if (input.stallReason) score -= 20;
  if (input.intentDrift?.detected) score -= 15;
  score = Math.max(0, Math.min(100, score));

  const minScore = input.strictness === 'lenient' ? 20 : input.strictness === 'strict' ? 55 : 35;
  const needsStateOrEvidence = input.strictness !== 'lenient';
  const weakReason =
    input.stallReason ||
    (input.intentDrift?.detected ? input.intentDrift.reason : undefined) ||
    (samePageLoop && !hasIntentSignal ? 'stalled: journey looped back to start with no outcome evidence' : undefined) ||
    (needsStateOrEvidence && !stateChanged && !hasIntentSignal ? 'stalled: no state change or outcome evidence' : undefined) ||
    (score < minScore ? `stalled: weak journey depth score (${score} < ${minScore})` : undefined);

  return {
    strictness: input.strictness,
    meaningfulActCount,
    hopCount,
    stateChanged,
    samePageLoop,
    hasOutcomeEvidence,
    hasIntentArtifacts: hasIntentEvidence,
    score,
    weakReason,
  };
}

function buildScenarioDescription(input: {
  intentLabel: string;
  requireAuth: boolean;
  depth: JourneyDepthSignals;
  hopTraces: Array<{ actionInstruction: string; observedOutcome: { title: string; summary: string } }>;
  intentDrift?: { detected: boolean; reason: string };
}): string {
  const actionSummary = input.hopTraces
    .slice(0, 2)
    .map((h) => h.actionInstruction.replace(/^click\s+/i, '').trim())
    .filter(Boolean)
    .join(', then ');
  const outcomeTitle = input.hopTraces[input.hopTraces.length - 1]?.observedOutcome.title || 'the destination page';
  const progression =
    input.depth.hasOutcomeEvidence || input.depth.stateChanged
      ? `progresses through ${Math.max(1, input.depth.meaningfulActCount)} action(s) and reaches "${outcomeTitle}"`
      : `attempts to progress from "${input.intentLabel}" but remains shallow`;
  return `User starts from "${input.intentLabel}", ${actionSummary ? `follows actions (${actionSummary}), ` : ''}${progression}.${input.requireAuth ? ' Auth may be required.' : ''}${input.intentDrift?.detected ? ' Intent drift detected during tracing.' : ''}`;
}

async function summarizeCurrentPage(
  page: {
    extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{
      url: string;
      title: string;
      summary: string;
      headingSignals: string[];
      primaryActions: string[];
    }>;
  }
): Promise<{ url: string; title: string; summary: string; headingSignals: string[]; primaryActions: string[] }> {
  return await page.extract({
    instruction: `Summarize this current page for scenario discovery.
- Return current URL.
- Return a concise title or primary heading.
- Return a short summary (1-2 sentences).
- Return up to 5 visible heading signals.
- Return up to 6 concrete primary clickable actions.
Keep output factual and grounded in visible page content only.`,
    schema: z.object({
      url: z.string(),
      title: z.string(),
      summary: z.string(),
      headingSignals: z.array(z.string()),
      primaryActions: z.array(z.string()),
    }),
    iframes: true,
  });
}

async function extractIntentCandidates(
  page: {
    extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{ intents: Array<{ label: string; actionInstruction: string; priority: number; sourceSection: string }> }>;
  }
): Promise<Array<{ label: string; actionInstruction: string; priority: number; sourceSection: string }>> {
  const out = await page.extract({
    instruction: `Identify up to 10 legitimate user-intent click actions from this page.
Prioritize hero CTAs, primary nav and key product actions.
Include auth CTAs (sign in/up/login/register) if visible.
Exclude legal/footer links and destructive actions.
Return:
- label
- actionInstruction (single click instruction executable by Stagehand)
- priority (1 highest to 5 lowest)
- sourceSection (hero/nav/body).`,
    schema: z.object({
      intents: z.array(
        z.object({
          label: z.string(),
          actionInstruction: z.string(),
          priority: z.number(),
          sourceSection: z.string(),
        })
      ),
    }),
    iframes: true,
  });
  return out.intents
    .filter((i) => i.label && i.actionInstruction && !isLikelyDestructiveCta(i.label))
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 10);
}

function computeTargetScenarioCount(intents: Array<{ label: string; actionInstruction: string; priority: number; sourceSection: string }>): {
  targetCount: number;
  candidateCount: number;
} {
  const candidateCount = intents.length;
  if (candidateCount <= 0) {
    return { targetCount: 0, candidateCount: 0 };
  }

  // Start from a baseline target of 3 and scale up modestly with richness.
  // Simple richness signal: number of candidates and diversity of source sections.
  const sections = new Set(intents.map((i) => i.sourceSection || '').filter(Boolean));
  const richnessBoost =
    candidateCount >= 8 && sections.size >= 2
      ? 3
      : candidateCount >= 6 && sections.size >= 2
      ? 2
      : candidateCount >= 4
      ? 1
      : 0;

  const rawTarget = DISCOVERY_JOURNEY_BASELINE_TARGET + richnessBoost;
  const boundedTarget = Math.min(DISCOVERY_JOURNEY_MAX_TARGET, Math.max(DISCOVERY_JOURNEY_BASELINE_TARGET, rawTarget));
  // Never exceed the available candidate count.
  const targetCount = Math.min(boundedTarget, candidateCount);
  return { targetCount, candidateCount };
}

async function traceJourneyFromIntent(
  page: {
    goto: (url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>;
    act: (input: { action: string; iframes?: boolean }) => Promise<unknown>;
    extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<unknown>;
  },
  baseUrl: string,
  baseOrigin: string,
  intent: { label: string; actionInstruction: string; priority: number; sourceSection: string },
  authProfileId?: string | null
): Promise<{
  scenarioSteps: Step[];
  requireAuth: boolean;
  finalOutcome: { url: string; title: string; summary: string; pageClass: string; requireAuth: boolean };
  visitedOutcomeKey: string;
  firstHopObservedOutcome: { url: string; pageClass: string; title: string; requireAuth: boolean; summary: string };
  intentDrift?: { detected: boolean; reason: string };
  stallReason?: string;
  hopTraces: Array<{
    actionInstruction: string;
    observedOutcome: { url: string; title: string; summary: string; pageClass: string; requireAuth: boolean; headingSignals: string[]; primaryActions: string[] };
  }>;
  depthSignals: JourneyDepthSignals;
  traceText: string;
}> {
  const canContinuePastAuthGate = Boolean(authProfileId);
  const intentContract = buildIntentContract(intent);

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

  const steps: Step[] = [];
  const hopTraces: Array<{
    actionInstruction: string;
    observedOutcome: { url: string; title: string; summary: string; pageClass: string; requireAuth: boolean; headingSignals: string[]; primaryActions: string[] };
  }> = [];

  const visitedOutcomeKeys = new Set<string>();
  const usedActionKeys = new Set<string>();

  let journeyActCount = 0;
  let intentDrift: { detected: boolean; reason: string } | undefined;
  let stallReason: string | undefined;
  let deepeningAttempted = false;
  const debugEvents: DiscoveryDebugEvent[] = [];
  let lastObserved: {
    url: string;
    title: string;
    summary: string;
    pageClass: string;
    requireAuth: boolean;
    headingSignals: string[];
    primaryActions: string[];
  } | null = null;

  const compactContext = () => ({
    intentLabel: intent.label,
    url: lastObserved?.url,
    title: lastObserved?.title,
  });

  const recordDebugEvent = (event: DiscoveryDebugEvent) => {
    const safeEvent: DiscoveryDebugEvent = {
      ...event,
      contextSnapshot: {
        intentLabel: truncateText(redactSensitiveText(event.contextSnapshot.intentLabel || ''), 80),
        url: truncateText(redactSensitiveText(event.contextSnapshot.url || ''), 160),
        title: truncateText(redactSensitiveText(event.contextSnapshot.title || ''), 120),
      },
      errorMessage: event.errorMessage ? truncateText(redactSensitiveText(event.errorMessage), 320) : undefined,
    };
    debugEvents.push(safeEvent);
  };

  const toTraceError = (
    err: unknown,
    stepKey: DiscoveryDebugEvent['stepKey'] | 'unknown',
    hopIndex: number
  ): DiscoveryTraceError => {
    if (err instanceof DiscoveryTraceError) return err;
    const errorMessage = err instanceof Error ? err.message : String(err);
    const errorClass = normalizeErrorClass(errorMessage);
    return new DiscoveryTraceError(`trace_failed(${stepKey})[hop=${hopIndex}] ${truncateText(redactSensitiveText(errorMessage), 280)}`, {
      failingStepKey: stepKey,
      hopIndex,
      errorClass,
      errorMessage: truncateText(redactSensitiveText(errorMessage), 320),
      debugTraceText: formatDebugTrace(debugEvents),
    });
  };

  const instrumentedExtract = async <T>(input: {
    stepKey: DiscoveryDebugEvent['stepKey'];
    schemaName: string;
    attempt?: number;
    hopIndex?: number;
    instruction: string;
    schema: z.ZodTypeAny;
  }): Promise<T> => {
    const started = Date.now();
    try {
      const result = (await page.extract({
        instruction: input.instruction,
        schema: input.schema,
        iframes: true,
      })) as T;
      recordDebugEvent({
        stepKey: input.stepKey,
        schemaName: input.schemaName,
        attempt: input.attempt ?? 1,
        status: 'ok',
        hopIndex: input.hopIndex ?? hopTraces.length,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        contextSnapshot: compactContext(),
      });
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorClass = normalizeErrorClass(errorMessage);
      recordDebugEvent({
        stepKey: input.stepKey,
        schemaName: input.schemaName,
        attempt: input.attempt ?? 1,
        status: 'error',
        hopIndex: input.hopIndex ?? hopTraces.length,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        contextSnapshot: compactContext(),
        errorClass,
        errorMessage,
      });
      throw toTraceError(err, input.stepKey, input.hopIndex ?? hopTraces.length);
    }
  };

  const doSummarize = async () => {
    const started = Date.now();
    let observed: {
      url: string;
      title: string;
      summary: string;
      headingSignals: string[];
      primaryActions: string[];
    };
    try {
      observed = (await summarizeCurrentPage(
        page as unknown as {
          extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{
            url: string;
            title: string;
            summary: string;
            headingSignals: string[];
            primaryActions: string[];
          }>;
        }
      )) as {
        url: string;
        title: string;
        summary: string;
        headingSignals: string[];
        primaryActions: string[];
      };
      recordDebugEvent({
        stepKey: 'summarizeCurrentPage',
        schemaName: 'PageSummary',
        attempt: 1,
        status: 'ok',
        hopIndex: hopTraces.length,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        contextSnapshot: {
          intentLabel: intent.label,
          url: observed.url,
          title: observed.title,
        },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      recordDebugEvent({
        stepKey: 'summarizeCurrentPage',
        schemaName: 'PageSummary',
        attempt: 1,
        status: 'error',
        hopIndex: hopTraces.length,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        contextSnapshot: compactContext(),
        errorClass: normalizeErrorClass(errorMessage),
        errorMessage,
      });
      throw toTraceError(err, 'summarizeCurrentPage', hopTraces.length);
    }

    const normUrl = normalizeUrlForDiscovery(observed.url || '', baseOrigin);
    if (!normUrl || !sameSite(normUrl, baseUrl)) {
      return {
        url: observed.url || normUrl || '',
        title: observed.title || 'Untitled',
        summary: observed.summary || '',
        pageClass: 'content',
        requireAuth: false,
        headingSignals: observed.headingSignals || [],
        primaryActions: observed.primaryActions || [],
      };
    }

    const requireAuth = isLikelyAuthDestination(normUrl, observed.title, observed.summary);

    return {
      url: observed.url || normUrl,
      title: observed.title || 'Untitled',
      summary: observed.summary || '',
      // Classification is intentionally not used to drive discovery (only auth gating matters).
      pageClass: requireAuth ? 'auth' : 'content',
      requireAuth,
      headingSignals: observed.headingSignals || [],
      primaryActions: observed.primaryActions || [],
    };
  };

  const isTerminalOutcome = (outcome: { pageClass: string; requireAuth: boolean; url: string }) => {
    const normUrl = normalizeUrlForDiscovery(outcome.url || '', baseOrigin);
    if (!normUrl || !sameSite(normUrl, baseUrl)) return true;
    if (outcome.requireAuth && !canContinuePastAuthGate) return true;
    return false;
  };

  // First hop: perform the CTA act we were given.
  steps.push({ instruction: intent.actionInstruction, type: 'act' });
  journeyActCount++;
  usedActionKeys.add((intent.actionInstruction || '').toLowerCase().trim());
  await page.act({ action: intent.actionInstruction, iframes: true });
  await new Promise((r) => setTimeout(r, DISCOVERY_JOURNEY_SETTLE_MS));

  lastObserved = await doSummarize();
  const firstNormUrl = normalizeUrlForDiscovery(lastObserved.url || '', baseOrigin);
  if (firstNormUrl) visitedOutcomeKeys.add(firstNormUrl);
  hopTraces.push({
    actionInstruction: intent.actionInstruction,
    observedOutcome: {
      url: lastObserved.url,
      title: lastObserved.title,
      summary: lastObserved.summary,
      pageClass: lastObserved.pageClass,
      requireAuth: lastObserved.requireAuth,
      headingSignals: lastObserved.headingSignals,
      primaryActions: lastObserved.primaryActions,
    },
  });

  // Continue until terminal outcome or step budget.
  while (journeyActCount < 1 + DISCOVERY_JOURNEY_MAX_HOPS) {
    if (!lastObserved) break;

    // Terminal outcome reached.
    if (isTerminalOutcome(lastObserved)) break;

    let decision = parseJourneyDecisionRow(
      await instrumentedExtract<JourneyDecisionRaw>({
      stepKey: 'nextActionDecision',
      schemaName: 'JourneyDecision',
      hopIndex: hopTraces.length,
      instruction: `Continue a user journey starting from: "${intent.label}".
You are currently on:
- URL: ${lastObserved.url}
- Title: ${lastObserved.title}
- Summary: ${lastObserved.summary}
Visible primary actions on this page (use only these ideas; do not invent new CTAs):
${(lastObserved.primaryActions || []).slice(0, 8).map((a) => `- ${a}`).join('\n')}
Intent contract:
- Goal: ${intentContract.goal}
- Expected evidence hints: ${intentContract.expectedEvidenceHints.join(' | ')}
- Avoid actions unless absolutely necessary: ${intentContract.avoidActions.join(' | ')}

Goal:
- Choose the best NEXT primary action to progress THIS SAME intent.
- Return done=true if no meaningful forward CTA exists, or if progress is stalled/blocked.
- Otherwise return done=false and nextActionInstruction as a single click/tap instruction executable by Stagehand.
- Also return intentAlignmentScore from 0 to 100 and whyAligned.

JSON field requirements:
- done: boolean
- doneReason: one of exactly: completed | progressed | stalled | blocked
- doneDetails: short string
- nextActionInstruction: string or omit when done=true
- rationale: short string
- intentAlignmentScore: number 0-100
- whyAligned: short string`,
      schema: journeyDecisionRawSchema,
    })
    );

    if (!decision.done && decision.intentAlignmentScore < 65) {
      decision = parseJourneyDecisionRow(
        await instrumentedExtract<JourneyDecisionRaw>({
        stepKey: 'replanDecision',
        schemaName: 'JourneyReplanDecision',
        hopIndex: hopTraces.length,
        instruction: `Re-plan one time: your prior action drifted from intent.
Original CTA intent: "${intent.label}".
Current page:
- URL: ${lastObserved.url}
- Title: ${lastObserved.title}
- Summary: ${lastObserved.summary}
Visible primary actions:
${(lastObserved.primaryActions || []).slice(0, 8).map((a) => `- ${a}`).join('\n')}
Hard constraints:
- Stay aligned with original CTA intent.
- Avoid these drift actions: ${intentContract.avoidActions.join(' | ')}
- Return done=true if you cannot continue without drifting.

JSON field requirements:
- done: boolean
- doneReason: one of exactly: completed | progressed | stalled | blocked
- doneDetails, rationale, whyAligned: strings
- intentAlignmentScore: number 0-100
- nextActionInstruction: string or omit when done=true`,
        schema: journeyDecisionRawSchema,
      })
      );

      if (!decision.done && decision.intentAlignmentScore < 65) {
        intentDrift = {
          detected: true,
          reason: `Intent mismatch after re-plan: ${decision.whyAligned || decision.rationale || 'low alignment'}`,
        };
        break;
      }
    }

    if (decision.done && (decision.doneReason === 'stalled' || decision.doneReason === 'blocked')) {
      stallReason = `${decision.doneReason}: ${decision.doneDetails || decision.rationale || 'no details'}`;
      break;
    }

    if (!decision || decision.done) break;
    const nextActionInstruction = (decision.nextActionInstruction || '').trim();
    if (!nextActionInstruction) break;
    const actionKey = nextActionInstruction.toLowerCase();
    if (usedActionKeys.has(actionKey)) {
      intentDrift = {
        detected: true,
        reason: `Repeated action detected (anti-thrashing): ${nextActionInstruction}`,
      };
      break;
    }

    steps.push({ instruction: nextActionInstruction, type: 'act' });
    journeyActCount++;
    usedActionKeys.add(actionKey);
    await page.act({ action: nextActionInstruction, iframes: true });
    await new Promise((r) => setTimeout(r, DISCOVERY_JOURNEY_SETTLE_MS));

    const prevObserved = lastObserved;
    const nextObserved = await doSummarize();
    const nextNormUrl = normalizeUrlForDiscovery(nextObserved.url || '', baseOrigin);
    if (nextNormUrl && visitedOutcomeKeys.has(nextNormUrl)) {
      // Loop guard: we've come back to a previously visited URL, stop the journey.
      break;
    }
    if (nextNormUrl) visitedOutcomeKeys.add(nextNormUrl);
    lastObserved = nextObserved;

    // Progress gating: if we didn't meaningfully advance, attempt one intent-deepening fallback for find/browse/book intents.
    const progressScore = computeProgressScore(
      { url: prevObserved.url, headingSignals: prevObserved.headingSignals, primaryActions: prevObserved.primaryActions },
      { url: nextObserved.url, headingSignals: nextObserved.headingSignals, primaryActions: nextObserved.primaryActions },
      intentContract
    );
    if (progressScore < 25) {
      if (!deepeningAttempted && isFindBrowseBookIntent(intent.label)) {
        deepeningAttempted = true;
        const fallback = (await instrumentedExtract<{ done: boolean; nextActionInstruction?: string; rationale: string }>({
          stepKey: 'fallbackDeepen',
          schemaName: 'JourneyFallbackDecision',
          hopIndex: hopTraces.length,
          instruction: `The journey appears stalled after the last action (no meaningful progress).
Original CTA: "${intent.label}"
Current page:
- URL: ${lastObserved.url}
- Title: ${lastObserved.title}
- Summary: ${lastObserved.summary}
Visible primary actions:
${(lastObserved.primaryActions || []).slice(0, 10).map((a) => `- ${a}`).join('\n')}
Task:
- Propose ONE alternative next action that deepens the intent (e.g. open a list, choose a category, use search/filter, start booking).
- Do NOT click the same CTA again: "${intent.label}"
- Return done=true if you cannot deepen without drifting.`,
          schema: z.object({
            done: z.boolean(),
            nextActionInstruction: z.string().optional(),
            rationale: z.string(),
          }),
        }));

        if (fallback && !fallback.done) {
          const alt = (fallback.nextActionInstruction || '').trim();
          const altKey = alt.toLowerCase();
          if (alt && !usedActionKeys.has(altKey)) {
            steps.push({ instruction: alt, type: 'act' });
            journeyActCount++;
            usedActionKeys.add(altKey);
            await page.act({ action: alt, iframes: true });
            await new Promise((r) => setTimeout(r, DISCOVERY_JOURNEY_SETTLE_MS));
            const deepObserved = await doSummarize();
            const deepProgress = computeProgressScore(
              { url: lastObserved.url, headingSignals: lastObserved.headingSignals, primaryActions: lastObserved.primaryActions },
              { url: deepObserved.url, headingSignals: deepObserved.headingSignals, primaryActions: deepObserved.primaryActions },
              intentContract
            );
            lastObserved = deepObserved;
            hopTraces.push({
              actionInstruction: alt,
              observedOutcome: {
                url: lastObserved.url,
                title: lastObserved.title,
                summary: lastObserved.summary,
                pageClass: lastObserved.pageClass,
                requireAuth: lastObserved.requireAuth,
                headingSignals: lastObserved.headingSignals,
                primaryActions: lastObserved.primaryActions,
              },
            });
            if (deepProgress < 25) {
              stallReason = `stalled: intent did not deepen after fallback (progressScore=${deepProgress})`;
              break;
            }
          } else {
            stallReason = `stalled: fallback action repeated or empty`;
            break;
          }
        } else {
          stallReason = `stalled: ${fallback?.rationale || 'no deepen action available'}`;
          break;
        }
      } else {
        stallReason = `stalled: low progress after action (progressScore=${progressScore})`;
        break;
      }
    }

    hopTraces.push({
      actionInstruction: nextActionInstruction,
      observedOutcome: {
        url: lastObserved.url,
        title: lastObserved.title,
        summary: lastObserved.summary,
        pageClass: lastObserved.pageClass,
        requireAuth: lastObserved.requireAuth,
        headingSignals: lastObserved.headingSignals,
        primaryActions: lastObserved.primaryActions,
      },
    });
  }

  if (!lastObserved) {
    // Extremely defensive: if we couldn't summarize, keep a minimal verified shape.
    return {
      scenarioSteps: [
        { instruction: intent.actionInstruction, type: 'act' },
        { instruction: 'Verify that the destination page is visible.', type: 'assert' },
      ],
      requireAuth: false,
      finalOutcome: { url: baseUrl, title: 'Untitled', summary: '', pageClass: 'content', requireAuth: false },
      visitedOutcomeKey: 'unknown',
      firstHopObservedOutcome: {
        url: baseUrl,
        pageClass: 'content',
        title: 'Untitled',
        requireAuth: false,
        summary: '',
      },
      hopTraces: [],
      depthSignals: {
        strictness: DISCOVERY_STRICTNESS,
        meaningfulActCount: 0,
        hopCount: 0,
        stateChanged: false,
        samePageLoop: true,
        hasOutcomeEvidence: false,
        hasIntentArtifacts: false,
        score: 0,
        weakReason: 'stalled: no page summary available',
      },
      traceText: `intent="${intent.label}" -> no summary available\n${formatDebugTrace(debugEvents)}`,
    };
  }

  const visitedKey = `${normalizeUrlForDiscovery(lastObserved.url || '', baseOrigin)}`;
  const firstHop = hopTraces[0]?.observedOutcome ?? {
    url: lastObserved.url,
    title: lastObserved.title,
    summary: lastObserved.summary,
    pageClass: lastObserved.pageClass,
    requireAuth: lastObserved.requireAuth,
    headingSignals: lastObserved.headingSignals,
    primaryActions: lastObserved.primaryActions,
  };

  const finalAssertRaw = (await instrumentedExtract<{ assertInstruction: string; evidenceTargets: string[]; alignmentReason: string }>({
    stepKey: 'finalAssert',
    schemaName: 'FinalAssert',
    hopIndex: hopTraces.length,
    instruction: `Produce fields for final browser verification of this user journey.

For assertInstruction: output ONLY one executable check sentence for an automated tester. It MUST start with the exact words "Verify that" (then the rest of the sentence). Do NOT repeat these instructions, constraints, or the words "Write ONE" / "Output a single" — only the assertion sentence itself.

Constraints for the assertion content:
- It must be verifiable from visible page content RIGHT NOW (no assumptions).
- Prefer outcome-oriented evidence (results/listing/filter state/selected item/next-step entry), not only page presence.
- If outcome evidence is weak, anchor to the strongest concrete visible content.
- Do not mention abstract categories like "pricing" unless the page clearly shows pricing UI.

Intent contract:
- Goal: ${intentContract.goal}
- Expected evidence hints: ${intentContract.expectedEvidenceHints.join(' | ')}
- Avoid drift targets: ${intentContract.avoidActions.join(' | ')}

Current page context:
- URL: ${lastObserved.url}
- Title: ${lastObserved.title}
- Summary: ${lastObserved.summary}
- Heading signals: ${(lastObserved.headingSignals || []).slice(0, 6).join(' | ')}`,
    schema: z.object({
      assertInstruction: z.string(),
      evidenceTargets: z.array(z.string()),
      alignmentReason: z.string(),
    }),
  }));
  const genericFallback = assertTextForOutcome({
    pageClass: lastObserved.pageClass,
    title: lastObserved.title,
    requireAuth: lastObserved.requireAuth,
  });
  const finalAssertGenerated = (finalAssertRaw?.assertInstruction || '').trim();
  const finalAssert = normalizeFinalAssertInstruction(finalAssertGenerated, genericFallback);

  steps.push({ instruction: finalAssert, type: 'assert' });

  const traceText = hopTraces
    .map((h, i) => {
      const o = h.observedOutcome;
      return `${i + 1}. act="${h.actionInstruction}" -> url=${o.url}, requireAuth=${o.requireAuth}, title=${o.title}, summary=${o.summary}`;
    })
    .join('\n');
  const lastContextText = `\n\nLast observed page:\n- URL: ${lastObserved.url}\n- Title: ${lastObserved.title}\n- Summary: ${lastObserved.summary}\n- Auth gate likely: ${lastObserved.requireAuth}\n- Primary actions: ${(lastObserved.primaryActions || []).slice(0, 8).join(' | ')}\n`;

  const depthSignals = evaluateJourneyDepth({
    strictness: DISCOVERY_STRICTNESS,
    baseUrl,
    firstHopUrl: firstHop.url || baseUrl,
    finalUrl: lastObserved.url || baseUrl,
    hopTraces,
    finalObserved: {
      title: lastObserved.title,
      summary: lastObserved.summary,
      headingSignals: lastObserved.headingSignals,
      primaryActions: lastObserved.primaryActions,
    },
    intentLabel: intent.label,
    stallReason,
    intentDrift,
  });
  if (!stallReason && depthSignals.weakReason) {
    stallReason = depthSignals.weakReason;
  }

  return {
    scenarioSteps: steps,
    requireAuth: lastObserved.requireAuth,
    finalOutcome: {
      url: lastObserved.url,
      title: lastObserved.title,
      summary: lastObserved.summary,
      pageClass: lastObserved.pageClass,
      requireAuth: lastObserved.requireAuth,
    },
    visitedOutcomeKey: visitedKey,
    firstHopObservedOutcome: {
      url: firstHop.url,
      pageClass: firstHop.pageClass,
      title: firstHop.title,
      requireAuth: firstHop.requireAuth,
      summary: firstHop.summary,
    },
    intentDrift,
    stallReason,
    hopTraces,
    depthSignals,
    traceText:
      `Intent goal: ${intentContract.goal}\n` +
      `Hop count: ${hopTraces.length}\n` +
      traceText +
      lastContextText +
      `\nDepth signals: score=${depthSignals.score}, stateChanged=${depthSignals.stateChanged}, samePageLoop=${depthSignals.samePageLoop}, hasOutcomeEvidence=${depthSignals.hasOutcomeEvidence}, hasIntentArtifacts=${depthSignals.hasIntentArtifacts}, meaningfulActCount=${depthSignals.meaningfulActCount}` +
      `\nFinal assert alignment: ${finalAssertRaw?.alignmentReason || 'n/a'}\nEvidence targets: ${(finalAssertRaw?.evidenceTargets || []).join(' | ')}` +
      `\n\n${formatDebugTrace(debugEvents)}`,
  };
}

async function repairDiscoveryScenario(
  page: {
    goto: (url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>;
    extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{ name: string; description: string; steps: string[] }>;
  },
  startUrl: string,
  scenario: { name: string; description: string; steps: Step[]; requireAuth?: boolean },
  verifyError: string,
  traceText: string
): Promise<{ name: string; description: string; steps: Step[] } | null> {
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const repaired = await page.extract({
    instruction: `You are repairing one discovered scenario that failed verification.
Failure: ${verifyError}
Observed trace evidence:
${traceText}

Current scenario:
Name: ${scenario.name}
Description: ${scenario.description}
Steps:
${scenario.steps.map((s, i) => `${i + 1}. [${s.type}] ${s.instruction}`).join('\n')}

Rewrite this scenario so every step matches observed reality.
You may remove steps that are not supported by the observed trace, but keep the overall goal and intent.
Do not invent outcomes not present in observed trace.
Return name, description, and steps (array of strings).`,
    schema: z.object({
      name: z.string(),
      description: z.string(),
      steps: z.array(z.string()),
    }),
    iframes: true,
  });
  const rawSteps = repaired.steps.map((instruction) => {
    const cleaned = instruction
      .replace(/^\d+[\.\):]?\s*/, '')
      .replace(/^(act|assert|extract)[:\s]+/i, '')
      .trim();
    return {
      instruction: cleaned,
      type: inferStepType(cleaned),
    };
  });
  const validated = validateAndNormalizeSteps(rawSteps, {
    name: repaired.name,
    description: repaired.description,
  });
  if (!validated.ok) return null;
  return { name: repaired.name, description: repaired.description, steps: validated.steps as Step[] };
}

function buildDiscoveryLogText(input: {
  siteUrl: string;
  visitedPages: DiscoveryVisitedPage[];
  selectedCtas: string[];
  crawlErrors: string[];
  intentLogs: DiscoveryIntentLog[];
  failureDigest?: DiscoveryFailureDigestEntry[];
  scenarios: Array<Omit<Scenario, 'id' | 'createdAt' | 'lastStatus'>>;
}): string {
  const scenarioCounts = {
    verified: input.scenarios.filter((s) => s.verificationStatus === 'verified').length,
    repaired: input.scenarios.filter((s) => s.verificationStatus === 'repaired').length,
    unverified: input.scenarios.filter((s) => s.verificationStatus === 'unverified').length,
  };
  const sections: string[] = [];
  sections.push(`DISCOVERY LOG`);
  sections.push(`siteUrl: ${input.siteUrl}`);
  sections.push(`createdAt: ${new Date().toISOString()}`);
  sections.push('');
  sections.push(`SUMMARY`);
  sections.push(`selectedCtaCount: ${input.selectedCtas.length}`);
  sections.push(`visitedPageCount: ${input.visitedPages.length}`);
  sections.push(`scenarioCount: ${input.scenarios.length}`);
  sections.push(
    `verificationCounts: verified=${scenarioCounts.verified}, repaired=${scenarioCounts.repaired}, unverified=${scenarioCounts.unverified}`
  );
  sections.push(
    `failureDigestCount: ${(input.failureDigest || []).reduce((acc, row) => acc + row.count, 0)}`
  );
  sections.push('');
  sections.push(`FAILURE DIGEST`);
  sections.push(
    input.failureDigest && input.failureDigest.length
      ? input.failureDigest
          .map(
            (row, i) =>
              `${i + 1}. stepKey=${row.stepKey}, errorClass=${row.errorClass}, count=${row.count}, intents=${row.intents.join(' | ')}`
          )
          .join('\n')
      : '- none'
  );
  sections.push('');
  sections.push(`SELECTED CTAS`);
  sections.push(input.selectedCtas.length ? input.selectedCtas.map((c, i) => `${i + 1}. ${c}`).join('\n') : '- none');
  sections.push('');
  sections.push(`VISITED PAGES`);
  sections.push(
    input.visitedPages.length
      ? input.visitedPages
          .map(
            (p, i) =>
              `${i + 1}. ${p.url}\n   title: ${p.title || 'Untitled'}\n   requireAuth: ${p.requireAuth ? 'yes' : 'no'}\n   summary: ${p.summary || ''}`
          )
          .join('\n')
      : '- none'
  );
  sections.push('');
  sections.push(`INTENT JOURNEYS`);
  sections.push(
    input.intentLogs.length
      ? input.intentLogs
          .map((it, i) => {
            const lines: string[] = [];
            lines.push(`${i + 1}. label: ${it.label}`);
            lines.push(`   actionInstruction: ${it.actionInstruction}`);
            lines.push(`   priority: ${it.priority}`);
            lines.push(`   sourceSection: ${it.sourceSection}`);
            lines.push(`   status: ${it.status}`);
            if (it.reason) lines.push(`   reason: ${it.reason}`);
            if (it.firstHopOutcome) {
              lines.push(
                `   firstHop: ${it.firstHopOutcome.url} (title="${it.firstHopOutcome.title || ''}", requireAuth=${it.firstHopOutcome.requireAuth ? 'yes' : 'no'})`
              );
            }
            if (it.finalOutcome) {
              lines.push(
                `   finalOutcome: ${it.finalOutcome.url} (title="${it.finalOutcome.title || ''}", requireAuth=${it.finalOutcome.requireAuth ? 'yes' : 'no'})`
              );
            }
            if (it.verificationStatus) lines.push(`   verificationStatus: ${it.verificationStatus}`);
            if (it.verificationError) lines.push(`   verificationError: ${it.verificationError}`);
            if (it.traceText) {
              lines.push(`   trace:`);
              lines.push(
                ...it.traceText
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => `     ${line}`)
              );
            }
            return lines.join('\n');
          })
          .join('\n')
      : '- none'
  );
  sections.push('');
  sections.push(`FINAL SCENARIOS`);
  sections.push(
    input.scenarios.length
      ? input.scenarios
          .map((s, i) => {
            const lines: string[] = [];
            lines.push(`${i + 1}. name: ${s.name}`);
            lines.push(`   description: ${s.description}`);
            lines.push(`   requireAuth: ${s.requireAuth ? 'yes' : 'no'}`);
            lines.push(`   verificationStatus: ${s.verificationStatus || 'unknown'}`);
            if (s.verificationError) lines.push(`   verificationError: ${s.verificationError}`);
            lines.push(`   steps:`);
            for (let idx = 0; idx < s.steps.length; idx++) {
              const step = s.steps[idx];
              lines.push(`     ${idx + 1}. [${step.type}] ${step.instruction}`);
            }
            return lines.join('\n');
          })
          .join('\n')
      : '- none'
  );
  sections.push('');
  sections.push(`CRAWL ERRORS`);
  sections.push(input.crawlErrors.length ? input.crawlErrors.map((e, i) => `${i + 1}. ${e}`).join('\n') : '- none');
  return sections.join('\n');
}

export async function discoverScenarios(
  siteUrl: string,
  options?: { headless?: boolean; authProfileId?: string; owner?: Owner; requestId?: string; traceId?: string; discoveryId?: string }
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
    const baseUrl = siteUrl;
    const baseOrigin = new URL(baseUrl).origin;
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const visitedPages: DiscoveryVisitedPage[] = [];
    const intentTraces: DiscoveryResult['intentTraces'] = [];
    const selectedCtas: string[] = [];
    const crawlErrors: string[] = [];
    const intentLogs: DiscoveryIntentLog[] = [];
    const failureDigestAccumulator = new Map<string, { stepKey: string; errorClass: string; count: number; intents: Set<string> }>();
    const seenOutcomeKeys = new Set<string>();
    const crawlStart = Date.now();

    const home = await summarizeCurrentPage(page as unknown as {
      extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{
        url: string;
        title: string;
        summary: string;
        headingSignals: string[];
        primaryActions: string[];
      }>;
    });
    visitedPages.push({
      url: home.url || baseUrl,
      title: home.title || 'Home',
      summary: home.summary || 'Home page',
      requireAuth: isLikelyAuthDestination(home.url || baseUrl, home.title || '', home.summary || ''),
    });

    let intents: Array<{ label: string; actionInstruction: string; priority: number; sourceSection: string }> = [];
    try {
      intents = await extractIntentCandidates(page as unknown as {
        extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{ intents: Array<{ label: string; actionInstruction: string; priority: number; sourceSection: string }> }>;
      });
    } catch (err) {
      crawlErrors.push(`intent_extraction_failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    const candidateJourneyItems: Array<{
      scenario: Omit<Scenario, 'id' | 'createdAt' | 'lastStatus'>;
      traceText: string;
      depthSignals: JourneyDepthSignals;
      qualityGateReason?: string;
    }> = [];
    const { targetCount: targetScenarioCount, candidateCount: candidateIntentCount } = computeTargetScenarioCount(intents ?? []);
    const selectedIntents = (intents ?? []).slice(0, targetScenarioCount);
    for (const intent of selectedIntents) {
      if (visitedPages.length >= DISCOVERY_MAX_VISITED_PAGES) break;
      if (Date.now() - crawlStart >= DISCOVERY_MAX_MS) break;
      try {
        const trace = await traceJourneyFromIntent(
          page as unknown as {
            goto: (url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>;
            act: (input: { action: string; iframes?: boolean }) => Promise<unknown>;
            extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<unknown>;
          },
          baseUrl,
          baseOrigin,
          intent,
          options?.authProfileId
        );

        const outcomeKey = trace.visitedOutcomeKey;
        if (!outcomeKey || seenOutcomeKeys.has(outcomeKey)) {
          intentLogs.push({
            label: intent.label,
            actionInstruction: intent.actionInstruction,
            priority: intent.priority,
            sourceSection: intent.sourceSection,
            status: 'deduped',
            reason: 'final outcome already covered by another intent',
            firstHopOutcome: {
              url: trace.firstHopObservedOutcome.url || '',
              title: trace.firstHopObservedOutcome.title || '',
              requireAuth: Boolean(trace.firstHopObservedOutcome.requireAuth),
            },
            finalOutcome: {
              url: trace.finalOutcome.url || '',
              title: trace.finalOutcome.title || '',
              requireAuth: Boolean(trace.finalOutcome.requireAuth),
            },
            traceText: trace.traceText,
          });
          continue;
        }
        seenOutcomeKeys.add(outcomeKey);

        selectedCtas.push(intent.label);

        visitedPages.push({
          url: trace.finalOutcome.url || baseUrl,
          title: trace.finalOutcome.title || 'Untitled',
          summary: trace.finalOutcome.summary || '',
          requireAuth: trace.requireAuth,
        });

        // Keep existing discovery UI contract: show the first-hop outcome + evidence.
        intentTraces?.push({
          intent: {
            label: intent.label,
            actionInstruction: intent.actionInstruction,
            priority: intent.priority,
            sourceSection: intent.sourceSection,
          },
          observedOutcome: trace.firstHopObservedOutcome,
          evidence: {
            headingSignals: trace.hopTraces[0]?.observedOutcome.headingSignals || [],
            primaryActions: trace.hopTraces[0]?.observedOutcome.primaryActions || [],
          },
        });

        const baseScenario = {
          name: `${intent.label}`.slice(0, 60),
          description: buildScenarioDescription({
            intentLabel: intent.label,
            requireAuth: trace.requireAuth,
            depth: trace.depthSignals,
            hopTraces: trace.hopTraces,
            intentDrift: trace.intentDrift,
          }),
          siteUrl,
          steps: trace.scenarioSteps,
          requireAuth: trace.requireAuth,
          intentDrift: trace.intentDrift,
          verificationStatus: trace.stallReason || trace.depthSignals.weakReason ? ('unverified' as const) : ('verified' as const),
          verificationError: trace.stallReason || trace.depthSignals.weakReason || undefined,
        };

        const validated = validateAndNormalizeSteps(baseScenario.steps, {
          name: baseScenario.name,
          description: baseScenario.description,
        });
        if (!validated.ok) continue;

        candidateJourneyItems.push({
          scenario: { ...baseScenario, steps: validated.steps as Step[] },
          traceText: trace.traceText,
          depthSignals: trace.depthSignals,
          qualityGateReason: trace.depthSignals.weakReason,
        });
        intentLogs.push({
          label: intent.label,
          actionInstruction: intent.actionInstruction,
          priority: intent.priority,
          sourceSection: intent.sourceSection,
          status: 'accepted',
          firstHopOutcome: {
            url: trace.firstHopObservedOutcome.url || '',
            title: trace.firstHopObservedOutcome.title || '',
            requireAuth: Boolean(trace.firstHopObservedOutcome.requireAuth),
          },
          finalOutcome: {
            url: trace.finalOutcome.url || '',
            title: trace.finalOutcome.title || '',
            requireAuth: Boolean(trace.finalOutcome.requireAuth),
          },
          traceText: trace.traceText,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const traceFailure = err instanceof DiscoveryTraceError ? err.details : null;
        if (traceFailure) {
          const key = `${traceFailure.failingStepKey}::${traceFailure.errorClass}`;
          const existing = failureDigestAccumulator.get(key);
          if (existing) {
            existing.count += 1;
            existing.intents.add(intent.label);
          } else {
            failureDigestAccumulator.set(key, {
              stepKey: traceFailure.failingStepKey,
              errorClass: traceFailure.errorClass,
              count: 1,
              intents: new Set([intent.label]),
            });
          }
        }
        crawlErrors.push(`journey_trace_failed (${intent.label}): ${reason}`);
        intentLogs.push({
          label: intent.label,
          actionInstruction: intent.actionInstruction,
          priority: intent.priority,
          sourceSection: intent.sourceSection,
          status: 'failed',
          reason: traceFailure
            ? `${reason} [stepKey=${traceFailure.failingStepKey}, hop=${traceFailure.hopIndex}, errorClass=${traceFailure.errorClass}]`
            : reason,
          traceText: traceFailure?.debugTraceText,
        });
      }
    }

    // Fallback: keep at least one grounded scenario.
    if (!candidateJourneyItems.length) {
      candidateJourneyItems.push({
        scenario: {
          name: 'Open landing page',
          description: 'Verify the homepage loads and primary content is visible.',
          siteUrl,
          steps: [
            { instruction: 'Wait for the homepage content to load.', type: 'act' },
            { instruction: 'Verify the homepage main content is visible.', type: 'assert' },
          ],
          requireAuth: false,
          verificationStatus: 'unverified',
          verificationError: 'No clickable intent produced a distinct grounded outcome.',
        },
        traceText: 'fallback',
        depthSignals: {
          strictness: DISCOVERY_STRICTNESS,
          meaningfulActCount: 0,
          hopCount: 0,
          stateChanged: false,
          samePageLoop: false,
          hasOutcomeEvidence: false,
          hasIntentArtifacts: false,
          score: 0,
          weakReason: 'fallback: no accepted intent journeys',
        },
        qualityGateReason: 'fallback: no accepted intent journeys',
      });
    }

    // Reliability gate: verify each candidate; repair once with trace evidence if needed.
    const finalScenarios: Array<Omit<Scenario, 'id' | 'createdAt' | 'lastStatus'>> = [];
    let repairedCount = 0;
    let unverifiedCount = 0;
    let preverifyRejectedCount = 0;
    let samePageOutcomeCount = 0;
    let outcomeEvidenceCount = 0;
    let depthScoreTotal = 0;
    for (const item of candidateJourneyItems) {
      const scenario = item.scenario;
      const qualityGateReason = item.qualityGateReason;
      if (item.depthSignals.samePageLoop) samePageOutcomeCount++;
      if (item.depthSignals.hasOutcomeEvidence) outcomeEvidenceCount++;
      depthScoreTotal += item.depthSignals.score;
      if (qualityGateReason && DISCOVERY_STRICTNESS !== 'lenient') {
        preverifyRejectedCount++;
      }
      const verifyFailureContext = qualityGateReason
        ? `quality gate: ${qualityGateReason} (strictness=${DISCOVERY_STRICTNESS}, score=${item.depthSignals.score})`
        : 'verification failed';

      if (qualityGateReason && DISCOVERY_STRICTNESS === 'strict') {
        let repairedStrict: { name: string; description: string; steps: Step[] } | null = null;
        try {
          repairedStrict = await repairDiscoveryScenario(
            page as unknown as {
              goto: (url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>;
              extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{ name: string; description: string; steps: string[] }>;
            },
            baseUrl,
            scenario,
            verifyFailureContext,
            item.traceText
          );
        } catch (err) {
          crawlErrors.push(`repair_failed (${scenario.name}): ${err instanceof Error ? err.message : String(err)}`);
        }
        if (!repairedStrict) {
          finalScenarios.push({
            ...scenario,
            verificationStatus: 'unverified',
            verificationError: verifyFailureContext,
          });
          unverifiedCount++;
          const matching = intentLogs.find((l) => l.status === 'accepted' && l.label === scenario.name);
          if (matching) {
            matching.verificationStatus = 'unverified';
            matching.verificationError = verifyFailureContext;
          }
          continue;
        }
        const verifyStrictRepaired = await runScenario(baseUrl, repairedStrict.steps, () => undefined, {
          headless,
          authProfileId: options?.authProfileId,
          owner: options?.owner,
          postActSettleMs: 1500,
        });
        if (verifyStrictRepaired.passed) {
          finalScenarios.push({
            ...scenario,
            name: repairedStrict.name,
            description: repairedStrict.description,
            steps: repairedStrict.steps,
            verificationStatus: 'repaired',
            verificationError: undefined,
          });
          repairedCount++;
          const matching = intentLogs.find((l) => l.status === 'accepted' && l.label === scenario.name);
          if (matching) {
            matching.verificationStatus = 'repaired';
            matching.verificationError = undefined;
          }
        } else {
          finalScenarios.push({
            ...scenario,
            name: repairedStrict.name,
            description: repairedStrict.description,
            steps: repairedStrict.steps,
            verificationStatus: 'unverified',
            verificationError: verifyStrictRepaired.error || 'verification failed after strict quality-gate repair',
          });
          unverifiedCount++;
          const matching = intentLogs.find((l) => l.status === 'accepted' && l.label === scenario.name);
          if (matching) {
            matching.verificationStatus = 'unverified';
            matching.verificationError = verifyStrictRepaired.error || 'verification failed after strict quality-gate repair';
          }
        }
        continue;
      }

      const verify = await runScenario(
        baseUrl,
        scenario.steps,
        () => undefined,
        {
          headless,
          authProfileId: options?.authProfileId,
          owner: options?.owner,
          postActSettleMs: 1500,
        }
      );
      if (verify.passed) {
        const downgradedByQuality = Boolean(qualityGateReason && DISCOVERY_STRICTNESS === 'medium');
        if (downgradedByQuality) repairedCount++;
        finalScenarios.push({
          ...scenario,
          verificationStatus: downgradedByQuality ? 'repaired' : 'verified',
          verificationError: downgradedByQuality ? verifyFailureContext : undefined,
        });
        const matching = intentLogs.find((l) => l.status === 'accepted' && l.label === scenario.name);
        if (matching) {
          matching.verificationStatus = downgradedByQuality ? 'repaired' : 'verified';
          matching.verificationError = downgradedByQuality ? verifyFailureContext : undefined;
        }
        continue;
      }

      let repaired: { name: string; description: string; steps: Step[] } | null = null;
      try {
        repaired = await repairDiscoveryScenario(
          page as unknown as {
            goto: (url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>;
            extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<{ name: string; description: string; steps: string[] }>;
          },
          baseUrl,
          scenario,
          verify.error || verifyFailureContext,
          item.traceText
        );
      } catch (err) {
        crawlErrors.push(`repair_failed (${scenario.name}): ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!repaired) {
        finalScenarios.push({
          ...scenario,
          verificationStatus: 'unverified',
          verificationError: verify.error || verifyFailureContext,
        });
        unverifiedCount++;
        const matching = intentLogs.find((l) => l.status === 'accepted' && l.label === scenario.name);
        if (matching) {
          matching.verificationStatus = 'unverified';
          matching.verificationError = verify.error || verifyFailureContext;
        }
        continue;
      }
      const verifyRepaired = await runScenario(
        baseUrl,
        repaired.steps,
        () => undefined,
        {
          headless,
          authProfileId: options?.authProfileId,
          owner: options?.owner,
          postActSettleMs: 1500,
        }
      );
      if (verifyRepaired.passed) {
        finalScenarios.push({
          ...scenario,
          name: repaired.name,
          description: repaired.description,
          steps: repaired.steps,
          verificationStatus: 'repaired',
          verificationError: undefined,
        });
        repairedCount++;
        const matching = intentLogs.find((l) => l.status === 'accepted' && l.label === scenario.name);
        if (matching) {
          matching.verificationStatus = 'repaired';
          matching.verificationError = undefined;
        }
      } else {
        finalScenarios.push({
          ...scenario,
          name: repaired.name,
          description: repaired.description,
          steps: repaired.steps,
          verificationStatus: 'unverified',
          verificationError: verifyRepaired.error || 'verification failed after repair',
        });
        unverifiedCount++;
        const matching = intentLogs.find((l) => l.status === 'accepted' && l.label === scenario.name);
        if (matching) {
          matching.verificationStatus = 'unverified';
          matching.verificationError = verifyRepaired.error || 'verification failed after repair';
        }
      }
    }

    const summaryLine = `summary: verified=${finalScenarios.filter((s) => s.verificationStatus === 'verified').length}, repaired=${repairedCount}, unverified=${unverifiedCount}`;
    const depthSummaryLine = `depth_summary: strictness=${DISCOVERY_STRICTNESS}, preverifyRejected=${preverifyRejectedCount}, samePageOutcomes=${samePageOutcomeCount}, outcomeEvidence=${outcomeEvidenceCount}/${candidateJourneyItems.length}, avgDepthScore=${candidateJourneyItems.length ? Math.round(depthScoreTotal / candidateJourneyItems.length) : 0}, targetScenarioCount=${targetScenarioCount}, candidateIntentCount=${candidateIntentCount}`;
    const crawlErrorsWithSummary = [...crawlErrors, summaryLine, depthSummaryLine];
    const failureDigest: DiscoveryFailureDigestEntry[] = [...failureDigestAccumulator.values()]
      .map((row) => ({
        stepKey: row.stepKey,
        errorClass: row.errorClass,
        count: row.count,
        intents: [...row.intents],
      }))
      .sort((a, b) => b.count - a.count);

    const discoveryLog = buildDiscoveryLogText({
      siteUrl,
      visitedPages,
      selectedCtas,
      crawlErrors: crawlErrorsWithSummary,
      intentLogs,
      failureDigest,
      scenarios: finalScenarios,
    });

    return {
      siteUrl,
      discoveryLog,
      intentTraces,
      visitedPages,
      crawlMeta: {
        selectedCtas,
        crawlErrors: crawlErrorsWithSummary,
      },
      targetScenarioCount,
      candidateIntentCount,
      scenarios: finalScenarios,
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
    // Discovery-only: allow shorter settling for faster multi-act verification.
    postActSettleMs?: number;
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
  const postActSettleMs = options?.postActSettleMs ?? POST_ACT_SETTLE_MS;

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
      let stepInstructionExecuted = step.instruction;
      let executionMode: StepExecutionMode = 'single_step_act';
      let assertReason: string | undefined;
      try {
        if (step.type === 'assert') {
          executionMode = 'assert_extract';
          // Assertions: verify a condition is true on the current page (include iframes for chat/widgets).
          const result = await page.extract({
            instruction: `Is the following currently true on this page? "${step.instruction}".
Only return passed=true if you can clearly confirm it from visible content.
If passed=true, include a short evidenceText quote (exact visible text you used).
Also return confidence from 0 to 1 for your judgment.`,
            schema: z.object({
              passed: z.boolean(),
              reason: z.string(),
              evidenceText: z.string(),
              confidence: z.number(),
            }),
            iframes: true,
          });
          assertReason = result.reason;
          actionLogs.push({
            kind: 'verify',
            label: 'assert_step_extract',
            attempt: 1,
            status: result.passed ? 'pass' : 'fail',
            verifyInstruction: step.instruction,
            error: result.passed ? undefined : result.reason,
          });
          const evidenceOk = typeof result.evidenceText === 'string' && result.evidenceText.trim().length > 0;
          const semanticConfidenceOk = typeof result.confidence === 'number' && result.confidence >= 0.85 && result.reason.trim().length > 20;
          if (!result.passed) {
            throw new Error(result.reason);
          }
          if (!evidenceOk && !semanticConfidenceOk) {
            throw new Error('Assertion verification produced no evidence text.');
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
          stepInstructionExecuted = actionInstruction;
          const plannedActions = planAtomicActionsForStep(actionInstruction);
          if (plannedActions && plannedActions.length) {
            executionMode = 'atomic_actions';
            await executeAtomicActions(page, plannedActions, actionLogs);
          } else {
            executionMode = 'single_step_act';
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
          await new Promise((r) => setTimeout(r, postActSettleMs));
        }

        await captureStepSnapshot(page, runId, i);
        await captureStepActionLog(runId, i, {
          stepInstructionOriginal: step.instruction,
          stepInstructionExecuted,
          executionMode,
          finalStatus: 'pass',
          finalError: null,
          assertReason,
          actions: actionLogs,
        });
        onStepComplete(i, 'pass', undefined, Date.now() - start);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        if (actionLogs.length === 0) {
          actionLogs.push({
            kind: executionMode === 'assert_extract' ? 'verify' : 'act',
            label: executionMode === 'assert_extract' ? 'assert_step_extract' : 'single_step_act',
            attempt: 1,
            status: 'fail',
            action: executionMode === 'assert_extract' ? undefined : stepInstructionExecuted,
            verifyInstruction: executionMode === 'assert_extract' ? step.instruction : undefined,
            error: errorMsg,
          });
        }
        await captureStepSnapshot(page, runId, i);
        await captureStepActionLog(runId, i, {
          stepInstructionOriginal: step.instruction,
          stepInstructionExecuted,
          executionMode,
          finalStatus: 'fail',
          finalError: errorMsg,
          assertReason,
          actions: actionLogs,
        });
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
  log: StepDecisionLog
): Promise<void> {
  if (!runId) return;
  const snapshotDir = getArtifactDir(runId, stepIndex);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const logPath = path.join(snapshotDir, STEP_ACTION_LOG_FILENAME);
  try {
    fs.writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf8');
  } catch {
    // Action log capture should never fail the run.
  }
}
