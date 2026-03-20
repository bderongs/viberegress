import assert from 'assert';
import { planAtomicActionsForStep } from './stagehand.js';

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}`);
    throw e;
  }
}

console.log('stagehand planner tests');

run('name+email+submit step is decomposed', () => {
  const step =
    'Fill out the test form by typing a first name and an email address, then click on the submit button.';
  const planned = planAtomicActionsForStep(step);
  assert.ok(planned);
  assert.strictEqual(planned!.length, 5);
  assert.strictEqual(planned![0].label, 'fill_first_name');
  assert.strictEqual(planned![1].label, 'verify_first_name');
  assert.strictEqual(planned![2].label, 'fill_email');
  assert.strictEqual(planned![3].label, 'verify_email');
  assert.strictEqual(planned![4].label, 'submit_form');
});

run('non-form step does not get atomic plan', () => {
  const step = 'Click the pricing link in the header.';
  const planned = planAtomicActionsForStep(step);
  assert.strictEqual(planned, null);
});

console.log('All stagehand planner tests passed.');
process.exit(0);
