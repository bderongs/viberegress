/**
 * Unit tests for auth payload encryption. Run with: tsx src/lib/crypto.test.ts
 */

import { encrypt, decrypt } from './crypto.js';

const ORIGINAL_KEY = process.env.AUTH_ENCRYPTION_KEY;

function setKey(key: string) {
  process.env.AUTH_ENCRYPTION_KEY = key;
}

function restoreKey() {
  if (ORIGINAL_KEY !== undefined) process.env.AUTH_ENCRYPTION_KEY = ORIGINAL_KEY;
  else delete process.env.AUTH_ENCRYPTION_KEY;
}

function runTests() {
  let passed = 0;
  let failed = 0;

  setKey('a'.repeat(32));

  // Round-trip
  try {
    const plain = JSON.stringify({ cookies: [{ name: 'sess', value: 'secret123', domain: 'example.com' }] });
    const cipher = encrypt(plain);
    const dec = decrypt(cipher);
    if (dec !== plain) throw new Error('Decrypted value did not match');
    console.log('ok encrypt/decrypt round-trip');
    passed++;
  } catch (e) {
    console.error('FAIL round-trip', e);
    failed++;
  }

  // Tamper: change one byte of base64
  try {
    const cipher = encrypt('sensitive');
    const tampered = cipher.slice(0, -2) + (cipher.slice(-1) === 'A' ? 'B' : 'A');
    decrypt(tampered);
    console.error('FAIL tamper should throw');
    failed++;
  } catch {
    console.log('ok tamper detection');
    passed++;
  }

  // Wrong key
  try {
    const cipher = encrypt('data');
    setKey('b'.repeat(32));
    decrypt(cipher);
    console.error('FAIL wrong key should throw');
    failed++;
  } catch {
    console.log('ok wrong key throws');
    passed++;
  } finally {
    setKey('a'.repeat(32));
  }

  restoreKey();
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
