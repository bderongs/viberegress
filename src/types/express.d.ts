/**
 * Extends Express Request with telemetry context and auth owner.
 */

import type { Owner } from './owner.js';

declare global {
  namespace Express {
    interface Request {
      requestId?: string;
      traceId?: string;
      owner?: Owner;
      authUser?: { id: string; email?: string };
    }
  }
}

export {};
