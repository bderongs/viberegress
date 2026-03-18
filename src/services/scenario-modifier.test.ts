/**
 * Tests for scenario-modifier: parseAndValidateModifyResult (invalid AI output rejected,
 * valid output accepted). Run with: npx tsx src/services/scenario-modifier.test.ts
 */

import assert from 'assert';
import { parseAndValidateModifyResult } from './scenario-modifier.js';

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}`);
    throw e;
  }
}

console.log('scenario-modifier tests');

run('invalid schema: non-object rejected', () => {
  assert.throws(
    () => parseAndValidateModifyResult('not an object'),
    /AI returned invalid scenario shape/
  );
});

run('invalid schema: missing name rejected', () => {
  assert.throws(
    () => parseAndValidateModifyResult({ description: 'Desc', steps: ['Click button'] }),
    /AI returned invalid scenario shape/
  );
});

run('invalid schema: steps not array rejected', () => {
  assert.throws(
    () => parseAndValidateModifyResult({ name: 'S', description: 'D', steps: 'oops' }),
    /AI returned invalid scenario shape/
  );
});

run('empty steps rejected', () => {
  assert.throws(
    () => parseAndValidateModifyResult({ name: 'S', description: 'D', steps: [] }),
    /AI returned no steps/
  );
});

run('valid output with concrete input accepted', () => {
  const result = parseAndValidateModifyResult({
    name: 'Search',
    description: 'User searches the site',
    steps: [
      'Click the search box',
      'Type "pricing" in the search box',
      'Verify results are shown',
    ],
  });
  assert.strictEqual(result.name, 'Search');
  assert.strictEqual(result.description, 'User searches the site');
  assert.strictEqual(result.steps.length, 3);
  assert.ok(result.steps[1].instruction.includes('"pricing"'));
});

run('vague input step normalized by validateAndNormalizeSteps', () => {
  const result = parseAndValidateModifyResult({
    name: 'Search',
    description: 'User searches',
    steps: [
      'Click the search box',
      'Type a keyword in the search box',
      'Verify results',
    ],
  });
  assert.strictEqual(result.steps.length, 3);
  const inputStep = result.steps[1].instruction;
  assert.ok(inputStep.includes('"pricing"'), 'vague input should be normalized with default');
});

run('step type inferred: assert', () => {
  const result = parseAndValidateModifyResult({
    name: 'S',
    description: 'D',
    steps: ['Verify the confirmation message is visible'],
  });
  assert.strictEqual(result.steps[0].type, 'assert');
});

run('step type inferred: act', () => {
  const result = parseAndValidateModifyResult({
    name: 'S',
    description: 'D',
    steps: ['Click the Submit button'],
  });
  assert.strictEqual(result.steps[0].type, 'act');
});

console.log('All scenario-modifier tests passed.');
process.exit(0);
