import { Router } from 'express';
import { authenticateToken } from '../middleware/auth.js';
import { makeRateLimiter } from '../lib/rate-limit.js';
import { validateBody, validateObjectId } from '../middleware/validate.js';
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
router.get('/:id', makeRateLimiter('shipments'), validateObjectId('id'), getMyShipment);
router.get('/:id/quotes', makeRateLimiter('shipments'), validateObjectId('id'), getShipmentQuotes);
router.post(
  '/:id/book',
  makeRateLimiter('shipments'),
  validateObjectId('id'),
  validateBody(bookShipmentSchema),
  bookShipmentHandler,
);
router.post('/:id/cancel', makeRateLimiter('shipments'), validateObjectId('id'), cancelShipmentHandler);

export default router;
