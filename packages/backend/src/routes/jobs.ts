import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateEntityId } from '../middleware/validate.js';
import {
  jobLocationSchema,
  jobLocationPingSchema,
  deliverJobSchema,
  scanJobSchema,
} from '../middleware/schemas.js';
import {
  listMyJobs,
  getMyJob,
  acceptJob,
  pickupJob,
  inTransitJob,
  deliverJob,
  scanJobHandler,
  pingJobLocation,
  cancelJob,
} from '../controllers/job.controller.js';

/**
 * Jobs API — the booked job lifecycle for senders and assigned couriers.
 *
 * Every route requires a real Oxy user (`authenticateToken`). Assignment /
 * claimability is enforced in the service layer; transitions go through the
 * atomic CAS. Metered on the dedicated `'jobs'` rate-limit scope.
 */
const router = Router();

router.use(authenticateToken);

router.get('/', makeRateLimiter('jobs'), listMyJobs);
router.get('/:id', makeRateLimiter('jobs'), validateEntityId('id'), getMyJob);

router.post('/:id/accept', makeRateLimiter('jobs'), validateEntityId('id'), acceptJob);
router.post(
  '/:id/pickup',
  makeRateLimiter('jobs'),
  validateEntityId('id'),
  validateBody(jobLocationSchema),
  pickupJob,
);
router.post(
  '/:id/in-transit',
  makeRateLimiter('jobs'),
  validateEntityId('id'),
  validateBody(jobLocationSchema),
  inTransitJob,
);
router.post(
  '/:id/deliver',
  makeRateLimiter('jobs'),
  validateEntityId('id'),
  validateBody(deliverJobSchema),
  deliverJob,
);
router.post(
  '/:id/scan',
  makeRateLimiter('jobs'),
  validateEntityId('id'),
  validateBody(scanJobSchema),
  scanJobHandler,
);
router.post(
  '/:id/location',
  makeRateLimiter('jobs'),
  validateEntityId('id'),
  validateBody(jobLocationPingSchema),
  pingJobLocation,
);
router.post('/:id/cancel', makeRateLimiter('jobs'), validateEntityId('id'), cancelJob);

export default router;
