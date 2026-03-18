/**
 * AES-GCM encryption for auth profile payloads. Key from AUTH_ENCRYPTION_KEY (32-byte hex or base64).
 * Envelope: version (1 byte) + iv (12) + authTag (16) + ciphertext.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const KEY_LEN = 32;
const TAG_LEN = 16;
const VERSION = 1;

function getKey(): Buffer {
  const raw = process.env.AUTH_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error(
      'AUTH_ENCRYPTION_KEY must be set and at least 32 characters (e.g. 32-byte hex or long passphrase)'
    );
  }
  if (Buffer.isBuffer(raw)) return raw as Buffer;
  const hex = /^[0-9a-fA-F]{64}$/.test(raw);
  if (hex) return Buffer.from(raw, 'hex');
  return Buffer.from(raw, 'utf8').subarray(0, KEY_LEN);
}

/** One-time key derivation so we always use 32 bytes. */
function deriveKey(): Buffer {
  const raw = getKey();
  if (raw.length === KEY_LEN) return raw;
  return createHash('sha256').update(raw).digest();
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = Buffer.concat([Buffer.from([VERSION]), iv, tag, encrypted]);
  return envelope.toString('base64');
}

export function decrypt(ciphertextBase64: string): string {
  const envelope = Buffer.from(ciphertextBase64, 'base64');
  if (envelope.length < 1 + IV_LEN + TAG_LEN) throw new Error('Invalid ciphertext: too short');
  const version = envelope[0];
  if (version !== VERSION) throw new Error('Unsupported cipher version');
  const iv = envelope.subarray(1, 1 + IV_LEN);
  const tag = envelope.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
  const encrypted = envelope.subarray(1 + IV_LEN + TAG_LEN);
  const key = deriveKey();
  const decipher = createDecipheriv(ALGO, key, iv, { authTagLength: TAG_LEN });
  decipher.setAuthTag(tag);
  const plain = decipher.update(encrypted) + decipher.final('utf8');
  return plain;
}

/** Validate key at startup (throws if missing or too short). */
export function validateKey(): void {
  getKey();
}
