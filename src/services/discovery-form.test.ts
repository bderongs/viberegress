/**
 * Tests for discovery form sketch normalization and form-completion trigger.
 * Run with: npx tsx src/services/discovery-form.test.ts
 */
import assert from 'assert';
import { normalizeFormSketch, shouldRunFormCompletionBranch, type DiscoveryPageSummaryRaw } from './stagehand.js';

function baseRaw(over: Partial<DiscoveryPageSummaryRaw> = {}): DiscoveryPageSummaryRaw {
  return {
    url: 'https://example.com/contact',
    title: 'Contact',
    summary: 'Form page',
    headingSignals: [],
    primaryActions: [],
    hasMeaningfulForm: true,
    formFields: [],
    submitActionLabels: ['Send'],
    ...over,
  };
}

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}`);
    throw e;
  }
}

console.log('discovery-form tests');

run('two fields + submit triggers form branch', () => {
  const sketch = normalizeFormSketch(
    baseRaw({
      formFields: [
        { label: 'First name', controlKind: 'text', requiredGuess: true },
        { label: 'Email', controlKind: 'email', requiredGuess: true },
      ],
    })
  );
  assert.strictEqual(sketch.formFields.length, 2);
  assert.ok(
    shouldRunFormCompletionBranch({ requireAuth: false, formSketch: sketch }, true)
  );
});

run('single required field + submit triggers', () => {
  const sketch = normalizeFormSketch(
    baseRaw({
      formFields: [{ label: 'Email', controlKind: 'email', requiredGuess: true }],
    })
  );
  assert.ok(
    shouldRunFormCompletionBranch({ requireAuth: false, formSketch: sketch }, true)
  );
});

run('single optional field only does not trigger', () => {
  const sketch = normalizeFormSketch(
    baseRaw({
      formFields: [{ label: 'Subject', controlKind: 'text', requiredGuess: false }],
    })
  );
  assert.ok(
    !shouldRunFormCompletionBranch({ requireAuth: false, formSketch: sketch }, true)
  );
});

run('no submit labels does not trigger', () => {
  const sketch = normalizeFormSketch(
    baseRaw({
      formFields: [
        { label: 'A', controlKind: 'text', requiredGuess: true },
        { label: 'B', controlKind: 'text', requiredGuess: true },
      ],
      submitActionLabels: [],
    })
  );
  assert.ok(
    !shouldRunFormCompletionBranch({ requireAuth: false, formSketch: sketch }, true)
  );
});

run('auth gate without profile skips form branch', () => {
  const sketch = normalizeFormSketch(
    baseRaw({
      formFields: [
        { label: 'A', controlKind: 'text', requiredGuess: true },
        { label: 'B', controlKind: 'text', requiredGuess: true },
      ],
    })
  );
  assert.ok(
    !shouldRunFormCompletionBranch({ requireAuth: true, formSketch: sketch }, false)
  );
});

run('normalize caps fields at 12', () => {
  const fields = Array.from({ length: 20 }, (_, i) => ({
    label: `F${i}`,
    controlKind: 'text' as const,
    requiredGuess: false,
  }));
  const sketch = normalizeFormSketch(baseRaw({ formFields: fields }));
  assert.strictEqual(sketch.formFields.length, 12);
  assert.strictEqual(sketch.formFields[0].label, 'F0');
  assert.strictEqual(sketch.formFields[11].label, 'F11');
});

run('normalize drops whitespace-only labels', () => {
  const sketch = normalizeFormSketch(
    baseRaw({
      formFields: [{ label: '  \t  ', controlKind: 'text', requiredGuess: false }],
    })
  );
  assert.strictEqual(sketch.formFields.length, 0);
});

console.log('All discovery-form tests passed.');
process.exit(0);
