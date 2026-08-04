import express, { type Express } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { requireAuth } from './middleware/auth.js';
import { requirePermission, requirePlatformAdmin } from './middleware/authz.js';
import { correlation, httpLogger } from './middleware/correlation.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { tenantScope } from './middleware/tenant-scope.js';
import { identityRoutes } from './modules/identity/index.js';
import { healthRoutes } from './health/routes.js';
import { auditRoutes } from './modules/audit/index.js';
import { authRoutes } from './modules/auth/index.js';
import { adminTenantRoutes, facilityRoutes } from './modules/tenancy/index.js';
import { generateOpenApiDocument } from './openapi/registry.js';

// Composition root. Middleware order is load-bearing (backendMLD Phase 0):
// correlation → [auth → tenant-scope → authz → validate]* → handler → error.
// (*) auth/tenant/authz middlewares arrive in M1/M2 and slot between here and the routers.
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(correlation);
  app.use(httpLogger);

  app.use('/api/v1', healthRoutes());

  // Public auth surface: no principal required (login/callback/refresh/dev-token).
  app.use('/api/v1/auth', authRoutes());

  // Platform-admin surface: NO tenant tx (control plane), guarded by
  // app_user.is_platform_admin read via the principal's own tenant context.
  app.use(
    '/api/v1/admin/tenants',
    requireAuth,
    requirePlatformAdmin,
    adminTenantRoutes(),
  );

  // Tenant-scoped surface: JWT auth → tenant tx → permission gates.
  app.use(
    '/api/v1/audit',
    requireAuth,
    tenantScope,
    requirePermission('audit.read'),
    auditRoutes(),
  );
  app.use('/api/v1/facilities', requireAuth, tenantScope, facilityRoutes());
  app.use('/api/v1', requireAuth, tenantScope, identityRoutes());

  const openApiDoc = generateOpenApiDocument();
  app.get('/docs/openapi.json', (_req, res) => {
    res.json(openApiDoc);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDoc));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
