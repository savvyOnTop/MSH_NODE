import {
  currentTenantId,
  getTenantDb,
  platformDb,
} from '../../infra/db/index.js';
import type {
  CreateMembershipInput,
  CreateRoleInput,
  CreateUserInput,
  ListUsersQuery,
} from './schema.js';

const userSelect = {
  id: true,
  email: true,
  name: true,
  phoneE164: true,
  status: true,
  isPlatformAdmin: true,
  createdAt: true,
} as const;

/**
 * Effective permissions (backendMLD Phase 2): union over memberships whose
 * scope matches. NO scope given ⇒ only tenant-wide memberships (facility_id /
 * workflow_def_id NULL) count — a facility-scoped grant never leaks outside it.
 */
export async function queryEffectivePermissions(
  userId: string,
  facilityId?: string,
  workflowDefId?: string,
): Promise<Set<string>> {
  const memberships = await getTenantDb().membership.findMany({
    where: {
      userId,
      AND: [
        {
          OR: [{ facilityId: null }, ...(facilityId ? [{ facilityId }] : [])],
        },
        {
          OR: [
            { workflowDefId: null },
            ...(workflowDefId ? [{ workflowDefId }] : []),
          ],
        },
      ],
    },
    select: {
      role: { select: { permissions: { select: { permission: true } } } },
    },
  });
  const set = new Set<string>();
  for (const m of memberships)
    for (const p of m.role.permissions) set.add(p.permission);
  return set;
}

export async function userById(id: string) {
  return getTenantDb().appUser.findUnique({
    where: { id },
    select: userSelect,
  });
}

export async function insertUser(input: CreateUserInput) {
  return getTenantDb().appUser.create({
    data: {
      tenantId: currentTenantId(),
      // Admin-created users bind to the IdP on first SSO login by email match;
      // until then the subject is a placeholder no IdP will ever assert.
      idpSubject: `pending:${input.email}`,
      email: input.email,
      name: input.name,
      phoneE164: input.phoneE164 ?? null,
    },
    select: userSelect,
  });
}

export async function listUsers(q: ListUsersQuery) {
  return getTenantDb().appUser.findMany({
    where: q.status ? { status: q.status } : {},
    orderBy: { name: 'asc' },
    select: userSelect,
  });
}

export async function insertRole(input: CreateRoleInput) {
  const tenantId = currentTenantId();
  const db = getTenantDb();
  const role = await db.role.create({
    data: {
      tenantId,
      code: input.code,
      name: input.name,
      workflowDefId: input.workflowDefId ?? null,
      permissions: {
        create: input.permissions.map((permission) => ({
          tenantId,
          permission,
        })),
      },
    },
    select: { id: true, code: true, name: true, workflowDefId: true },
  });
  return { ...role, permissions: input.permissions };
}

export async function listRoles() {
  return getTenantDb().role.findMany({
    orderBy: { code: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      workflowDefId: true,
      permissions: { select: { permission: true } },
    },
  });
}

export async function insertMembership(input: CreateMembershipInput) {
  return getTenantDb().membership.create({
    data: {
      tenantId: currentTenantId(),
      userId: input.userId,
      roleId: input.roleId,
      facilityId: input.facilityId ?? null,
      workflowDefId: input.workflowDefId ?? null,
    },
    select: {
      id: true,
      userId: true,
      roleId: true,
      facilityId: true,
      workflowDefId: true,
    },
  });
}

/** Global catalog (platform table — readable without tenant context). */
export async function listPermissionCatalog(): Promise<
  { code: string; description: string }[]
> {
  return platformDb.$queryRaw<{ code: string; description: string }[]>`
    SELECT code, description FROM permission ORDER BY code`;
}
