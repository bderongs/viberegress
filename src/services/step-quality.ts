/**
 * Input-step quality gate: detect input-like instructions, require concrete values,
 * and normalize vague steps with deterministic defaults so runs never fill("").
 */

/** Minimal context for choosing a default (e.g. search vs email vs message). */
export interface ScenarioContext {
  name?: string;
  description?: string;
}

const INPUT_VERBS =
  /\b(type|enter|fill|write|input|search|put|add)\s+(a|an|the|your|some|any)?\s*(relevant\s+)?(keyword|phrase|text|message|query|email|name|value|word)s?\b/i;
const OBVIOUSLY_VAGUE =
  /\b(type|enter|fill|write|input)\s+(a|an|the|your|some|any|relevant)\b/i;
/** Quoted string: "..." or '...' (non-greedy). */
const QUOTED_VALUE = /["']([^"']*)["']/;
/** Looks like an email (simple). */
const EMAIL_LIKE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

const DEFAULTS = {
  search: 'pricing',
  email: 'test@example.com',
  name: 'Test User',
  message: 'Hello, I need help with pricing.',
} as const;

export function isInputLikeInstruction(instruction: string): boolean {
  const lower = instruction.toLowerCase();
  if (OBVIOUSLY_VAGUE.test(instruction)) return true;
  if (INPUT_VERBS.test(instruction)) return true;
  if (/\b(search|search for)\s+(something|a\s+keyword|a\s+term)\b/i.test(lower)) return true;
  if (/\b(in|into)\s+(the\s+)?(search|email|message|input|text|query)\s*(field|box|input)?\b/i.test(lower)) return true;
  return false;
}

export function hasConcreteInputValue(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed.length) return false;
  const quoted = trimmed.match(QUOTED_VALUE);
  if (quoted && quoted[1].trim().length > 0) return true;
  if (EMAIL_LIKE.test(trimmed)) return true;
  return false;
}

function inferInputKind(instruction: string, context?: ScenarioContext): keyof typeof DEFAULTS {
  const lower = instruction.toLowerCase();
  const nameDesc = `${context?.name ?? ''} ${context?.description ?? ''}`.toLowerCase();
  if (/\bsearch\b/.test(lower) || /\bsearch\b/.test(nameDesc)) return 'search';
  if (/\bemail\b/.test(lower) || /\bemail\b/.test(nameDesc)) return 'email';
  if (/\bname\b/.test(lower) && !/\b(username|domain)\b/.test(lower)) return 'name';
  return 'message';
}

/**
 * If the instruction is input-like but vague, rewrites it with a concrete default.
 * Returns the same string if it already has a concrete value or is not input-like.
 */
export function normalizeInputInstruction(
  instruction: string,
  context?: ScenarioContext
): string {
  const trimmed = instruction.trim();
  if (!isInputLikeInstruction(trimmed)) return instruction;
  if (hasConcreteInputValue(trimmed)) return instruction;

  const kind = inferInputKind(trimmed, context);
  const value = DEFAULTS[kind];

  const lower = trimmed.toLowerCase();
  // "Type a relevant keyword or phrase into the search textbox" -> "Type "pricing" into the search textbox"
  const verbInInto = /^(type|enter|fill|write|input)\s+.*?(\s+in\s+|\s+into\s+)(.*)$/i.exec(trimmed);
  if (verbInInto) {
    const verb = verbInInto[1].charAt(0).toUpperCase() + verbInInto[1].slice(1).toLowerCase();
    return `${verb} "${value}" ${verbInInto[2]}${verbInInto[3]}`.replace(/\s+/g, ' ').trim();
  }
  if (/\bsearch\s+for\b/i.test(lower)) {
    return trimmed.replace(/\bsearch\s+for\s+[^."']*/i, `search for "${value}"`).replace(/\s+/g, ' ').trim();
  }
  return `${trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed} "${value}"`.replace(/\s+/g, ' ').trim();
}

/**
 * Validates and optionally normalizes all steps. If any input-like step lacks a concrete value
 * and cannot be auto-fixed, returns { ok: false, error: { stepIndex, message } }.
 * If all are ok, returns { ok: true } and steps can be replaced with normalized array when present.
 */
export function validateAndNormalizeSteps(
  steps: Array<{ instruction: string; type?: string }>,
  context?: ScenarioContext
): { ok: true; steps: Array<{ instruction: string; type?: string }> } | { ok: false; stepIndex: number; message: string } {
  const result: Array<{ instruction: string; type?: string }> = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const normalized = normalizeInputInstruction(step.instruction, context);
    if (isInputLikeInstruction(normalized) && !hasConcreteInputValue(normalized)) {
      return {
        ok: false,
        stepIndex: i,
        message: `Step ${i + 1} is an input action but has no concrete value to type. Use a quoted string, e.g. Type "pricing" in the search box.`,
      };
    }
    result.push({ ...step, instruction: normalized });
  }
  return { ok: true, steps: result };
}
