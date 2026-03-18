/**
 * Validates that an optional starting webpage URL is valid and on the same site as the scenario's siteUrl.
 */

export function validateStartingWebpage(
  value: string | null | undefined,
  siteUrl: string
): { ok: true } | { ok: false; error: string } {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return { ok: true };

  let startUrl: URL;
  try {
    startUrl = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Starting webpage must be a valid URL.' };
  }
  if (!['http:', 'https:'].includes(startUrl.protocol)) {
    return { ok: false, error: 'Starting webpage must use http or https.' };
  }

  let site: URL;
  try {
    site = new URL(siteUrl);
  } catch {
    return { ok: false, error: 'Site URL is invalid.' };
  }

  if (startUrl.origin !== site.origin) {
    return {
      ok: false,
      error: 'Starting webpage must be on the same site (same origin) as the scenario site URL.',
    };
  }
  return { ok: true };
}
