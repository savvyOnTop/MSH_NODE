import type { NextFunction, Request, Response } from 'express';
import { config } from '../infra/config/index.js';
import { platformDb, runInTenant } from '../infra/db/index.js';
import { errors } from './error.js';

// Tenant-scope middleware (backendMLD Phase 1). Wraps the REST of the request
// pipeline in runInTenant: one interactive transaction, first statement
// set_config('app.current_tenant', $1, true), COMMIT when the response finishes
// with status < 400, ROLLBACK otherwise (or on client abort). Every repository
// call downstream reaches the scoped tx via getTenantDb().

export interface Principal {
  tenantId: string;
  userId?: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * M1 dev shim — TODO(M2): replaced by the real auth middleware (JWT verify →
 * req.principal from `sub`/`tid` claims; this shim folds into the dev-token issuer).
 * Honors `x-tenant-id` (+ optional `x-user-id`) ONLY when AUTH_DEV_MODE=true;
 * config refuses AUTH_DEV_MODE in production, so this can never run there.
 */
export function devPrincipal(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (config.AUTH_DEV_MODE && !req.principal) {
    const tenantId = req.header('x-tenant-id');
    if (tenantId) {
      const userId = req.header('x-user-id');
      req.principal = { tenantId, ...(userId ? { userId } : {}) };
    }
  }
  next();
}

/** Rejection sentinel: response finished ≥400 (or aborted) → roll the tx back. */
class RollbackSignal extends Error {
  constructor() {
    super('tenant-scope-rollback');
    this.name = 'RollbackSignal';
  }
}
const ROLLBACK = new RollbackSignal();

export function tenantScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const principal = req.principal;
  if (!principal) {
    next(errors.unauthorized());
    return;
  }
  if (!UUID_RE.test(principal.tenantId)) {
    next(errors.unauthorized('invalid_tenant'));
    return;
  }

  void (async () => {
    const tenant = await platformDb.tenantById(principal.tenantId);
    if (!tenant || tenant.status !== 'active') {
      next(errors.forbidden('tenant_unavailable'));
      return;
    }

    const meta = {
      ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      ...(principal.userId ? { actorUserId: principal.userId } : {}),
      ...(req.ip ? { ip: req.ip } : {}),
    };
    await runInTenant(
      principal.tenantId,
      () => {
        return new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (ok: boolean): void => {
            if (settled) return;
            settled = true;
            if (ok) resolve();
            else reject(ROLLBACK);
          };
          // COMMIT/ROLLBACK decided when the response is done. Trade-off (per
          // MLD pseudocode): commit lands just after the response flushes; a
          // commit failure after a 2xx is logged loudly by the catch below.
          res.on('finish', () => {
            settle(res.statusCode < 400);
          });
          // Client aborted before a response was produced → roll back.
          res.on('close', () => {
            settle(res.writableFinished && res.statusCode < 400);
          });
          next();
        });
      },
      meta,
    );
  })().catch((err: unknown) => {
    if (err === ROLLBACK) return; // response already sent; tx rolled back as intended
    if (res.headersSent) {
      // Committed-response/transaction mismatch — surface loudly, never swallow.
      req.log?.error({ err }, 'tenant transaction failed after response sent');
      return;
    }
    next(err);
  });
}
