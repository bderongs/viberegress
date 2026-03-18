/**
 * Unit tests for auth redaction. Run with: tsx src/lib/redact.test.ts
 */

import { redactAuth } from './redact.js';

let passed = 0;
let failed = 0;

function ok(name: string) {
  console.log('ok', name);
  passed++;
}

function fail(name: string, got: string, expected: string) {
  console.error('FAIL', name, { got, expected });
  failed++;
}

const r1 = redactAuth('Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
if (r1.includes('[REDACTED]') && !r1.includes('eyJ')) ok('Bearer redacted');
else fail('Bearer redacted', r1, 'Bearer [REDACTED]');

const r2 = redactAuth('cookie=abc123longsecret');
if (r2.includes('[REDACTED]')) ok('cookie-like redacted');
else fail('cookie-like', r2, 'should contain [REDACTED]');

const r3 = redactAuth('Auth profile not found: xyz');
if (r3 === 'Auth profile not found: xyz') ok('safe message unchanged');
else fail('safe message', r3, 'Auth profile not found: xyz');

const r4 = redactAuth('AUTH_ENCRYPTION_KEY must be set and at least 32 characters (e.g. 32-byte hex or long passphrase)');
if (r4.includes('AUTH_ENCRYPTION_KEY') && !r4.includes('[REDACTED]')) ok('env var name not redacted');
else fail('env var name', r4, 'message should show AUTH_ENCRYPTION_KEY');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
