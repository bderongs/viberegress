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
import {
  DiscoveryResult,
  SitePreviewResult,
  Step,
  AuthProfilePayload,
  Scenario,
  ContentCheckResult,
  type CrawlPageSnapshot,
  type DiscoveryPageSummaryPersisted,
} from '../types/index.js';
import type { Owner } from '../types/owner.js';
import { getAuthProfileRepository } from '../repositories/index.js';

const TRACE_FILENAME = 'trace.zip';
const STEP_SNAPSHOT_FILENAME = 'snapshot.jpg';
const STEP_ACTION_LOG_FILENAME = 'action-log.json';
const ATOMIC_ACTION_MAX_ATTEMPTS = 2;
const DISCOVERY_MAX_CLICKS = 5;
const DISCOVERY_MAX_VISITED_PAGES = 20;
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

interface DiscoveryObservedState {
  url: string;
  title: string;
  summary: string;
  headingSignals: string[];
  primaryActions: string[];
  hasMeaningfulForm?: boolean;
  requireAuth?: boolean;
}

/** Grounded form sketch from discovery page summarization (caps applied in normalizeFormSketch). */
interface PageFormSketch {
  hasMeaningfulForm: boolean;
  formFields: Array<{
    label: string;
    controlKind: 'text' | 'email' | 'textarea' | 'select' | 'other';
    requiredGuess: boolean;
    optionLabels?: string[];
  }>;
  submitActionLabels: string[];
}

const DISCOVERY_FORM_FIELD_CAP = 12;
const DISCOVERY_SUBMIT_LABEL_CAP = 3;

const discoveryFormFieldSchema = z.object({
  label: z.string(),
  controlKind: z.enum(['text', 'email', 'textarea', 'select', 'other']),
  requiredGuess: z.boolean(),
  optionLabels: z.array(z.string()).optional(),
});

const discoveryPageSummarySchema = z.object({
  url: z.string(),
  title: z.string(),
  summary: z.string(),
  headingSignals: z.array(z.string()),
  primaryActions: z.array(z.string()),
  hasMeaningfulForm: z.boolean(),
  formFields: z.array(discoveryFormFieldSchema),
  submitActionLabels: z.array(z.string()),
});

export type DiscoveryPageSummaryRaw = z.infer<typeof discoveryPageSummarySchema>;

function rawSummaryToPersisted(raw: DiscoveryPageSummaryRaw): DiscoveryPageSummaryPersisted {
  return {
    url: raw.url,
    title: raw.title,
    summary: raw.summary,
    headingSignals: raw.headingSignals ?? [],
    primaryActions: raw.primaryActions ?? [],
    hasMeaningfulForm: Boolean(raw.hasMeaningfulForm),
    formFields: (raw.formFields ?? []).map((f) => ({
      label: f.label,
      controlKind: f.controlKind,
      requiredGuess: Boolean(f.requiredGuess),
      optionLabels: f.optionLabels,
    })),
    submitActionLabels: raw.submitActionLabels ?? [],
  };
}

function appendCrawlSnapshot(
  acc: CrawlPageSnapshot[] | undefined,
  raw: DiscoveryPageSummaryRaw,
  source: string
): void {
  if (!acc) return;
  acc.push({
    url: raw.url || '',
    source,
    extractedAt: new Date().toISOString(),
    raw: rawSummaryToPersisted(raw),
  });
}

/** Exposed for tests and callers that need normalized discovery form metadata. */
export function normalizeFormSketch(raw: DiscoveryPageSummaryRaw): PageFormSketch {
  const formFields = (raw.formFields ?? [])
    .slice(0, DISCOVERY_FORM_FIELD_CAP)
    .map((f) => ({
      label: (f.label || '').trim(),
      controlKind: f.controlKind,
      requiredGuess: Boolean(f.requiredGuess),
      optionLabels: f.optionLabels?.filter((o) => (o || '').trim()).map((o) => o.trim()),
    }))
    .filter((f) => f.label.length > 0);
  const submitActionLabels = (raw.submitActionLabels ?? [])
    .map((s) => (s || '').trim())
    .filter(Boolean)
    .slice(0, DISCOVERY_SUBMIT_LABEL_CAP);
  return {
    hasMeaningfulForm: Boolean(raw.hasMeaningfulForm),
    formFields,
    submitActionLabels,
  };
}

/** Exposed for tests. When true, discovery traces fill-then-submit instead of only click-hops. */
export function shouldRunFormCompletionBranch(
  lastObserved: { requireAuth: boolean; formSketch: PageFormSketch },
  canContinuePastAuthGate: boolean
): boolean {
  if (lastObserved.requireAuth && !canContinuePastAuthGate) return false;
  const s = lastObserved.formSketch;
  if (!s.hasMeaningfulForm || s.submitActionLabels.length === 0 || s.formFields.length === 0) return false;
  if (s.formFields.length >= 2) return true;
  return s.formFields.some((f) => f.requiredGuess);
}

const SELECT_PLACEHOLDER_SKIP = /^(choose|select|--|—|choose a|sélectionner)/i;

