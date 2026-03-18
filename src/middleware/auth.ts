/**
 * Resolves request owner: Supabase JWT (user) or X-Session-Id (anonymous trial).
 */

import { createClient } from '@supabase/supabase-js';
import type { Request, Response, NextFunction } from 'express';
import type { Owner } from '../types/owner.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const token = auth.slice(7).trim();
      if (!token) {
        res.status(401).json({ error: 'Invalid token' });
        return;
      }
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_ANON_KEY;
      if (!url || !key) {
        res.status(503).json({ error: 'Auth is not configured (SUPABASE_URL / SUPABASE_ANON_KEY).' });
        return;
      }
      const supabase = createClient(url, key);
      const {
        data: { user },
        error,
      } = await supabase.auth.getUser(token);
      if (error || !user) {
        res.status(401).json({ error: 'Invalid or expired session. Sign in again.' });
        return;
      }
      req.owner = { type: 'user', id: user.id };
      req.authUser = { id: user.id, email: user.email ?? undefined };
      next();
      return;
    }

    const raw = req.headers['x-session-id'];
    const sessionId = typeof raw === 'string' ? raw.trim() : '';
    if (!sessionId || !UUID_RE.test(sessionId)) {
      res.status(401).json({ error: 'Missing or invalid trial session. Refresh the page.' });
      return;
    }
    req.owner = { type: 'anonymous', id: sessionId.toLowerCase() };
    next();
  } catch (err) {
    next(err);
  }
}
