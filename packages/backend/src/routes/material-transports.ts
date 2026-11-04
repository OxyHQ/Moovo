import cors from 'cors';
import { json, Router, type Request, type Response, type NextFunction } from 'express';
import {
  isContractError,
  CreateTransport,
  AuthorizeTransport,
  TransportAction,
  TransportRead,
  openapi,
  routes,
} from '@oxy.so/moovo-contracts';
import { optionalAuth } from '../middleware/auth';
import { makeRateLimiter } from '../lib/rate-limit';
import { OxyAccessError } from '@oxy.so/core/server';
import {
  transportAccessError,
  transportCaller,
  TransportError,
} from '../services/material-transports/access';
import {
  quoteTransport,
  createTransport,
  getTransport,
  transportForReservation,
  authorizeTransport,
  bookTransport,
  cancelTransport,
} from '../services/material-transports/service';
import { MoovoError } from '../lib/errors/error-codes';
const router = Router();
// This SDK API accepts explicit bearer credentials from product frontends. It
// never authenticates cross-origin cookies or grants credentialed browser reads.
router.use(
  cors({
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'X-Oxy-Activity-Id',
      'X-Oxy-Edge-Region',
      'X-Session-Id',
      'X-Device-Info',
    ],
  }),
);
router.use((req, _res, next) =>
  next(
    req.headers.cookie
      ? new TransportError('bad_request', 'Use bearer authentication without cookies')
      : undefined,
  ),
);
router.use(json({ limit: '128kb' }));
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.get('/openapi.json', (_req, res) => res.json(openapi()));
router.use(optionalAuth);
// The SDK limiter already answers 429 in this API's `{ error: { code, message, details } }` envelope.
router.use(makeRateLimiter('material-transports'));
for (const route of routes) {
  router[route.method](
    route.path.replace('{id}', ':id'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const caller = transportCaller(req);
        const id = String(req.params.id ?? '');
        let result: unknown;
        if (route.path === '/transports')
          result = await createTransport(caller, CreateTransport.parse(req.body));
        else if (route.method === 'get') {
          const query = TransportRead.parse(req.query);
          result = route.path.startsWith('/reservations/')
            ? await transportForReservation(caller, id, query.accountId)
            : await getTransport(caller, id, query.accountId);
        } else if (route.path.endsWith('/authorize'))
          result = await authorizeTransport(caller, id, AuthorizeTransport.parse(req.body));
        else {
          const body = TransportAction.parse(req.body);
          result = route.path.endsWith('/quotes')
            ? await quoteTransport(caller, id, body.actingAccountId)
            : route.path.endsWith('/book')
              ? await bookTransport(caller, id, body.actingAccountId)
              : await cancelTransport(caller, id, body.actingAccountId);
        }
        res.status(route.status).json(result);
      } catch (err) {
        next(err);
      }
    },
  );
}
router.use((_req, res) =>
  res.status(404).json({ error: { code: 'unknown_route', message: 'No such Moovo API route' } }),
);
router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const error =
    err instanceof SyntaxError && 'status' in err && err.status === 400
      ? new TransportError('bad_request', 'Malformed JSON')
      : err instanceof TransportError
        ? err
        : err instanceof OxyAccessError
          ? transportAccessError(err)
          : isContractError(err)
            ? new TransportError(
                err.issues.some(
                  (issue) => issue.code === 'invalid_type' || issue.code === 'unrecognized_keys',
                )
                  ? 'bad_request'
                  : 'validation_failed',
                'Invalid transport input',
              )
            : err instanceof MoovoError && err.httpStatus === 409
              ? new TransportError('conflict', err.message)
              : new TransportError('internal_error', 'Transport could not be processed');
  res.status(error.status).json({ error: { code: error.code, message: error.message } });
});
export default router;