function pickSelectOptionValue(optionLabels: string[] | undefined, fieldLabel: string): string {
  const opts = optionLabels?.filter((o) => (o || '').trim()) ?? [];
  for (const o of opts) {
    const t = o.trim();
    if (t && !SELECT_PLACEHOLDER_SKIP.test(t)) return t;
  }
  if (opts[0]) return opts[0].trim();
  return `Option for ${fieldLabel}`;
}

function placeholderForFormField(
  field: PageFormSketch['formFields'][number],
  index: number
): string {
  if (field.controlKind === 'select') {
    return pickSelectOptionValue(field.optionLabels, field.label);
  }
  if (field.controlKind === 'email') return 'discovery-test@example.com';
  if (field.controlKind === 'textarea') {
    return 'Automated discovery test message. Please ignore.';
  }
  const lab = field.label.toLowerCase();
  if (/\b(first|given|prénom|prenom)\b/i.test(lab)) return 'Discovery';
  if (/\b(last|family|surname|nom de famille)\b/i.test(lab)) return 'TestUser';
  if (/\bsubject\b|objet/i.test(lab)) return 'General question';
  if (/\bname\b/i.test(lab) && !/user ?name|username/i.test(lab)) return index % 2 === 0 ? 'Discovery' : 'TestUser';
  return 'TestValue';
}

