/**
 * Structured "page story" for scenario generation: hero, primary CTA, and low-priority / demo UI zones.
 */

import { z } from 'zod';
import { logger } from '../lib/logger.js';

export const PageStorySchema = z.object({
  primaryIntent: z.string(),
  heroHeading: z.string(),
  heroSupportingText: z.string().optional(),
  primaryCtaLabel: z.string(),
  secondaryVisibleActions: z.array(z.string()),
  lowPriorityOrDemoSections: z.array(z.string()),
  readingOrderNote: z.string().optional(),
});

export type PageStory = z.infer<typeof PageStorySchema>;

/** Minimal rules when PageStory extraction fails or is unavailable (e.g. discovery). */
export const STORY_FALLBACK_RULES = [
  'Narrative coherence (fallback — no structured page story was extracted):',
  '- Prefer the main user journey: primary headline, supporting copy, and the primary call-to-action above the fold.',
  '- Do not interact with decorative or demo UIs (mock checkouts, placeholder forms, marketing illustrations) unless the user explicitly asks to test that block.',
  '- Use assertions on stable visible copy (headings, button labels) that match the page.',
].join('\n');

export const PAGE_STORY_EXTRACT_INSTRUCTION = `Analyze this page and extract a concise "page story" for test scenario design.

Focus on:
1. Above-the-fold content first (what a user sees without scrolling, or the first meaningful viewport).
2. Only include text that is actually visible on the page — do not invent headlines, CTAs, or buttons.
3. primaryIntent: one sentence — who this page is for and what it promises.
4. heroHeading: the main headline or title of the hero / primary section.
5. heroSupportingText: optional short subtext or lead paragraph under the hero if clearly visible.
6. primaryCtaLabel: the exact visible label of the single primary call-to-action (button or link) in the hero area.
7. secondaryVisibleActions: other prominent navigation or secondary actions visible near the top (short labels only).
8. lowPriorityOrDemoSections: sections that look like marketing demos, mock payment forms, carousels of examples, or "illustration" UIs — not the main conversion path. Describe each briefly.
9. readingOrderNote: optional — how the main message should be read (e.g. "hero then primary CTA before long scroll").

If the page has no clear hero (e.g. dense app UI), use the strongest visible page title and primary action as heroHeading and primaryCtaLabel.`;

export interface PageWithExtract {
  extract: (opts: { instruction: string; schema: z.ZodType<unknown> }) => Promise<unknown>;
}

/**
 * Extracts structured page story from the current page. Returns null on failure (caller uses STORY_FALLBACK_RULES).
 */
export async function extractPageStory(page: PageWithExtract): Promise<PageStory | null> {
  try {
    const raw = await page.extract({
      instruction: PAGE_STORY_EXTRACT_INSTRUCTION,
      schema: PageStorySchema,
    });
    const parsed = PageStorySchema.safeParse(raw);
    if (!parsed.success) {
      logger.warn('page_story_extract_invalid_schema', { error: parsed.error.message });
      return null;
    }
    return parsed.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('page_story_extract_failed', { error: msg });
    return null;
  }
}

/**
 * Formatted block for LLM prompts (generation, modification, repair).
 */
export function formatPageStoryForPrompt(story: PageStory): string {
  const lines: string[] = [
    'Detected page narrative (follow this as the primary story — do not drift to demo or decorative blocks unless the user explicitly asks):',
    `- Primary intent: ${story.primaryIntent}`,
    `- Hero heading: ${story.heroHeading}`,
  ];
  if (story.heroSupportingText?.trim()) {
    lines.push(`- Hero supporting text: ${story.heroSupportingText.trim()}`);
  }
  lines.push(`- Primary CTA label: ${story.primaryCtaLabel}`);
  if (story.secondaryVisibleActions.length) {
    lines.push(`- Secondary / visible actions: ${story.secondaryVisibleActions.join('; ')}`);
  }
  if (story.lowPriorityOrDemoSections.length) {
    lines.push(
      `- Low priority or demo sections (do NOT add steps that type into or click through these unless the user request clearly requires it): ${story.lowPriorityOrDemoSections.join('; ')}`
    );
  }
  if (story.readingOrderNote?.trim()) {
    lines.push(`- Reading order: ${story.readingOrderNote.trim()}`);
  }
  lines.push(
    'Scenario steps should align with the primary intent, hero, and primary CTA. Assertions should use exact visible wording from the hero/CTA when verifying this page.'
  );
  return lines.join('\n');
}

/** Returns narrative block for prompts: structured story or fallback rules. */
export function narrativeBlockForPrompt(story: PageStory | null): string {
  return story ? formatPageStoryForPrompt(story) : STORY_FALLBACK_RULES;
}
