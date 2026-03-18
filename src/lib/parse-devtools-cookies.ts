/**
 * Parse cookie table pasted from browser DevTools (Application → Cookies).
 * Handles Chrome tab-separated copy. Cookie values can span multiple lines;
 * we merge continuation lines into the value then find Domain by pattern.
 */

import type { AuthCookie } from '../types/index.js';

const COLS_AFTER_DOMAIN = 8;

function looksLikeDomain(cell: string): boolean {
  const t = cell.trim();
  if (!t || t.length > 253) return false;
  if (/\s/.test(t)) return false;
  return /\./.test(t) && /^[a-zA-Z0-9.-]+$/.test(t);
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/\s+/g, '').trim();
}

function parseExpires(s: string): number | undefined {
  const t = s.trim();
  if (!t || t.toLowerCase() === 'session') return undefined;
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? undefined : Math.floor(d.getTime() / 1000);
}

function parseBool(s: string): boolean {
  const t = s.trim().toLowerCase();
  return t === '✓' || t === 'true' || t === '1' || t === 'yes' || t === 'x';
}

function parseSameSite(s: string): 'Strict' | 'Lax' | 'None' | undefined {
  const t = s.trim();
  if (t === 'Strict' || t === 'Lax' || t === 'None') return t;
  const lower = t.toLowerCase();
  if (lower === 'strict' || lower === 'lax' || lower === 'none') return t as 'Strict' | 'Lax' | 'None';
  return undefined;
}

/**
 * Build rows: split by newline, then by tab. Lines that don't contain a domain
 * are merged into the previous row's value. If a line has a domain, the part
 * before the domain is value continuation, the rest (domain, path, ...) close the row.
 */
function linesToRows(pasted: string, delimiter: string): string[][] {
  const lines = pasted.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  const rows: string[][] = [];
  let current: string[] = [];

  for (const line of lines) {
    const cells = line.split(delimiter).map((c) => c.trim());
    const domainIdx = cells.findIndex((c) => looksLikeDomain(c));
    const hasDomain = domainIdx >= 0;

    if (current.length > 0) {
      const isHeaderRow = normalizeHeader(current[0] ?? '') === 'name';
      if (hasDomain) {
        if (isHeaderRow) {
          current = cells;
        } else if (domainIdx === 1) {
          const valueContinuation = cells[0];
          const rest = cells.slice(1);
          if (current.length > 1) current[1] = (current[1] ?? '') + '\n' + valueContinuation;
          else current[1] = valueContinuation;
          current.push(...rest);
          rows.push(current);
          current = [];
        } else {
          if (!isHeaderRow) rows.push(current);
          current = cells;
        }
      } else {
        if (isHeaderRow) current = cells;
        else {
          if (current.length > 1) current[1] = (current[1] ?? '') + '\n' + cells.join('\t');
          else current[1] = cells.join('\t');
        }
      }
      continue;
    }

    if (hasDomain) {
      current = cells;
    } else {
      current = cells;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows;
}

/**
 * Parse pasted text from DevTools cookie table (tab-separated).
 * Supports values that span multiple lines (Chrome wraps long values).
 */
export function parseCookiesFromDevTools(pasted: string): AuthCookie[] {
  const trimmed = pasted.trim();
  if (!trimmed) throw new Error('Paste is empty. Copy the cookie table from Chrome first.');

  const delimiter = trimmed.includes('\t') ? '\t' : ',';
  const rows = linesToRows(trimmed, delimiter);
  if (rows.length === 0) throw new Error('Could not read any rows. Copy the full cookie table from Chrome (Application → Cookies).');

  const firstRow = rows[0];
  const isHeader =
    firstRow.length > 0 &&
    (normalizeHeader(firstRow[0] ?? '') === 'name' ||
      ((firstRow[0] ?? '').toLowerCase() === 'name' && (firstRow[1] ?? '').toLowerCase() === 'value'));
  const start = isHeader ? 1 : 0;

  const cookies: AuthCookie[] = [];
  for (let r = start; r < rows.length; r++) {
    const cells = rows[r] ?? [];
    const name = cells[0]?.trim();
    if (!name) continue;

    let k = 1;
    while (k < cells.length && !looksLikeDomain(cells[k] ?? '')) k += 1;
    if (k >= cells.length) continue;

    const domain = cells[k]?.trim();
    if (!domain) continue;

    const value = cells
      .slice(1, k)
      .join('\t')
      .trim();
    const path = cells[k + 1]?.trim();
    const expires = cells[k + 2] ? parseExpires(cells[k + 2]) : undefined;
    const httpOnly = cells[k + 4] ? parseBool(cells[k + 4]) : false;
    const secure = cells[k + 5] ? parseBool(cells[k + 5]) : false;
    const sameSite = cells[k + 6] ? parseSameSite(cells[k + 6]) : undefined;

    cookies.push({
      name,
      value: value ?? '',
      domain,
      ...(path && { path }),
      ...(expires !== undefined && { expires }),
      ...(httpOnly && { httpOnly: true }),
      ...(secure && { secure: true }),
      ...(sameSite && { sameSite }),
    });
  }

  if (cookies.length === 0) {
    throw new Error(
      'No cookies found in that paste. In Chrome: Application → Cookies → your site, select all table rows, copy, paste again.'
    );
  }
  return cookies;
}
