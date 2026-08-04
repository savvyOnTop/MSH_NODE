import {
  getTenantDb,
  isUniqueViolation,
  platformDb,
  runInTenant,
} from '../../infra/db/index.js';
import { logger } from '../../infra/logger/index.js';
import { errors } from '../../middleware/error.js';
import { audit } from '../audit/index.js';
import { seedBaselineRoles } from '../identity/index.js';
import { insertFacility, listFacilities } from './repository.js';
import type {
  CreateFacilityInput,
  CreateTenantInput,
  ListFacilitiesQuery,
  UpsertIdpConfigInput,
} from './schema.js';

/**
 * MLD Phase 1 provisioning algorithm. Shared-DB mode: no schema/database is
 * created — insert a control-plane row, seed baseline tenant data, flip active.
 * Compensating cleanup on failure so a half-provisioned tenant never serves.
 */
export async function provisionTenant(
  input: CreateTenantInput,
  meta: { correlationId?: string; actorUserId?: string } = {},
): Promise<{ id: string; name: string; status: string }> {
  const { id } = await platformDb.createTenant({
    name: input.name,
    region: input.region,
    status: 'provisioning',
  });

  try {
    await runInTenant(
      id,
      async () => {
        await seedBaselineRoles(); // TENANT_ADMIN with the full catalog
        await audit.record({
          action: 'tenant.provision',
          resourceType: 'tenant',
          resourceId: id,
          summary: { name: input.name, region: input.region },
        });
      },
      meta,
    );
    await platformDb.setTenantStatus(id, 'active');
  } catch (err) {
    logger.error(
      { err, tenantId: id },
      'tenant provisioning failed — cleaning up',
    );
    await platformDb.deleteTenant(id).catch((cleanupErr: unknown) => {
      logger.error(
        { err: cleanupErr, tenantId: id },
        'provisioning cleanup failed',
      );
    });
    throw err;
  }

  return { id, name: input.name, status: 'active' };
}

export async function suspendTenant(
  id: string,
  meta: { correlationId?: string; actorUserId?: string } = {},
): Promise<void> {
  const tenant = await platformDb.tenantById(id);
  if (!tenant) throw errors.notFound('tenant_not_found');
  await platformDb.setTenantStatus(id, 'suspended');
  // Audit rides the suspended tenant's own ledger (status no longer gates writes here
  // because suspension is checked at request admission, not inside the tx).
  await runInTenant(
    id,
    () =>
      audit.record({
        action: 'tenant.suspend',
        resourceType: 'tenant',
        resourceId: id,
      }),
    meta,
  );
}

/** Upsert the tenant's IdP config (one active OIDC config per tenant for MVP). */
export async function upsertIdpConfig(
  tenantId: string,
  input: UpsertIdpConfigInput,
  meta: { correlationId?: string; actorUserId?: string } = {},
) {
  const tenant = await platformDb.tenantById(tenantId);
  if (!tenant) throw errors.notFound('tenant_not_found');
  return runInTenant(
    tenantId,
    async () => {
      const db = getTenantDb();
      const existing = await db.idpConfig.findFirst({
        where: { protocol: 'oidc' },
        select: { id: true },
      });
      const data = {
        issuerUrl: input.issuerUrl,
        clientId: input.clientId,
        clientSecretRef: input.clientSecretRef,
        scopes: input.scopes,
        enabled: input.enabled,
      };
      const row = existing
        ? await db.idpConfig.update({ where: { id: existing.id }, data })
        : await db.idpConfig.create({
            data: { ...data, tenantId, protocol: 'oidc' },
          });
      await audit.record({
        action: existing ? 'idp_config.update' : 'idp_config.create',
        resourceType: 'idp_config',
        resourceId: row.id,
        summary: { issuerUrl: input.issuerUrl, clientId: input.clientId },
      });
      const { clientSecretRef, ...safe } = row;
      return { ...safe, clientSecretRef };
    },
    meta,
  );
}

export async function createFacility(input: CreateFacilityInput) {
  try {
    const facility = await insertFacility(input);
    await audit.record({
      action: 'facility.create',
      resourceType: 'facility',
      resourceId: facility.id,
      summary: { name: facility.name },
    });
    return facility;
  } catch (err) {
    if (isUniqueViolation(err)) throw errors.conflict('facility_exists');
    throw err;
  }
}

export async function getFacilities(q: ListFacilitiesQuery) {
  return listFacilities(q);
}
