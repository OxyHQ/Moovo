import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateObjectId } from '../middleware/validate.js';
import {
  courierPrefsSchema,
  createVehicleSchema,
  updateVehicleSchema,
  locationPingSchema,
  setActiveVehicleSchema,
} from '../middleware/schemas.js';
import {
  getMyProfile,
  updateMyProfile,
  goOnlineHandler,
  goOfflineHandler,
  pingLocationHandler,
  listMyVehicles,
  createMyVehicle,
  updateMyVehicle,
  deleteMyVehicle,
  setActiveVehicleHandler,
} from '../controllers/courier-profile.controller.js';

/**
 * Courier API — the individual courier's own profile, availability, location,
 * and vehicles.
 *
 * Every route requires a real Oxy user (`authenticateToken`). The courier
 * profile is created lazily on first access. Metered on the dedicated
 * `'courier'` rate-limit scope.
 */
const router = Router();

router.use(authenticateToken);

// Courier profile.
router.get('/me', makeRateLimiter('courier'), getMyProfile);
router.patch('/me', makeRateLimiter('courier'), validateBody(courierPrefsSchema), updateMyProfile);

// Availability.
router.post('/online', makeRateLimiter('courier'), goOnlineHandler);
router.post('/offline', makeRateLimiter('courier'), goOfflineHandler);

// Location ping.
router.post(
  '/location',
  makeRateLimiter('courier'),
  validateBody(locationPingSchema),
  pingLocationHandler,
);

// Vehicles.
router.get('/vehicles', makeRateLimiter('courier'), listMyVehicles);
router.post(
  '/vehicles',
  makeRateLimiter('courier'),
  validateBody(createVehicleSchema),
  createMyVehicle,
);
router.patch(
  '/vehicles/:id',
  makeRateLimiter('courier'),
  validateObjectId('id'),
  validateBody(updateVehicleSchema),
  updateMyVehicle,
);
router.delete(
  '/vehicles/:id',
  makeRateLimiter('courier'),
  validateObjectId('id'),
  deleteMyVehicle,
);

// Active vehicle selection (recomputes the capability cache).
router.post(
  '/active-vehicle',
  makeRateLimiter('courier'),
  validateBody(setActiveVehicleSchema),
  setActiveVehicleHandler,
);

export default router;
