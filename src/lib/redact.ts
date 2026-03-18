/**
 * Redact auth-like strings from error messages before logging or sending to clients.
 * Prevents leaking tokens, cookies, or headers in telemetry/API responses.
 */

const BEARER = /Bearer\s+[^\s]+/gi;
/** Only redact when keyword is followed by = or : or quote (avoid matching e.g. AUTH_ENCRYPTION_KEY). */
const COOKIE_VALUE = /(?:cookie|session|token|auth)(?:\s*[:=]\s*|["'])\s*["']?[^"'\s]{8,}["']?/gi;
const REDACTED = '[REDACTED]';

export function redactAuth(message: string): string {
  if (!message || typeof message !== 'string') return message;
  return message
    .replace(BEARER, 'Bearer ' + REDACTED)
    .replace(COOKIE_VALUE, REDACTED);
}