function buildFormFillActInstruction(
  field: PageFormSketch['formFields'][number],
  value: string
): string {
  const L = field.label.replace(/"/g, "'");
  switch (field.controlKind) {
    case 'select':
      return `Choose "${value}" from the ${L} dropdown or select control.`;
    case 'textarea':
      return `Type "${value}" into the ${L} multi-line message or text area field.`;
    case 'email':
      return `Type "${value}" into the ${L} email field.`;
    default:
      return `Type "${value}" into the ${L} field.`;
  }
}

function pickSubmitClickInstruction(submitLabels: string[]): string {
  const ranked = [...submitLabels].sort((a, b) => {
    const pa = /\b(send|submit|envoyer|valider|continuer)\b/i.test(a) ? 0 : 1;
    const pb = /\b(send|submit|envoyer|valider|continuer)\b/i.test(b) ? 0 : 1;
    return pa - pb;
  });
  const label = (ranked[0] || submitLabels[0] || 'Submit').replace(/"/g, "'");
  return `Click the ${label} button.`;
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

function shortNormalizedList(xs: string[] | undefined, cap: number): string[] {
  return normalizeList(xs).slice(0, cap);
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

export function buildDiscoveryStateFingerprint(state: DiscoveryObservedState, baseOrigin?: string): string {
  const normalizedUrl = normalizeUrlForDiscovery(state.url || '', baseOrigin);
  const normalizedTitle = (state.title || '').trim().toLowerCase();
  const headingKey = shortNormalizedList(state.headingSignals, 4).join('|');
  const actionKey = shortNormalizedList(state.primaryActions, 5).join('|');
  const formKey = state.hasMeaningfulForm ? 'form:1' : 'form:0';
  const authKey = state.requireAuth ? 'auth:1' : 'auth:0';
  return [normalizedUrl, normalizedTitle, headingKey, actionKey, formKey, authKey].join('::');
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

export function buildIntentSignature(intent: { label: string; actionInstruction: string; sourceSection: string }): string {
  const label = (intent.label || '').trim().toLowerCase();
  const action = (intent.actionInstruction || '').trim().toLowerCase();
  const section = (intent.sourceSection || '').trim().toLowerCase();
  return [label, action, section].join('::');
}

function buildIntentOutcomeDedupKey(intent: { label: string; actionInstruction: string; sourceSection: string }, outcomeFingerprint: string): string {
  return `${buildIntentSignature(intent)}##${outcomeFingerprint || 'unknown'}`;
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
  ) || /(thank you|thanks|sent|message sent|success|confirmation|well received|reçu)/i.test(hay) ||
    /(sign[\s-]?in|log[\s-]?in|sign[\s-]?up|create account|register|auth|connexion|inscription|se connecter|créer mon compte|me connecter|recevoir un lien de connexion)/i.test(
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

function hasAuthIntent(intentLabel: string): boolean {
  return /(sign[\s-]?in|log[\s-]?in|sign[\s-]?up|create account|register|auth|connexion|inscription|se connecter|compte)/i.test(
    intentLabel || ''
  );
}

export function evaluateJourneyDepth(input: {
  strictness: DiscoveryStrictness;
  baseUrl: string;
  firstHopUrl: string;
  finalUrl: string;
  baseFingerprint?: string;
  firstHopFingerprint?: string;
  finalFingerprint?: string;
  hopTraces: Array<{ actionInstruction: string }>;
  finalObserved: { title: string; summary: string; headingSignals: string[]; primaryActions: string[]; requireAuth?: boolean };
  intentLabel: string;
  stallReason?: string;
  intentDrift?: { detected: boolean; reason: string };
}): JourneyDepthSignals {
  const baseNorm = normalizeUrlForDiscovery(input.baseUrl);
  const firstNorm = normalizeUrlForDiscovery(input.firstHopUrl, new URL(input.baseUrl).origin);
  const finalNorm = normalizeUrlForDiscovery(input.finalUrl, new URL(input.baseUrl).origin);
  const meaningfulActCount = input.hopTraces.length;
  const hopCount = input.hopTraces.length;
  const fingerprintChanged = Boolean(
    input.firstHopFingerprint &&
      input.finalFingerprint &&
      input.firstHopFingerprint !== input.finalFingerprint
  );
  const stateChanged = Boolean((firstNorm && finalNorm && firstNorm !== finalNorm) || fingerprintChanged);
  const samePageByUrl = Boolean(finalNorm && baseNorm && finalNorm === baseNorm);
  const sameFingerprintAsBase = Boolean(
    input.baseFingerprint && input.finalFingerprint && input.baseFingerprint === input.finalFingerprint
  );
  const samePageLoop = samePageByUrl && sameFingerprintAsBase;
  const hasOutcomeEvidence = hasOutcomeEvidenceFromObserved(input.finalObserved);
  const hasIntentEvidence = hasIntentArtifacts(input.intentLabel, input.finalObserved);
  const authIntent = hasAuthIntent(input.intentLabel);
  const authDestination = Boolean(input.finalObserved.requireAuth) || isLikelyAuthDestination(input.finalUrl, input.finalObserved.title, input.finalObserved.summary);
  const authIntentReached = authIntent && authDestination;
  const hasIntentSignal = hasOutcomeEvidence || hasIntentEvidence;

  let score = 0;
  if (stateChanged) score += 40;
  score += Math.min(30, meaningfulActCount * 10);
  if (hasOutcomeEvidence) score += 20;
  if (hasIntentEvidence) score += 10;
  if (authIntentReached) score += 15;
  if (samePageLoop) score -= authIntentReached ? 10 : 30;
  if (input.stallReason) score -= 20;
  if (input.intentDrift?.detected) score -= 15;
  score = Math.max(0, Math.min(100, score));

  const minScore = input.strictness === 'lenient' ? 20 : input.strictness === 'strict' ? 55 : 35;
  const needsStateOrEvidence = input.strictness !== 'lenient';
  const weakReason =
    input.stallReason ||
    (input.intentDrift?.detected ? input.intentDrift.reason : undefined) ||
    (samePageLoop && !hasIntentSignal ? 'stalled: journey looped back to start with no outcome evidence' : undefined) ||
    (needsStateOrEvidence && !stateChanged && !hasIntentSignal && !authIntentReached ? 'stalled: no state change or outcome evidence' : undefined) ||
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
    extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<DiscoveryPageSummaryRaw>;
    url: () => string;
  }
): Promise<DiscoveryPageSummaryRaw> {
  const raw = await page.extract({
    instruction: `Summarize this current page for scenario discovery.
- url: if unsure, return an empty string (the system will read the real browser URL).
- Return a concise title or primary heading.
- Return a short summary (1-2 sentences).
- Return up to 5 visible heading signals.
- Return up to 6 concrete primary clickable actions.
- Form sketch (same extract):
  - hasMeaningfulForm: true only if there is a visible multi-control data-entry form (inputs, textareas, selects) users fill before a submit/send control. Single-email newsletter-only forms may count as meaningful.
  - formFields: up to ${DISCOVERY_FORM_FIELD_CAP} fields in visible tab/document order; each label from visible label text or placeholder; controlKind: text | email | textarea | select | other; requiredGuess if the UI marks required or implies it; for selects include optionLabels with visible options (omit empty).
  - submitActionLabels: up to ${DISCOVERY_SUBMIT_LABEL_CAP} visible submit/send button labels tied to that form.
  If there is no such form, set hasMeaningfulForm=false, formFields=[], submitActionLabels=[].
Keep output factual and grounded in visible page content only. Do not invent fields.`,
    schema: discoveryPageSummarySchema,
    iframes: true,
  });
  try {
    const actual = page.url();
    const u = new URL(actual);
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      raw.url = u.href;
    }
  } catch {
    // ignore URL parse errors; keep model-provided raw.url
  }
  return raw;
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

Navigation vs forms: For intents that open a separate destination with a data form (Contact, Help, Support, Newsletter signup, Apply, Register when it navigates to a form page), actionInstruction MUST be the navigation click (nav link, hero/footer link) that REACHES that page — NOT the form submit/send button on the destination. Only use a submit instruction when the starting page is already the form and there is no navigation step.
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
  authProfileId?: string | null,
  crawlPageSnapshots?: CrawlPageSnapshot[]
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
  let baseStateFingerprint = '';
  let lastObserved: {
    url: string;
    title: string;
    summary: string;
    pageClass: string;
    requireAuth: boolean;
    headingSignals: string[];
    primaryActions: string[];
    formSketch: PageFormSketch;
    stateFingerprint: string;
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
    let observed: DiscoveryPageSummaryRaw;
    try {
      observed = await summarizeCurrentPage(
        page as unknown as {
          extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<DiscoveryPageSummaryRaw>;
          url: () => string;
        }
      );
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

    appendCrawlSnapshot(
      crawlPageSnapshots,
      observed,
      `intent:${intent.label}:hop_${hopTraces.length}`
    );

    const formSketch = normalizeFormSketch(observed);
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
        formSketch,
        stateFingerprint: buildDiscoveryStateFingerprint(
          {
            url: observed.url || normUrl || '',
            title: observed.title || 'Untitled',
            summary: observed.summary || '',
            headingSignals: observed.headingSignals || [],
            primaryActions: observed.primaryActions || [],
            hasMeaningfulForm: formSketch.hasMeaningfulForm,
            requireAuth: false,
          },
          baseOrigin
        ),
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
      formSketch,
      stateFingerprint: buildDiscoveryStateFingerprint(
        {
          url: observed.url || normUrl,
          title: observed.title || 'Untitled',
          summary: observed.summary || '',
          headingSignals: observed.headingSignals || [],
          primaryActions: observed.primaryActions || [],
          hasMeaningfulForm: formSketch.hasMeaningfulForm,
          requireAuth,
        },
        baseOrigin
      ),
    };
  };

  const isTerminalOutcome = (outcome: { pageClass: string; requireAuth: boolean; url: string }) => {
    const normUrl = normalizeUrlForDiscovery(outcome.url || '', baseOrigin);
    if (!normUrl || !sameSite(normUrl, baseUrl)) return true;
    if (outcome.requireAuth && !canContinuePastAuthGate) return true;
    return false;
  };

  // First hop: perform the CTA act we were given.
  baseStateFingerprint = buildDiscoveryStateFingerprint(
    {
      url: baseUrl,
      title: 'Home',
      summary: '',
      headingSignals: [],
      primaryActions: [],
      hasMeaningfulForm: false,
      requireAuth: false,
    },
    baseOrigin
  );
  steps.push({ instruction: intent.actionInstruction, type: 'act' });
  journeyActCount++;
  usedActionKeys.add((intent.actionInstruction || '').toLowerCase().trim());
  await page.act({ action: intent.actionInstruction, iframes: true });
  await new Promise((r) => setTimeout(r, DISCOVERY_JOURNEY_SETTLE_MS));

  lastObserved = await doSummarize();
  const firstStateFingerprint = lastObserved.stateFingerprint;
  if (firstStateFingerprint) visitedOutcomeKeys.add(firstStateFingerprint);
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

  let skipJourneyClickLoop = false;
  if (!isTerminalOutcome(lastObserved) && shouldRunFormCompletionBranch(lastObserved, canContinuePastAuthGate)) {
    skipJourneyClickLoop = true;
    const sketch = lastObserved.formSketch;
    const formActInstructions: string[] = [];
    sketch.formFields.forEach((field, index) => {
      const value = placeholderForFormField(field, index);
      formActInstructions.push(buildFormFillActInstruction(field, value));
    });
    formActInstructions.push(pickSubmitClickInstruction(sketch.submitActionLabels));

    for (const instruction of formActInstructions) {
      steps.push({ instruction, type: 'act' });
      journeyActCount++;
      usedActionKeys.add(instruction.toLowerCase().trim());
      await page.act({ action: instruction, iframes: true });
      await new Promise((r) => setTimeout(r, DISCOVERY_JOURNEY_SETTLE_MS));
      lastObserved = await doSummarize();
      hopTraces.push({
        actionInstruction: instruction,
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
  }

  // Continue until terminal outcome or step budget.
  while (!skipJourneyClickLoop && journeyActCount < 1 + DISCOVERY_JOURNEY_MAX_HOPS) {
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
    const nextFingerprint = nextObserved.stateFingerprint;
    if (nextFingerprint && visitedOutcomeKeys.has(nextFingerprint)) {
      // Loop guard: we've come back to a previously visited URL, stop the journey.
      break;
    }
    if (nextFingerprint) visitedOutcomeKeys.add(nextFingerprint);
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

  const visitedKey = `${lastObserved.stateFingerprint || normalizeUrlForDiscovery(lastObserved.url || '', baseOrigin)}`;
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
    baseFingerprint: baseStateFingerprint,
    firstHopFingerprint: firstStateFingerprint,
    finalFingerprint: lastObserved.stateFingerprint,
    hopTraces,
    finalObserved: {
      title: lastObserved.title,
      summary: lastObserved.summary,
      headingSignals: lastObserved.headingSignals,
      primaryActions: lastObserved.primaryActions,
      requireAuth: lastObserved.requireAuth,
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
  candidateIntents: Array<{ label: string; actionInstruction: string; priority: number; sourceSection: string }>;
  tracedIntents: Array<{ label: string; actionInstruction: string; priority: number; sourceSection: string }>;
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
  sections.push(`CANDIDATE INTENTS (EXTRACTED)`);
  sections.push(
    input.candidateIntents.length
      ? input.candidateIntents
          .map(
            (it, i) =>
              `${i + 1}. label: ${it.label}\n   actionInstruction: ${it.actionInstruction}\n   priority: ${it.priority}\n   sourceSection: ${it.sourceSection}`
          )
          .join('\n')
      : '- none'
  );
  sections.push('');
  sections.push(`TRACED INTENTS (TOP TARGET SLICE)`);
  sections.push(
    input.tracedIntents.length
      ? input.tracedIntents
          .map(
            (it, i) =>
              `${i + 1}. label: ${it.label}\n   actionInstruction: ${it.actionInstruction}\n   priority: ${it.priority}\n   sourceSection: ${it.sourceSection}`
          )
          .join('\n')
      : '- none'
  );
  sections.push('');
  sections.push(`UNTRACED CANDIDATES`);
  const tracedKeys = new Set(input.tracedIntents.map((it) => `${it.label}::${it.actionInstruction}`));
  const untraced = input.candidateIntents.filter((it) => !tracedKeys.has(`${it.label}::${it.actionInstruction}`));
  sections.push(
    untraced.length
      ? untraced
          .map(
            (it, i) =>
              `${i + 1}. label: ${it.label}\n   actionInstruction: ${it.actionInstruction}\n   priority: ${it.priority}\n   sourceSection: ${it.sourceSection}\n   reason: outside targetScenarioCount slice`
          )
          .join('\n')
      : '- none'
  );
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

/**
 * Open the URL once and extract title, main headline, and short summary for the welcome “confirm site” step.
 * Does not run scenario discovery or content analysis.
 */
export async function previewSite(
  siteUrl: string,
  options?: { headless?: boolean; authProfileId?: string; owner?: Owner }
): Promise<SitePreviewResult> {
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
    const pwPage = page as unknown as {
      extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<unknown>;
      evaluate: <T>(pageFunction: () => T | Promise<T>) => Promise<T>;
      url: () => string;
    };
    const raw = await summarizeCurrentPage(pwPage as unknown as {
      extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<DiscoveryPageSummaryRaw>;
      url: () => string;
    });
    const resolvedUrl = raw.url || siteUrl;
    const title = raw.title || '';
    const mainHeadline =
      raw.headingSignals && raw.headingSignals.length > 0 && String(raw.headingSignals[0]).trim()
        ? String(raw.headingSignals[0]).trim()
        : title;
    const personaInfer = await inferLikelyTargetPersonaAi(pwPage);
    const likelyTechnologyStack = await inferLikelyTechnologyStack(pwPage);
    return {
      siteUrl,
      resolvedUrl,
      title,
      mainHeadline,
      summary: raw.summary || '',
      requireAuth: isLikelyAuthDestination(resolvedUrl, title, raw.summary || ''),
      likelyTargetPersona: personaInfer.persona,
      likelyTargetPersonaSource: personaInfer.source,
      likelyTargetPersonaValidated: false,
      likelyTargetPersonaConfidence: personaInfer.confidence,
      likelyTechnologyStack,
    };
  } finally {
    await stagehand.close();
  }
}

async function inferLikelyTargetPersonaAi(page: {
  extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<unknown>;
}): Promise<{ persona: string; source: 'auto'; confidence?: number }> {
  const fallback = 'Could not confidently infer a specific persona from the homepage';
  try {
    const inferred = (await page.extract({
      instruction:
        `Considering only what is visible on this homepage (wording, positioning, calls-to-action, feature framing, tone), ` +
        `infer the SINGLE most likely primary target persona the site is written for. ` +
        `Be specific: role + context + intent. ` +
        `Return a short label plus 1 sentence describing their goal (prefer the page language when possible). ` +
        `Avoid "everyone" unless the page is truly broad/ambiguous. ` +
        `Return confidence 0-1.`,
      schema: z.object({
        persona: z.string(),
        confidence: z.number(),
      }),
      iframes: true,
    })) as { persona: string; confidence: number };
    const persona = (inferred.persona || '').trim();
    const conf =
      typeof inferred.confidence === 'number' && inferred.confidence >= 0 && inferred.confidence <= 1
        ? inferred.confidence
        : undefined;
    return { persona: persona || fallback, source: 'auto', confidence: conf };
  } catch {
    return { persona: fallback, source: 'auto', confidence: undefined };
  }
}

async function inferLikelyTechnologyStack(page: {
  url: () => string;
  evaluate: <T>(pageFunction: () => T | Promise<T>) => Promise<T>;
}): Promise<string> {
  let signals: string[] = [];
  try {
    signals = await page.evaluate(() => {
      const found: string[] = [];
      const html = document.documentElement ? document.documentElement.innerHTML : '';
      const scripts = Array.from(document.querySelectorAll('script[src]'))
        .map((s) => (s.getAttribute('src') || '').toLowerCase())
        .join('\n');
      const metas = Array.from(document.querySelectorAll('meta[name],meta[property]')).map((m) => ({
        name: (m.getAttribute('name') || '').toLowerCase(),
        property: (m.getAttribute('property') || '').toLowerCase(),
        content: (m.getAttribute('content') || '').toLowerCase(),
      }));

      const push = (name: string) => {
        if (!found.includes(name)) found.push(name);
      };

      if ((window as any).__NEXT_DATA__ || /_next\//i.test(scripts)) push('nextjs');
      if (/wp-content|wp-includes/i.test(html) || metas.some((m) => m.name === 'generator' && /wordpress/i.test(m.content))) push('wordpress');
      if (/cdn\.shopify\.com|shopify/i.test(html) || metas.some((m) => m.name === 'shopify-checkout-api-token')) push('shopify');
      if (/wixstatic\.com|_wix/i.test(html)) push('wix');
      if (/squarespace/i.test(html) || scripts.includes('static.squarespace.com')) push('squarespace');
      if (/webflow/i.test(html) || scripts.includes('webflow')) push('webflow');
      if ((window as any).React || /react/i.test(scripts)) push('react');
      if ((window as any).Vue || /vue/i.test(scripts)) push('vue');
      if ((window as any).angular || /angular/i.test(scripts)) push('angular');
      if (/cdn\.jsdelivr\.net\/npm\/tailwindcss|tailwind/i.test(html)) push('tailwind');
      return found;
    });
  } catch {
    // Best-effort only.
  }

  if (signals.includes('shopify')) return 'Shopify storefront';
  if (signals.includes('wordpress')) return 'WordPress CMS';
  if (signals.includes('wix')) return 'Wix site builder';
  if (signals.includes('squarespace')) return 'Squarespace site builder';
  if (signals.includes('webflow')) return 'Webflow site builder';
  if (signals.includes('nextjs')) return 'Next.js + React';
  if (signals.includes('react')) return 'React-based frontend';
  if (signals.includes('vue')) return 'Vue-based frontend';
  if (signals.includes('angular')) return 'Angular-based frontend';

  try {
    const host = new URL(page.url()).hostname.toLowerCase();
    if (host.endsWith('myshopify.com')) return 'Shopify storefront';
  } catch {
    // Ignore parse issues.
  }
  return 'No clear framework detected (likely custom stack)';
}

const CONTENT_CHECK_MAX_MS = 90_000;
const CONTENT_CHECK_DEFAULT_EXTRA_PAGES = 3;
const CONTENT_CHECK_MAX_EXTRA_PAGES_CAP = 8;

const DEFAULT_CONTENT_PERSONA =
  'A general web visitor evaluating whether the site is clear, trustworthy, and easy to act on.';

function isLikelyAuthPathOnly(urlStr: string): boolean {
  try {
    const p = new URL(urlStr).pathname.toLowerCase();
    return /(^|\/)(sign[_-]?in|log[_-]?in|sign[_-]?up|register|login|signup|auth)(\/|$)/i.test(p);
  } catch {
    return false;
  }
}

function clampScore100(n: number): number {
  if (Number.isNaN(n)) return 50;
  return Math.round(Math.max(0, Math.min(100, n)));
}

function truncateForPrompt(s: string, maxLen: number): string {
  const t = (s || '').trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen - 3)}...`;
}

function contentPageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    let p = u.pathname;
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    const h = u.hostname.replace(/^www\./i, '').toLowerCase();
    return `${u.protocol}//${h}${p}${u.search}`;
  } catch {
    return url;
  }
}

const contentCheckPageJudgmentSchema = z.object({
  url: z.string(),
  title: z.string(),
  fit: z.number(),
  clarity: z.number(),
  trust: z.number(),
  friction: z.number(),
  strengths: z.array(z.string()),
  risks: z.array(z.string()),
  recommendations: z.array(z.string()),
  evidenceSnippets: z.array(
    z.object({
      quote: z.string(),
      note: z.string().optional(),
    })
  ),
});

const contentCheckJudgmentExtractSchema = z.object({
  siteSummary: z.string().optional(),
  pages: z.array(contentCheckPageJudgmentSchema),
});

async function collectSameOriginLinks(
  page: { evaluate: (fn: (origin: string) => unknown, arg: string) => Promise<unknown> },
  pageOrigin: string
): Promise<Array<{ url: string; fromNav: boolean }>> {
  const result = await page.evaluate((origin: string) => {
    const sel = 'header a[href], nav a[href], [role="navigation"] a[href], main a[href]';
    const nodes = document.querySelectorAll(sel);
    const rows: { url: string; fromNav: boolean }[] = [];
    const seen = new Set<string>();
    const base = new URL(origin);
    const baseHost = base.hostname.replace(/^www\./i, '').toLowerCase();
    for (const a of Array.from(nodes)) {
      const el = a as Element;
      const href = el.getAttribute('href');
      if (!href || href.startsWith('#') || href.toLowerCase().startsWith('javascript:')) continue;
      try {
        const u = new URL(href, origin);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
        const h = u.hostname.replace(/^www\./i, '').toLowerCase();
        if (h !== baseHost) continue;
        u.hash = '';
        const path = u.pathname.toLowerCase();
        if (/\.(pdf|zip|jpe?g|png|gif|svg|ico|webp|woff2?|mp4)(\?|$)/i.test(path)) continue;
        const key = u.href;
        if (seen.has(key)) continue;
        seen.add(key);
        const fromNav = !!el.closest('nav,[role="navigation"],header');
        rows.push({ url: u.href, fromNav });
      } catch {
        /* skip */
      }
    }
    return rows;
  }, pageOrigin);
  return result as Array<{ url: string; fromNav: boolean }>;
}

/**
 * Persona-oriented copy/UX review: homepage + capped same-origin pages, then one structured judgment pass.
 * Advisory only; does not affect scenario discovery.
 */
export async function runContentCheck(
  siteUrl: string,
  options?: {
    headless?: boolean;
    authProfileId?: string;
    owner?: Owner;
    persona?: string;
    inferPersona?: boolean;
    maxExtraPages?: number;
    requestId?: string;
    traceId?: string;
  }
): Promise<ContentCheckResult> {
  const deadline = Date.now() + CONTENT_CHECK_MAX_MS;
  const withinBudget = () => Date.now() < deadline;

  const headless = options?.headless ?? true;
  let authPayload: AuthProfilePayload | undefined;
  if (options?.authProfileId) {
    if (!options?.owner) throw new Error('owner required when using auth profile');
    const withPayload = await getAuthProfileRepository().getByIdWithPayload(options.authProfileId, options.owner);
    if (!withPayload) throw new Error('Auth profile not found: ' + options.authProfileId);
    authPayload = withPayload.payload;
  }

  const maxExtra = Math.min(
    CONTENT_CHECK_MAX_EXTRA_PAGES_CAP,
    Math.max(0, options?.maxExtraPages ?? CONTENT_CHECK_DEFAULT_EXTRA_PAGES)
  );

  const stagehand = new Stagehand({
    env: 'LOCAL',
    verbose: 1,
    localBrowserLaunchOptions: buildLaunchOptions(headless, authPayload) as LocalBrowserLaunchOptions,
  });
  await stagehand.init();
  const page = stagehand.page;

  const crawlErrors: string[] = [];
  type Snap = { url: string; summary: DiscoveryPageSummaryRaw; requireAuth: boolean };
  const snapshots: Snap[] = [];

  const pwPage = page as unknown as {
    extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<unknown>;
    goto: (url: string, opts?: { waitUntil?: 'domcontentloaded'; timeout?: number }) => Promise<unknown>;
    evaluate: (fn: (origin: string) => unknown, arg: string) => Promise<unknown>;
    url: () => string;
  };
  const summarizeHost = pwPage as unknown as Parameters<typeof summarizeCurrentPage>[0];

  try {
    await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let homeRaw = await summarizeCurrentPage(summarizeHost);
    const resolvedHomeUrl = homeRaw.url || siteUrl;
    const baseOrigin = new URL(resolvedHomeUrl).origin;
    const homeKey = contentPageKey(resolvedHomeUrl);

    snapshots.push({
      url: resolvedHomeUrl,
      summary: homeRaw,
      requireAuth: isLikelyAuthDestination(resolvedHomeUrl, homeRaw.title || '', homeRaw.summary || ''),
    });

    let personaUsed: ContentCheckResult['personaUsed'];
    const personaTrim = (options?.persona || '').trim();

    if (personaTrim) {
      personaUsed = { text: personaTrim, source: 'user', confidence: 1 };
    } else if (options?.inferPersona) {
      try {
        const inferred = (await pwPage.extract({
          instruction: `From this page's visible positioning only, infer ONE short primary user persona (role + goal in one or two sentences) who this homepage most clearly targets. If unclear, say so. Return confidence 0-1.`,
          schema: z.object({
            personaDescription: z.string(),
            confidence: z.number(),
          }),
          iframes: true,
        })) as { personaDescription: string; confidence: number };
        const text = (inferred.personaDescription || '').trim() || DEFAULT_CONTENT_PERSONA;
        const conf =
          typeof inferred.confidence === 'number' && inferred.confidence >= 0 && inferred.confidence <= 1
            ? inferred.confidence
            : 0.5;
        personaUsed = { text, source: 'inferred', confidence: conf };
      } catch (err) {
        crawlErrors.push(`persona_infer_failed: ${err instanceof Error ? err.message : String(err)}`);
        personaUsed = { text: DEFAULT_CONTENT_PERSONA, source: 'inferred', confidence: 0.35 };
      }
    } else {
      // No user text and inference off: neutral default (explicit low confidence).
      personaUsed = { text: DEFAULT_CONTENT_PERSONA, source: 'inferred', confidence: 0.35 };
    }

    if (withinBudget() && maxExtra > 0) {
      let candidates: Array<{ url: string; fromNav: boolean }> = [];
      try {
        candidates = await collectSameOriginLinks(pwPage, baseOrigin);
      } catch (err) {
        crawlErrors.push(`link_collect_failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      candidates.sort((a, b) => (a.fromNav === b.fromNav ? 0 : a.fromNav ? -1 : 1));

      const seenKeys = new Set<string>([homeKey]);
      const toVisit: string[] = [];
      for (const c of candidates) {
        if (toVisit.length >= maxExtra) break;
        const k = contentPageKey(c.url);
        if (seenKeys.has(k)) continue;
        if (isLikelyAuthPathOnly(c.url)) continue;
        seenKeys.add(k);
        toVisit.push(c.url);
      }

      for (const u of toVisit) {
        if (!withinBudget()) {
          crawlErrors.push('time_budget: skipped remaining extra pages');
          break;
        }
        try {
          await page.goto(u, { waitUntil: 'domcontentloaded', timeout: 30000 });
          const raw = await summarizeCurrentPage(summarizeHost);
          const finalUrl = raw.url || u;
          snapshots.push({
            url: finalUrl,
            summary: raw,
            requireAuth: isLikelyAuthDestination(finalUrl, raw.title || '', raw.summary || ''),
          });
        } catch (err) {
          crawlErrors.push(`nav_fail ${u}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    if (!withinBudget()) {
      crawlErrors.push('time_budget: judgment may be partial');
    }

    await page.goto(resolvedHomeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const packLines: string[] = [];
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      const r = s.summary;
      packLines.push(`--- PAGE ${i + 1} ---`);
      packLines.push(`url: ${s.url}`);
      packLines.push(`title: ${truncateForPrompt(r.title || '', 200)}`);
      packLines.push(`summary: ${truncateForPrompt(r.summary || '', 900)}`);
      packLines.push(`headings: ${(r.headingSignals || []).slice(0, 5).join(' | ')}`);
      packLines.push(`primaryActions: ${(r.primaryActions || []).slice(0, 6).join(' | ')}`);
      packLines.push(`likelyAuthHeuristic: ${s.requireAuth ? 'yes' : 'no'}`);
    }
    const pack = packLines.join('\n');

    const judgeInstruction = `You are reviewing website copy and UX for an ADVISORY persona fit report (not pass/fail QA).

Persona:
${personaUsed.text}

Crawled page facts (only use these; do not invent pages or quotes):
${pack}

Return JSON matching the schema:
- siteSummary: optional 2-4 sentences across all pages for this persona.
- pages: one object per PAGE in order above, with the EXACT same url string as in the crawl.
For each page: title, fit/clarity/trust/friction as integers 0-100 (friction = higher means harder/confusing for the persona), strengths/risks/recommendations as short bullet strings, evidenceSnippets with quote text copied or tightly paraphrased ONLY from the summaries/headings/actions above (each quote must be attributable to that page's block).`;

    const judged = (await pwPage.extract({
      instruction: judgeInstruction,
      schema: contentCheckJudgmentExtractSchema,
      iframes: true,
    })) as z.infer<typeof contentCheckJudgmentExtractSchema>;

    const pagesOut: ContentCheckResult['pages'] = (judged.pages || []).map((p) => ({
      url: p.url,
      title: p.title,
      fit: clampScore100(p.fit),
      clarity: clampScore100(p.clarity),
      trust: clampScore100(p.trust),
      friction: clampScore100(p.friction),
      strengths: (p.strengths || []).map((s) => String(s).trim()).filter(Boolean),
      risks: (p.risks || []).map((s) => String(s).trim()).filter(Boolean),
      recommendations: (p.recommendations || []).map((s) => String(s).trim()).filter(Boolean),
      evidenceSnippets: (p.evidenceSnippets || []).map((e) => ({
        quote: String(e.quote || '').trim(),
        note: e.note ? String(e.note).trim() : undefined,
      })),
    }));

    return {
      siteUrl,
      resolvedHomeUrl,
      personaUsed,
      siteSummary: judged.siteSummary?.trim() || undefined,
      pages: pagesOut,
      crawlErrors: crawlErrors.length ? crawlErrors : undefined,
    };
  } finally {
    await stagehand.close();
  }
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
    const seenIntentOutcomeKeys = new Set<string>();
    const crawlStart = Date.now();
    const crawlPageSnapshots: CrawlPageSnapshot[] = [];

    const home = await summarizeCurrentPage(page as unknown as {
      extract: (input: { instruction: string; schema: z.ZodTypeAny; iframes?: boolean }) => Promise<DiscoveryPageSummaryRaw>;
      url: () => string;
    });
    appendCrawlSnapshot(crawlPageSnapshots, home, 'home');
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
          options?.authProfileId,
          crawlPageSnapshots
        );

        const outcomeKey = trace.visitedOutcomeKey;
        const dedupeKey = buildIntentOutcomeDedupKey(intent, outcomeKey);
        if (!outcomeKey || seenIntentOutcomeKeys.has(dedupeKey)) {
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
        seenIntentOutcomeKeys.add(dedupeKey);

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
      candidateIntents: intents ?? [],
      tracedIntents: selectedIntents ?? [],
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
      crawlPageSnapshots,
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
