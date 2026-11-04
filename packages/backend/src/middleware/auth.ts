import { workloadCredentials } from '../workload.js';
import {
  OxyServer,
  createOptionalOxyAuth,
  createOxyAuthMiddleware,
  type OxyRequestUser,
} from '@oxy.so/core/server';

// The process's ONE Oxy client, authenticated as Moovo's workload. Calls as a
// person go through `oxyClient.withUser(req, …)`; nothing else constructs an
// Oxy client. `serviceIdentity` sends session-less reads (profiles, the
// organization directory) with the workload token instead of anonymously,
// which oxy-api charges to the shared NAT address and slows past 100 per 15 min.
export const oxyClient = new OxyServer({
  baseURL: process.env.OXY_API_URL || 'https://api.oxy.so',
  workloadCredentials,
  serviceIdentity: 'when-anonymous',
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

/** A verified Oxy session is required; attaches the caller (`getRequiredOxyUserId`). */
export const authenticateToken = createOxyAuthMiddleware(oxyClient);

/** Attaches the caller when a valid session is present; anonymous requests stay anonymous. */
export const optionalAuth = createOptionalOxyAuth(oxyClient);
