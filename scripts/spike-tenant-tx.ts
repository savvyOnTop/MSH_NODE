/**
 * M0.6 spike — proves the ALS tenant-transaction mechanism works on Prisma 7:
 *  1. set_config('app.current_tenant', ..., true) is visible to queries inside the tx
 *  2. ALS context survives across awaits (getTenantDb usable deep in async call chains)
 *  3. the setting does NOT leak onto the pooled connection after commit
 *  4. getTenantDb() outside runInTenant throws
 *  5. afterCommit effects run exactly once after commit, never after rollback
 *  6. concurrent runInTenant calls see only their own tenant id (no cross-talk)
 */
import {
  runInTenant,
  getTenantDb,
  currentTenantId,
  afterCommit,
  pingDb,
  disconnectDb,
  platformDb,
} from '../src/infra/db/index.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

let failures = 0;
function check(name: string, ok: boolean, extra?: unknown): void {
  console.log(
    `${ok ? '✅' : '❌'} ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`,
  );
  if (!ok) failures += 1;
}

async function readSettingInTx(): Promise<string | null> {
  const rows = await getTenantDb().$queryRaw<
    { v: string | null }[]
  >`SELECT current_setting('app.current_tenant', true) AS v`;
  return rows[0]?.v ?? null;
}

async function main(): Promise<void> {
  await pingDb();

  // 1 + 2: visible inside tx, across awaits and nested async frames
  await runInTenant(TENANT_A, async () => {
    const direct = await readSettingInTx();
    check('set_config visible inside tx', direct === TENANT_A, direct);

    await new Promise((r) => setTimeout(r, 10)); // cross an async boundary
    const nested = await (async () => readSettingInTx())();
    check(
      'ALS survives awaits/nesting',
      nested === TENANT_A && currentTenantId() === TENANT_A,
    );
  });

  // 3: no residue on the pool after commit
  const after = await platformDb.$queryRaw<
    { v: string | null }[]
  >`SELECT current_setting('app.current_tenant', true) AS v`;
  const residue = after[0]?.v ?? null;
  check(
    'no residual setting after commit',
    residue === null || residue === '',
    residue,
  );

  // 4: unusable outside context
  try {
    getTenantDb();
    check('getTenantDb throws outside context', false);
  } catch {
    check('getTenantDb throws outside context', true);
  }

  // 5: afterCommit on success, not on rollback
  let ranOnCommit = 0;
  await runInTenant(TENANT_A, () => {
    afterCommit(() => {
      ranOnCommit += 1;
    });
    return Promise.resolve();
  });
  check('afterCommit runs once post-commit', ranOnCommit === 1, ranOnCommit);

  let ranOnRollback = 0;
  await runInTenant(TENANT_A, () => {
    afterCommit(() => {
      ranOnRollback += 1;
    });
    return Promise.reject(new Error('force rollback'));
  }).catch(() => undefined);
  check('afterCommit skipped on rollback', ranOnRollback === 0, ranOnRollback);

  // 6: concurrent isolation
  const [a, b] = await Promise.all([
    runInTenant(TENANT_A, async () => {
      await new Promise((r) => setTimeout(r, 25));
      return readSettingInTx();
    }),
    runInTenant(TENANT_B, async () => readSettingInTx()),
  ]);
  check('concurrent tx see own tenant only', a === TENANT_A && b === TENANT_B, {
    a,
    b,
  });

  await disconnectDb();
  if (failures > 0) {
    console.error(`\n${failures} spike check(s) FAILED`);
    process.exit(1);
  }

  console.log('\nAll spike checks passed — mechanism is go for M1.');
}

void main();
