// The ONLY module allowed to touch the generated Prisma client (ESLint-enforced).
// Everything outside gets data access via getTenantDb() / runInTenant / platformDb —
// the single unbypassable tenant-scoping mechanism (CLAUDE.md invariant #2).
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';
import { tenantAls, type TenantStore } from './tenant-context.js';

export {
  getTenantDb,
  currentTenantId,
  currentMeta,
  afterCommit,
  type TenantDb,
  type TenantContextMeta,
} from './tenant-context.js';
import type { TenantContextMeta } from './tenant-context.js';

// Private: never export this. Runtime DB role is app_runtime (non-owner, NOBYPASSRLS),
// so even a leaked unscoped query returns zero rows under FORCE RLS.
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: config.DATABASE_URL }),
  transactionOptions: { maxWait: 5_000, timeout: 15_000 },
});

/**
 * Run `fn` inside a tenant-scoped interactive transaction.
 *
 * - First statement: SET LOCAL app.current_tenant (via set_config(..., true)) — drives RLS,
 *   auto-resets at COMMIT/ROLLBACK, so pooled connections never carry residue.
 * - The transaction client rides AsyncLocalStorage: all repository code reaches it through
 *   getTenantDb(), never a raw connection.
 * - afterCommit effects flush only after a successful COMMIT (never on rollback).
 *
 * Used by the HTTP tenant-scope middleware (M1) and by every queue worker / webhook /
 * websocket handler (they run outside HTTP middleware and MUST wrap DB work in this).
 */
export async function runInTenant<T>(
  tenantId: string,
  fn: () => Promise<T>,
  meta: TenantContextMeta = {},
): Promise<T> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      tenantId,
    )
  ) {
    throw new Error('runInTenant: tenantId must be a UUID');
  }
  const store: TenantStore = {
    tx: undefined as never,
    tenantId,
    afterCommit: [],
    meta,
  };

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    store.tx = tx;
    return tenantAls.run(store, fn);
  });

  // COMMIT succeeded — flush deferred side effects (enqueues, domain events).
  for (const effect of store.afterCommit) {
    try {
      await effect();
    } catch (err) {
      // A failed side effect must not fail the already-committed request;
      // it is logged and (for queues) retried by the outbox/reconciler pattern.
      logger.error({ err, tenantId }, 'after-commit effect failed');
    }
  }
  return result;
}

/**
 * Narrow, deliberately-limited access for tenant-AGNOSTIC control-plane reads
 * (pre-auth tenant lookup, permission catalog, idp config discovery).
 * Grows explicit methods in M1/M2 — never a general escape hatch.
 */
export const platformDb = {
  $queryRaw: <T = unknown>(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T> => prisma.$queryRaw(query, ...values),

  /** Pre-scope tenant lookup for the tenant-scope middleware (control plane, no RLS). */
  tenantById: (
    id: string,
  ): Promise<{ id: string; name: string; status: string } | null> =>
    prisma.tenant.findUnique({
      where: { id },
      select: { id: true, name: true, status: true },
    }),

  /** Provisioning (tenancy module only): insert control-plane tenant row. */
  createTenant: (data: {
    name: string;
    region: string;
    status: 'provisioning';
  }): Promise<{ id: string }> =>
    prisma.tenant.create({ data, select: { id: true } }),

  setTenantStatus: (
    id: string,
    status: 'active' | 'suspended',
  ): Promise<void> =>
    prisma.tenant
      .update({ where: { id }, data: { status } })
      .then(() => undefined),

  /** Compensating cleanup when provisioning fails mid-flight. */
  deleteTenant: (id: string): Promise<void> =>
    prisma.tenant.delete({ where: { id } }).then(() => undefined),
};

/** Map Prisma unique-constraint violations to domain 409s without leaking the client. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/** Phase 0 exit test hook: SELECT 1 through the pool. */
export async function pingDb(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect();
}

export { Prisma };
