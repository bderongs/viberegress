/**
 * Zod schemas for auth profile payload validation. Used by API routes.
 */

import { z } from 'zod';

const authProfileMode = z.enum(['session', 'headers_cookies', 'hybrid']);

const authCookieSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  domain: z.string().min(1),
  path: z.string().optional(),
  expires: z.number().optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(['Strict', 'Lax', 'None']).optional(),
});

/** Header names must be valid HTTP header names (no control chars). */
const headerName = z.string().min(1).max(256).refine(
  (s) => !/[\x00-\x1f\x7f]/.test(s),
  { message: 'Invalid header name' }
);

export const authProfilePayloadSchema = z.object({
  cookies: z.array(authCookieSchema).optional(),
  extraHTTPHeaders: z.record(headerName, z.string()).optional(),
  storageStateJson: z.string().optional(),
});

export const createAuthProfileBodySchema = z.object({
  name: z.string().min(1).max(255),
  baseUrl: z.string().url(),
  mode: authProfileMode,
  /** Optional: paste from DevTools cookie table; parsed and used as payload.cookies. */
  cookiesPaste: z.string().optional(),
  payload: authProfilePayloadSchema.optional(),
});

export const updateAuthProfileBodySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  baseUrl: z.string().url().optional(),
  mode: authProfileMode.optional(),
  /** Optional: paste from DevTools cookie table; parsed and merged into payload.cookies. */
  cookiesPaste: z.string().optional(),
  payload: authProfilePayloadSchema.optional(),
});

export type CreateAuthProfileBody = z.infer<typeof createAuthProfileBodySchema>;
export type UpdateAuthProfileBody = z.infer<typeof updateAuthProfileBodySchema>;
