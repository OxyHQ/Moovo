/**
 * Moovo Tracker API — universal parcel tracking.
 *
 * ## Two auth postures on one router, on purpose
 *
 * The router mounts `optionalAuth`, NOT `authenticateToken`, because anonymous
 * tracking is the product rather than a concession: somebody pastes a number,
 * sees where their parcel is, and owes us nothing. Those three routes answer
 * anyone. Everything under `/parcels` calls `getRequiredOxyUserId`, which
 * refuses without a real user — a list is a thing that belongs to somebody.
 *
 * ## The lookup is an enumeration surface, and that is answered here
 *
 * Anyone can probe numbers; the carrier's own website works the same way. Two
 * things make that acceptable: its own tight rate-limit scope, and an
 * ALLOW-LIST of the fields a carrier response may contribute to a public answer
 * (`services/tracking/public-facts.ts`) — never a recipient's name, a delivery
 * address or a signature, whatever the carrier hands us.
 *
 * Two scopes rather than one: `tracking-lookup` spends real carrier calls and
 * faces the open internet, while `tracking` serves a signed-in user reading
 * their own list. Sharing a scope would also share a Redis key prefix and
 * therefore a counter.
 */

import { Router } from 'express';
import { optionalAuth } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateEntityId } from '../middleware/validate.js';
import {
  trackParcelSchema,
  trackingDetectSchema,
  trackingLookupSchema,
  updateTrackedParcelSchema,
} from '../middleware/schemas.js';
import {
  addParcel,
  deleteParcel,
  detectCarrier,
  getCarriers,
  getParcel,
  listMyParcels,
  lookup,
  patchParcel,
  refreshParcel,
} from '../controllers/tracking.controller.js';

const router = Router();

router.use(optionalAuth);

/* ── Open to anyone ───────────────────────────────────────────────────── */

router.get('/carriers', makeRateLimiter('tracking'), getCarriers);

router.post(
  '/detect',
  makeRateLimiter('tracking'),
  validateBody(trackingDetectSchema),
  detectCarrier,
);

router.post(
  '/lookup',
  // The tight one. This is the surface that faces the open internet and the
  // only one that can cause a carrier call without an account behind it.
  makeRateLimiter('tracking-lookup'),
  validateBody(trackingLookupSchema),
  lookup,
);

/* ── A signed-in user's own parcels ───────────────────────────────────── */

router.get('/parcels', makeRateLimiter('tracking'), listMyParcels);

router.post(
  '/parcels',
  makeRateLimiter('tracking'),
  validateBody(trackParcelSchema),
  addParcel,
);

router.get('/parcels/:id', makeRateLimiter('tracking'), validateEntityId('id'), getParcel);

router.patch(
  '/parcels/:id',
  makeRateLimiter('tracking'),
  validateEntityId('id'),
  validateBody(updateTrackedParcelSchema),
  patchParcel,
);

router.delete('/parcels/:id', makeRateLimiter('tracking'), validateEntityId('id'), deleteParcel);

router.post(
  '/parcels/:id/refresh',
  makeRateLimiter('tracking'),
  validateEntityId('id'),
  refreshParcel,
);

export default router;
