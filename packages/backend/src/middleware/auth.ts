import { workloadCredentials } from '../workload.js';
import type { Request, Response, NextFunction } from 'express';
import {
  OxyServer,
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  type OxyRequestUser,
} from '@oxy.so/core/server';

// The backend's Oxy client: `OxyServer` carries the server half (middleware,
// service tokens) that `OxyServices` no longer does.
const OXY_API_URL = process.env.OXY_API_URL || 'https://api.oxy.so';
export const oxyClient = new OxyServer({
  baseURL: OXY_API_URL,
  workloadCredentials,
});

// Product context accompanying the shared Oxy session principal.
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      accessToken?: string;
      user?: OxyRequestUser | null;
      workspace?: {
        id: string | null;
        role?: 'owner' | 'admin' | 'member';
      };
    }
  }
}

/**
 * Oxy authentication middleware (official @oxy.so/core/server)
 * Validates shared sessions and attaches the verified user context.
 */
export const authenticateToken = createOxyAuthMiddleware(oxyClient, { auth: { debug: true } });

/** Optional shared session validation; anonymous requests remain anonymous. */
const oxyOptionalAuth = createOptionalOxyAuth(oxyClient, { auth: { debug: true } });

export function optionalAuth(req: Request, res: Response, next: NextFunction): void {
  // Uses @oxy.so/core/server optional auth — attaches user if valid, continues if not.
  oxyOptionalAuth(req, res, next);
}
