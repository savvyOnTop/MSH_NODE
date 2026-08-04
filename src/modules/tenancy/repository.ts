import { currentTenantId, getTenantDb } from '../../infra/db/index.js';
import type { CreateFacilityInput, ListFacilitiesQuery } from './schema.js';

const facilitySelect = {
  id: true,
  name: true,
  timezone: true,
  status: true,
  address: true,
  attributes: true,
  createdAt: true,
} as const;

export async function insertFacility(input: CreateFacilityInput) {
  return getTenantDb().facility.create({
    data: {
      tenantId: currentTenantId(),
      name: input.name,
      timezone: input.timezone,
      address: (input.address ?? undefined) as never,
      attributes: (input.attributes ?? undefined) as never,
    },
    select: facilitySelect,
  });
}

export async function listFacilities(q: ListFacilitiesQuery) {
  return getTenantDb().facility.findMany({
    where: q.status ? { status: q.status } : {},
    orderBy: { name: 'asc' },
    select: facilitySelect,
  });
}
