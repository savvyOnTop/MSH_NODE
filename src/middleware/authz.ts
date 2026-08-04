import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getTenantDb, runInTenant } from '../infra/db/index.js';
import { queryEffectivePermissions } from '../modules/identity/repository.js';
import { errors } from './error.js';

// Authz middleware (backendMLD Phase 2). Chain position:
// correlation → auth → tenant-scope → AUTHZ → validate → handler.
// Permissions are resolved from the DB inside the tenant tx on every request —
// nothing is baked into tokens, so revocation is immediate.

export interface AuthzScope {
  facilityId?: string;
  workflowDefId?: string;
}

export type ScopeFrom = (req: Request) => AuthzScope;

/** Default scope extractor: facility/workflow ids from query or body when present. */
const defaultScope: ScopeFrom = (req) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const q = req.query as Record<string, unknown>;
  const pick = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  const facilityId = pick(body['facilityId']) ?? pick(q['facilityId']);
  const workflowDefId = pick(body['workflowDefId']) ?? pick(q['workflowDefId']);
  return {
    ...(facilityId ? { facilityId } : {}),
    ...(workflowDefId ? { workflowDefId } : {}),
  };
};

/**
 * Gate a route on a permission code. MUST be mounted after requireAuth +
 * tenantScope (needs principal.userId and the tenant tx). A platform admin
 * (app_user.is_platform_admin) passes every gate — that's the bootstrap path
 * for tenants with no roles yet.
 */
export function requirePermission(
  permission: string,
  scopeFrom: ScopeFrom = defaultScope,
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const userId = req.principal?.userId;
    if (!userId) {
      next(errors.unauthorized());
      return;
    }
    void (async () => {
      const user = await getTenantDb().appUser.findUnique({
        where: { id: userId },
        select: { status: true, isPlatformAdmin: true },
      });
      if (!user || user.status !== 'active') {
        throw errors.forbidden('user_unavailable');
      }
      if (user.isPlatformAdmin) return; // bootstrap/platform override
      const scope = scopeFrom(req);
      const perms = await queryEffectivePermissions(
        userId,
        scope.facilityId,
        scope.workflowDefId,
      );
      if (!perms.has(permission)) {
        throw errors.forbidden('missing_permission');
      }
    })()
      .then(() => {
        next();
      })
      .catch((err: unknown) => {
        next(err);
      });
  };
}

/**
 * Platform-admin gate for the control-plane surface (/api/v1/admin/*).
 * Runs OUTSIDE tenantScope (admin routes have no tenant tx), so it opens its
 * own tenant context on the principal's home tenant to read the flag.
 */
export function requirePlatformAdmin(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const principal = req.principal;
  if (!principal?.userId) {
    next(errors.unauthorized());
    return;
  }
  runInTenant(principal.tenantId, async () => {
    const user = await getTenantDb().appUser.findUnique({
      where: { id: principal.userId as string },
      select: { status: true, isPlatformAdmin: true },
    });
    if (!user || user.status !== 'active' || !user.isPlatformAdmin) {
      throw errors.forbidden('platform_admin_required');
    }
  })
    .then(() => {
      next();
    })
    .catch((err: unknown) => {
      next(err);
    });
}
