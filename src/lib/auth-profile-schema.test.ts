/**
 * Unit tests for auth profile Zod schemas. Run with: tsx src/lib/auth-profile-schema.test.ts
 */

import {
  authProfilePayloadSchema,
  createAuthProfileBodySchema,
  updateAuthProfileBodySchema,
} from './auth-profile-schema.js';

let passed = 0;
let failed = 0;

function ok(name: string) {
  console.log('ok', name);
  passed++;
}

function fail(name: string, e: unknown) {
  console.error('FAIL', name, e);
  failed++;
}

// Valid payload - minimal
const r1 = authProfilePayloadSchema.safeParse({});
if (r1.success) ok('payload empty'); else fail('payload empty', r1.error);

// Valid payload - cookies
const r2 = authProfilePayloadSchema.safeParse({
  cookies: [{ name: 's', value: 'v', domain: 'x.com' }],
});
if (r2.success) ok('payload cookies'); else fail('payload cookies', r2.error);

// Valid payload - headers
const r3 = authProfilePayloadSchema.safeParse({
  extraHTTPHeaders: { 'X-Custom': 'value' },
});
if (r3.success) ok('payload headers'); else fail('payload headers', r3.error);

// Invalid header name (control char)
const r4 = authProfilePayloadSchema.safeParse({
  extraHTTPHeaders: { 'X-Foo\x00': 'v' },
});
if (!r4.success) ok('payload invalid header name'); else fail('payload invalid header name', 'expected failure');

// Create body - valid
const r5 = createAuthProfileBodySchema.safeParse({
  name: 'Test',
  baseUrl: 'https://example.com',
  mode: 'hybrid',
  payload: {},
});
if (r5.success) ok('create body valid'); else fail('create body valid', r5.error);

// Create body - invalid URL
const r6 = createAuthProfileBodySchema.safeParse({
  name: 'Test',
  baseUrl: 'not-a-url',
  mode: 'session',
  payload: {},
});
if (!r6.success) ok('create body invalid url'); else fail('create body invalid url', 'expected failure');

// Update body - partial
const r7 = updateAuthProfileBodySchema.safeParse({ name: 'New name' });
if (r7.success) ok('update body partial'); else fail('update body partial', r7.error);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
