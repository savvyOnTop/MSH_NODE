// Public interface of the tenancy module (control-plane tenant lifecycle +
// tenant-scoped facilities).
export { adminTenantRoutes, facilityRoutes } from './routes.js';
export { provisionTenant, suspendTenant } from './service.js';
