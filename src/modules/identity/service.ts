import { isUniqueViolation } from '../../infra/db/index.js';
import { errors } from '../../middleware/error.js';
import { audit } from '../audit/index.js';
import {
  insertMembership,
  insertRole,
  insertUser,
  listPermissionCatalog,
  listRoles,
  listUsers,
  queryEffectivePermissions,
  userById,
} from './repository.js';
import type {
  CreateMembershipInput,
  CreateRoleInput,
  CreateUserInput,
  EffectivePermissionsQuery,
  ListUsersQuery,
} from './schema.js';

export async function createUser(input: CreateUserInput) {
  try {
    const user = await insertUser(input);
    await audit.record({
      action: 'user.create',
      resourceType: 'app_user',
      resourceId: user.id,
      summary: { fields: Object.keys(input) }, // field names, never values
    });
    return user;
  } catch (err) {
    if (isUniqueViolation(err)) throw errors.conflict('user_exists');
    throw err;
  }
}

export const getUsers = (q: ListUsersQuery) => listUsers(q);

export async function createRole(input: CreateRoleInput) {
  // Every requested permission must exist in the fixed platform catalog —
  // roles can only SELECT from it, never extend it (backendMLD Phase 2).
  const catalog = new Set((await listPermissionCatalog()).map((p) => p.code));
  const unknown = input.permissions.filter((p) => !catalog.has(p));
  if (unknown.length > 0) {
    throw errors.badRequest('unknown_permission_codes', { unknown });
  }
  try {
    const role = await insertRole(input);
    await audit.record({
      action: 'role.create',
      resourceType: 'role',
      resourceId: role.id,
      summary: { code: input.code, permissions: input.permissions },
    });
    return role;
  } catch (err) {
    if (isUniqueViolation(err)) throw errors.conflict('role_exists');
    throw err;
  }
}

export const getRoles = () => listRoles();

export async function createMembership(input: CreateMembershipInput) {
  const user = await userById(input.userId);
  if (!user) throw errors.notFound('user_not_found');
  try {
    const membership = await insertMembership(input);
    await audit.record({
      action: 'membership.create',
      resourceType: 'membership',
      resourceId: membership.id,
      summary: {
        userId: input.userId,
        roleId: input.roleId,
        facilityId: input.facilityId ?? 'all',
        workflowDefId: input.workflowDefId ?? 'all',
      },
    });
    return membership;
  } catch (err) {
    if (isUniqueViolation(err)) throw errors.conflict('membership_exists');
    throw err;
  }
}

export async function getEffectivePermissions(
  userId: string,
  q: EffectivePermissionsQuery,
): Promise<string[]> {
  const user = await userById(userId);
  if (!user) throw errors.notFound('user_not_found');
  const set = await queryEffectivePermissions(
    userId,
    q.facilityId,
    q.workflowDefId,
  );
  return [...set].sort();
}

export const getPermissionCatalog = () => listPermissionCatalog();

/**
 * Baseline RBAC seed for a fresh tenant (called from tenant provisioning,
 * inside the new tenant's context): TENANT_ADMIN role holding the full
 * catalog. Memberships are granted by a platform admin afterwards.
 */
export async function seedBaselineRoles(): Promise<void> {
  const catalog = (await listPermissionCatalog()).map((p) => p.code);
  await insertRole({
    code: 'TENANT_ADMIN',
    name: 'Tenant Administrator',
    permissions: catalog,
  });
}
