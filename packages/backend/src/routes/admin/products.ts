import { Router } from 'express';
import { validateBody, validateEntityId } from '../../middleware/validate.js';
import { requireStorePermission } from '../../middleware/store-authz.js';
import {
  createStoreProductSchema,
  updateListingSchema,
  createVariantSchema,
  updateVariantSchema,
  setInventorySchema,
} from '../../middleware/schemas.js';
import {
  listProducts,
  createProduct,
  getProduct,
  patchProduct,
  deleteProduct,
  createVariant,
  patchVariant,
  deleteVariant,
  setVariantInventory,
} from '../../controllers/admin/products-admin.controller.js';

/**
 * Store products sub-router, mounted at `/admin/stores/:storeId/products`.
 *
 * `mergeParams` so `:storeId` is visible. The parent router already ran
 * `authenticateToken` → `loadStore`. Reads require `products:read`; writes
 * require `products:write`; the inventory absolute-set requires `inventory:write`.
 */
const router = Router({ mergeParams: true });

router.get('/', requireStorePermission('products:read'), listProducts);
router.post('/', requireStorePermission('products:write'), validateBody(createStoreProductSchema), createProduct);

router.get('/:id', requireStorePermission('products:read'), validateEntityId('id'), getProduct);
router.patch(
  '/:id',
  requireStorePermission('products:write'),
  validateEntityId('id'),
  validateBody(updateListingSchema),
  patchProduct,
);
router.delete('/:id', requireStorePermission('products:write'), validateEntityId('id'), deleteProduct);

// Variants.
router.post(
  '/:id/variants',
  requireStorePermission('products:write'),
  validateEntityId('id'),
  validateBody(createVariantSchema),
  createVariant,
);
router.patch(
  '/:id/variants/:variantId',
  requireStorePermission('products:write'),
  validateEntityId('id'),
  validateEntityId('variantId'),
  validateBody(updateVariantSchema),
  patchVariant,
);
router.delete(
  '/:id/variants/:variantId',
  requireStorePermission('products:write'),
  validateEntityId('id'),
  validateEntityId('variantId'),
  deleteVariant,
);

// Inventory absolute-set (admin restock).
router.patch(
  '/:id/variants/:variantId/inventory',
  requireStorePermission('inventory:write'),
  validateEntityId('id'),
  validateEntityId('variantId'),
  validateBody(setInventorySchema),
  setVariantInventory,
);

export default router;
