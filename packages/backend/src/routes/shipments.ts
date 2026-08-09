import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateEntityId } from '../middleware/validate.js';
import { createShipmentSchema, bookShipmentSchema } from '../middleware/schemas.js';
import {
  createShipmentHandler,
  listMyShipments,
  getMyShipment,
  getShipmentQuotes,
  bookShipmentHandler,
  cancelShipmentHandler,
} from '../controllers/shipment.controller.js';

/**
 * Shipments API — the customer's request → quotes → booking flow.
 *
 * Every route requires a real Oxy user (`authenticateToken`). Ownership
 * (sender === caller) is enforced in the service layer. Metered on the dedicated
 * `'shipments'` rate-limit scope.
 */
const router = Router();

router.use(authenticateToken);

router.post('/', makeRateLimiter('shipments'), validateBody(createShipmentSchema), createShipmentHandler);
router.get('/', makeRateLimiter('shipments'), listMyShipments);
router.get('/:id', makeRateLimiter('shipments'), validateEntityId('id'), getMyShipment);
router.get('/:id/quotes', makeRateLimiter('shipments'), validateEntityId('id'), getShipmentQuotes);
router.post(
  '/:id/book',
  makeRateLimiter('shipments'),
  validateEntityId('id'),
  validateBody(bookShipmentSchema),
  bookShipmentHandler,
);
router.post('/:id/cancel', makeRateLimiter('shipments'), validateEntityId('id'), cancelShipmentHandler);

export default router;
