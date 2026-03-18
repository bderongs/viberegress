/**
 * Tests for starting-webpage validation (same-site, valid URL).
 * Run with: npx tsx src/lib/starting-webpage.test.ts
 */

import assert from 'assert';
import { validateStartingWebpage } from './starting-webpage.js';

const siteUrl = 'https://example.com/docs';

function run(label: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok: ${label}`);
  } catch (e) {
    console.error(`  FAIL: ${label}`);
    throw e;
  }
}

console.log('starting-webpage tests');

run('empty string is ok', () => {
  const r = validateStartingWebpage('', siteUrl);
  assert.strictEqual(r.ok, true);
});

run('null/undefined is ok', () => {
  assert.strictEqual(validateStartingWebpage(null, siteUrl).ok, true);
  assert.strictEqual(validateStartingWebpage(undefined, siteUrl).ok, true);
});

run('same origin URL is ok', () => {
  const r = validateStartingWebpage('https://example.com/pricing', siteUrl);
  assert.strictEqual(r.ok, true);
});

run('same origin with path is ok', () => {
  const r = validateStartingWebpage('https://example.com/', siteUrl);
  assert.strictEqual(r.ok, true);
});

run('invalid URL is rejected', () => {
  const r = validateStartingWebpage('not-a-url', siteUrl);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.includes('valid URL'));
});

run('cross-origin URL is rejected', () => {
  const r = validateStartingWebpage('https://other.com/page', siteUrl);
  assert.strictEqual(r.ok, false);
  assert.ok(r.error && r.error.includes('same site'));
});

run('different protocol same host is rejected', () => {
  const r = validateStartingWebpage('http://example.com/docs', siteUrl);
  assert.strictEqual(r.ok, false);
});

run('whitespace-only is ok', () => {
  const r = validateStartingWebpage('  ', siteUrl);
  assert.strictEqual(r.ok, true);
});
