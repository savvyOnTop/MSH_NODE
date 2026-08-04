import { Router } from 'express';
import { requirePermission } from '../../middleware/authz.js';
import { validate } from '../../middleware/validate.js';
import {
  createMembershipSchema,
  createRoleSchema,
  createUserSchema,
  effectivePermissionsQuerySchema,
  listUsersSchema,
  userIdParamSchema,
  type CreateMembershipInput,
  type CreateRoleInput,
  type CreateUserInput,
  type EffectivePermissionsQuery,
  type ListUsersQuery,
} from './schema.js';
import {
  createMembership,
  createRole,
  createUser,
  getEffectivePermissions,
  getPermissionCatalog,
  getRoles,
  getUsers,
} from './service.js';

// Mounted behind requireAuth + tenantScope.
export function identityRoutes(): Router {
  const router = Router();

  router.get('/permissions', async (_req, res) => {
    res.json({ permissions: await getPermissionCatalog() });
  });

  router.post(
    '/users',
    requirePermission('user.manage'),
    validate({ body: createUserSchema }),
    async (req, res) => {
      res.status(201).json(await createUser(req.body as CreateUserInput));
    },
  );

  router.get(
    '/users',
    requirePermission('user.view'),
    validate({ query: listUsersSchema }),
    async (req, res) => {
      res.json({ users: await getUsers(req.validatedQuery as ListUsersQuery) });
    },
  );

  router.get(
    '/users/:id/effective-permissions',
    requirePermission('user.view'),
    validate({
      params: userIdParamSchema,
      query: effectivePermissionsQuerySchema,
    }),
    async (req, res) => {
      res.json({
        permissions: await getEffectivePermissions(
          req.params['id'] as string,
          req.validatedQuery as EffectivePermissionsQuery,
        ),
      });
    },
  );

  router.post(
    '/roles',
    requirePermission('role.manage'),
    validate({ body: createRoleSchema }),
    async (req, res) => {
      res.status(201).json(await createRole(req.body as CreateRoleInput));
    },
  );

  router.get('/roles', requirePermission('user.view'), async (_req, res) => {
    res.json({ roles: await getRoles() });
  });

  router.post(
    '/memberships',
    requirePermission('user.manage'),
    validate({ body: createMembershipSchema }),
    async (req, res) => {
      res
        .status(201)
        .json(await createMembership(req.body as CreateMembershipInput));
    },
  );

  return router;
}
