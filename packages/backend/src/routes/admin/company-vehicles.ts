import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { requireCompanyPermission } from '../../middleware/company-authz.js';
import { createVehicleSchema, updateVehicleSchema } from '../../middleware/schemas.js';
import {
  listCompanyVehicles,
  createCompanyVehicle,
  updateCompanyVehicle,
  deleteCompanyVehicle,
} from '../../controllers/admin/company-admin.controller.js';

/**
 * Company vehicles (fleet) sub-router, mounted at
 * `/admin/companies/:companyId/vehicles`.
 *
 * `mergeParams` so `:companyId` is visible. The parent router already ran
 * `authenticateToken` → `loadCompany`. Reads require `jobs:read` (any member
 * can see the fleet); writes require `fleet:write`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireCompanyPermission('jobs:read'), listCompanyVehicles);
router.post(
  '/',
  requireCompanyPermission('fleet:write'),
  validateBody(createVehicleSchema),
  createCompanyVehicle,
);
router.patch(
  '/:id',
  requireCompanyPermission('fleet:write'),
  validateObjectId('id'),
  validateBody(updateVehicleSchema),
  updateCompanyVehicle,
);
router.delete(
  '/:id',
  requireCompanyPermission('fleet:write'),
  validateObjectId('id'),
  deleteCompanyVehicle,
);

export default router;
