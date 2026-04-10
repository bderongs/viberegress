/**
 * Tests for page-story. Run with: npx tsx src/services/page-story.test.ts
 */

import assert from 'assert';
import {
  PageStorySchema,
  formatPageStoryForPrompt,
  narrativeBlockForPrompt,
  STORY_FALLBACK_RULES,
} from './page-story.js';

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}`);
    throw e;
  }
}

console.log('page-story tests');

run('PageStorySchema rejects empty object', () => {
  const r = PageStorySchema.safeParse({});
  assert.ok(!r.success);
});

run('PageStorySchema accepts minimal valid story', () => {
  const r = PageStorySchema.safeParse({
    primaryIntent: 'Help consultants sell sessions',
    heroHeading: 'Monétisez votre expertise',
    primaryCtaLabel: 'Créer ma boutique gratuite',
    secondaryVisibleActions: ['Voir un exemple'],
    lowPriorityOrDemoSections: ['Mock Stripe checkout demo'],
  });
  assert.ok(r.success);
  if (r.success) {
    assert.strictEqual(r.data.heroHeading, 'Monétisez votre expertise');
    assert.deepStrictEqual(r.data.secondaryVisibleActions, ['Voir un exemple']);
  }
});

run('formatPageStoryForPrompt includes hero and demo warning', () => {
  const text = formatPageStoryForPrompt({
    primaryIntent: 'Sell consulting',
    heroHeading: 'Title',
    primaryCtaLabel: 'Start',
    secondaryVisibleActions: [],
    lowPriorityOrDemoSections: ['Fake payment form'],
  });
  assert.ok(text.includes('Title'));
  assert.ok(text.includes('Start'));
  assert.ok(text.includes('Fake payment form'));
  assert.ok(text.includes('do NOT add steps'));
});

run('narrativeBlockForPrompt uses fallback when null', () => {
  const b = narrativeBlockForPrompt(null);
  assert.strictEqual(b, STORY_FALLBACK_RULES);
});

run('narrativeBlockForPrompt uses format when story present', () => {
  const story = {
    primaryIntent: 'x',
    heroHeading: 'H',
    primaryCtaLabel: 'Go',
    secondaryVisibleActions: [] as string[],
    lowPriorityOrDemoSections: [] as string[],
  };
  const b = narrativeBlockForPrompt(story);
  assert.ok(b.includes('H'));
  assert.ok(b.includes('Go'));
});

console.log('all page-story tests passed');
