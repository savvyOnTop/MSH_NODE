// Public interface of the identity module (users, roles, memberships, RBAC).
export { identityRoutes } from './routes.js';
export { queryEffectivePermissions } from './repository.js';
export { getEffectivePermissions, seedBaselineRoles } from './service.js';
