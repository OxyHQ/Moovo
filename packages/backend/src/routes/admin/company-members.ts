import { Router } from 'express';
import { validateBody } from '../../middleware/validate.js';
import { requireCompanyPermission } from '../../middleware/company-authz.js';
import { inviteCompanyMemberSchema, updateCompanyMemberSchema } from '../../middleware/schemas.js';
import {
  listMembers,
  addMember,
  patchMember,
  deleteMember,
} from '../../controllers/admin/company-members.controller.js';

/**
 * Company members sub-router, mounted at `/admin/companies/:companyId/members`.
 *
 * `mergeParams` so `:companyId` is visible. The parent router has already run
 * `authenticateToken` → `loadCompany`, so `req.company`/`req.companyMembership`
 * are set. Member management requires the `members:manage` permission; owner-
 * protection invariants are enforced in `courier-company.service`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireCompanyPermission('members:manage'), listMembers);
router.post(
  '/',
  requireCompanyPermission('members:manage'),
  validateBody(inviteCompanyMemberSchema),
  addMember,
);
router.patch(
  '/:oxyUserId',
  requireCompanyPermission('members:manage'),
  validateBody(updateCompanyMemberSchema),
  patchMember,
);
router.delete('/:oxyUserId', requireCompanyPermission('members:manage'), deleteMember);

export default router;
