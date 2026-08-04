import { Router } from 'express';
import { requirePermission } from '../../middleware/authz.js';
import { validate } from '../../middleware/validate.js';
import {
  createFacility,
  getFacilities,
  provisionTenant,
  suspendTenant,
  upsertIdpConfig,
} from './service.js';
import {
  createFacilitySchema,
  createTenantSchema,
  listFacilitiesSchema,
  tenantIdParamSchema,
  upsertIdpConfigSchema,
  type CreateFacilityInput,
  type CreateTenantInput,
  type ListFacilitiesQuery,
  type UpsertIdpConfigInput,
} from './schema.js';

/**
 * Platform scope (NO tenant transaction): /api/v1/admin/tenants.
 * Guarded at the app mount by requireAuth + requirePlatformAdmin.
 */
export function adminTenantRoutes(): Router {
  const router = Router();

  router.post('/', validate({ body: createTenantSchema }), async (req, res) => {
    const input = req.body as CreateTenantInput;
    const tenant = await provisionTenant(input, {
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
    });
    res.status(201).json(tenant);
  });

  router.post(
    '/:id/suspend',
    validate({ params: tenantIdParamSchema }),
    async (req, res) => {
      await suspendTenant(req.params['id'] as string, {
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      });
      res.status(204).end();
    },
  );

  router.put(
    '/:id/idp-config',
    validate({ params: tenantIdParamSchema, body: upsertIdpConfigSchema }),
    async (req, res) => {
      const row = await upsertIdpConfig(
        req.params['id'] as string,
        req.body as UpsertIdpConfigInput,
        { ...(req.correlationId ? { correlationId: req.correlationId } : {}) },
      );
      res.json(row);
    },
  );

  return router;
}

/** Tenant scope (mounted behind devPrincipal + tenantScope): /api/v1/facilities. */
export function facilityRoutes(): Router {
  const router = Router();

  router.post(
    '/',
    requirePermission('facility.manage'),
    validate({ body: createFacilitySchema }),
    async (req, res) => {
      const facility = await createFacility(req.body as CreateFacilityInput);
      res.status(201).json(facility);
    },
  );

  router.get(
    '/',
    requirePermission('facility.view'),
    validate({ query: listFacilitiesSchema }),
    async (req, res) => {
      const facilities = await getFacilities(
        req.validatedQuery as ListFacilitiesQuery,
      );
      res.json({ facilities });
    },
  );

  return router;
}
