/**
 * Focused tests for step-quality: normalization, rejection, and guard behavior.
 * Run with: npx tsx src/services/step-quality.test.ts
 */

import assert from 'assert';
import {
  isInputLikeInstruction,
  hasConcreteInputValue,
  normalizeInputInstruction,
  validateAndNormalizeSteps,
} from './step-quality.js';

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}`);
    throw e;
  }
}

console.log('step-quality tests');

run('non-input steps unchanged', () => {
  const instructions = [
    'Click the Sign Up button',
    'Verify the confirmation message is visible',
    'Locate the search textbox',
  ];
  for (const inst of instructions) {
    assert.strictEqual(normalizeInputInstruction(inst), inst);
  }
});

run('vague input step becomes normalized with concrete value', () => {
  const normalized = normalizeInputInstruction(
    'Type a relevant keyword or phrase into the search textbox'
  );
  assert.ok(normalized.includes('"pricing"'));
  assert.ok(hasConcreteInputValue(normalized));
});

run('Type a keyword in the search box -> includes pricing', () => {
  const normalized = normalizeInputInstruction('Type a keyword in the search box');
  assert.ok(normalized.includes('"pricing"'));
  assert.ok(hasConcreteInputValue(normalized));
});

run('instruction with quoted value is unchanged', () => {
  const inst = 'Type "conformité" in the search field';
  assert.strictEqual(normalizeInputInstruction(inst), inst);
  assert.ok(hasConcreteInputValue(inst));
});

run('multi-field form step normalized (first name + email)', () => {
  const inst =
    'Fill out the test form by typing a first name and an email address, then click on the submit button.';
  assert.strictEqual(isInputLikeInstruction(inst), true);

  const normalized = normalizeInputInstruction(inst);
  assert.ok(normalized.includes('"Test User"'), 'should inject default name');
  assert.ok(normalized.includes('"test@example.com"'), 'should inject default email');
  assert.ok(hasConcreteInputValue(normalized), 'normalized instruction must have concrete input values');
});

run('validateAndNormalizeSteps ok for multi-field form steps', () => {
  const inst =
    'Fill out the test form by typing a first name and an email address, then click on the submit button.';
  const result = validateAndNormalizeSteps(
    [{ instruction: inst, type: 'act' }],
    { name: 'Signup', description: 'User signs up for the test' }
  );
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.ok(result.steps[0].instruction.includes('"Test User"'));
    assert.ok(result.steps[0].instruction.includes('"test@example.com"'));
  }
});

run('FR multi-field form step is detected and normalized', () => {
  const inst =
    'Remplir le formulaire en tapant un prénom et une adresse email, puis cliquer sur le bouton de validation.';
  assert.strictEqual(isInputLikeInstruction(inst), true);
  const normalized = normalizeInputInstruction(inst);
  assert.ok(normalized.includes('"Test User"'));
  assert.ok(normalized.includes('"test@example.com"'));
});

run('validateAndNormalizeSteps returns ok and normalized steps for fixable scenario', () => {
  const result = validateAndNormalizeSteps(
    [
      { instruction: 'Click the search box', type: 'act' },
      { instruction: 'Type a keyword in the search box', type: 'act' },
      { instruction: 'Verify results are shown', type: 'assert' },
    ],
    { name: 'Search', description: 'User searches the site' }
  );
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    assert.strictEqual(result.steps.length, 3);
    assert.ok(result.steps[1].instruction.includes('"pricing"'));
  }
});

run('normalized steps always have concrete value for input-like steps', () => {
  const result = validateAndNormalizeSteps(
    [
      { instruction: 'Click the search box', type: 'act' },
      { instruction: 'Type a keyword in the search box', type: 'act' },
    ],
    { name: 'Search', description: 'User searches' }
  );
  assert.strictEqual(result.ok, true);
  if (result.ok) {
    const step1 = result.steps[1].instruction;
    assert.ok(step1.includes('"pricing"'));
    assert.ok(hasConcreteInputValue(step1));
  }
});

run('isInputLikeInstruction: type a keyword -> true', () => {
  assert.strictEqual(isInputLikeInstruction('Type a keyword in the box'), true);
});

run('isInputLikeInstruction: click the button -> false', () => {
  assert.strictEqual(isInputLikeInstruction('Click the button'), false);
});

run('hasConcreteInputValue: quoted non-empty -> true', () => {
  assert.strictEqual(hasConcreteInputValue('Type "hello" here'), true);
});

run('hasConcreteInputValue: type a keyword -> false', () => {
  assert.strictEqual(hasConcreteInputValue('Type a keyword'), false);
});

run('runtime guard: input-like without value would be caught by hasConcreteInputValue false', () => {
  const vague = 'Type a relevant phrase into the field';
  assert.strictEqual(isInputLikeInstruction(vague), true);
  assert.strictEqual(hasConcreteInputValue(vague), false);
  const fixed = normalizeInputInstruction(vague);
  assert.strictEqual(hasConcreteInputValue(fixed), true);
});

console.log('All step-quality tests passed.');
process.exit(0);
