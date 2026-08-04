import { AsyncLocalStorage } from 'node:async_hooks';
import type { Prisma } from '../../generated/prisma/client.js';
import { errors } from '../../middleware/error.js';

// The single unbypassable tenant-scoping mechanism (backendMLD Phase 1):
// one interactive transaction per request/job, `set_config('app.current_tenant', $1, true)`
// as its first statement (transaction-local — auto-resets at COMMIT/ROLLBACK so a pooled
// connection can never leak a stale tenant into the next request), and the transaction
// client carried in AsyncLocalStorage so no code path can grab an unscoped connection.

export type TenantDb = Prisma.TransactionClient;

/** Request/job metadata riding the tenant context — consumed by audit.record(). */
export interface TenantContextMeta {
  correlationId?: string;
  actorUserId?: string;
  ip?: string;
}

export interface TenantStore {
  tx: TenantDb;
  tenantId: string;
  /** Side effects (queue enqueues, domain events) deferred until AFTER commit. */
  afterCommit: Array<() => void | Promise<void>>;
  meta: TenantContextMeta;
}

export const tenantAls = new AsyncLocalStorage<TenantStore>();

/** The tenant-scoped transaction client. Throws outside runInTenant — by design. */
export function getTenantDb(): TenantDb {
  const store = tenantAls.getStore();
  if (!store) {
    throw errors.internal('tenant_context_missing');
  }
  return store.tx;
}

export function currentTenantId(): string {
  const store = tenantAls.getStore();
  if (!store) {
    throw errors.internal('tenant_context_missing');
  }
  return store.tenantId;
}

/** Correlation/actor/ip of the surrounding request or job ({} outside HTTP). */
export function currentMeta(): TenantContextMeta {
  const store = tenantAls.getStore();
  if (!store) {
    throw errors.internal('tenant_context_missing');
  }
  return store.meta;
}

/**
 * Defer a side effect until the surrounding tenant transaction commits.
 * Jobs/events must never observe uncommitted rows; on rollback these never run.
 */
export function afterCommit(effect: () => void | Promise<void>): void {
  const store = tenantAls.getStore();
  if (!store) {
    throw errors.internal('tenant_context_missing');
  }
  store.afterCommit.push(effect);
}
