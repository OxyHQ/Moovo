import { Router } from 'express';
import { validateBody, validateObjectId } from '../../middleware/validate.js';
import { loadCompany, requireCompanyPermission } from '../../middleware/company-authz.js';
import { createCompanySchema, updateCompanySchema } from '../../middleware/schemas.js';
import {
  createCompanyHandler,
  listMyCompanies,
  getCompanyHandler,
  updateCompanyHandler,
} from '../../controllers/admin/company-admin.controller.js';
import membersRouter from './company-members.js';
import vehiclesRouter from './company-vehicles.js';

/**
 * Company-admin router, mounted at `/admin/companies`.
 *
 * `POST /` (create — caller becomes owner) and `GET /` (caller's companies) do
 * NOT use `loadCompany`. Everything under `/:companyId` runs `loadCompany` first
 * (resolve + member check, attaching `req.company`/`req.companyMembership`), then
 * per-route role/permission guards. The members + vehicles sub-routers inherit
 * the loaded company via `mergeParams`.
 */
const router = Router();

// Caller-scoped (no loadCompany).
router.post('/', validateBody(createCompanySchema), createCompanyHandler);
router.get('/', listMyCompanies);

// Company-scoped: load + authorize the company for every nested route.
router.use('/:companyId', validateObjectId('companyId'), loadCompany);

router.get('/:companyId', getCompanyHandler);
router.patch(
  '/:companyId',
  requireCompanyPermission('company:manage'),
  validateBody(updateCompanySchema),
  updateCompanyHandler,
);

router.use('/:companyId/members', membersRouter);
router.use('/:companyId/vehicles', vehiclesRouter);

export default router;
