/**
 * CI gate — RLS policy completeness (backendMLD.md Phase 1 deep-dive).
 *
 * In shared-DB shared-tables tenancy, RLS is the only thing standing between a
 * buggy query and a cross-tenant PHI leak. This script fails (exit 1) if any
 * table carrying `tenant_id` lacks:
 *   1. ENABLE + FORCE row level security
 *   2. a policy with BOTH `USING` and `WITH CHECK` referencing app.current_tenant
 *   3. at least one index whose FIRST column is tenant_id
 * plus:
 *   4. append-only tables must not grant UPDATE/DELETE to app_runtime
 *   5. the runtime role must exist, be non-superuser, and lack BYPASSRLS
 *
 * Runs under the OWNER url (introspection needs catalog visibility).
 */
import 'dotenv/config';
import pg from 'pg';

const APPEND_ONLY_TABLES = ['audit_log', 'case_event'];
const RUNTIME_ROLE = 'app_runtime';

const url = process.env['DIRECT_DATABASE_URL'];
if (!url) {
  console.error('DIRECT_DATABASE_URL not set');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
let violations = 0;

function violation(table: string, rule: string): void {
  console.error(`❌ ${table}: ${rule}`);
  violations += 1;
}

async function main(): Promise<void> {
  await client.connect();

  const { rows: tables } = await client.query<{ table_name: string }>(
    `SELECT c.table_name
       FROM information_schema.columns c
       JOIN pg_class pc ON pc.relname = c.table_name
       JOIN pg_namespace n ON n.oid = pc.relnamespace AND n.nspname = 'public'
      WHERE c.table_schema = 'public'
        AND c.column_name = 'tenant_id'
        AND pc.relkind = 'r'
      ORDER BY 1`,
  );

  if (tables.length === 0) {
    console.error('❌ no tenant_id tables found — wrong database?');
    process.exit(1);
  }

  for (const { table_name: table } of tables) {
    // 1. ENABLE + FORCE
    const { rows: rls } = await client.query<{ rls: boolean; force: boolean }>(
      `SELECT relrowsecurity AS rls, relforcerowsecurity AS force
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = $1`,
      [table],
    );
    if (!rls[0]?.rls) violation(table, 'row level security not ENABLEd');
    if (!rls[0]?.force) violation(table, 'row level security not FORCEd');

    // 2. dual policy on app.current_tenant
    const { rows: policies } = await client.query<{
      qual: string | null;
      with_check: string | null;
    }>(
      `SELECT qual, with_check FROM pg_policies
        WHERE schemaname = 'public' AND tablename = $1`,
      [table],
    );
    const ok = policies.some(
      (p) =>
        p.qual?.includes('app.current_tenant') &&
        p.with_check?.includes('app.current_tenant'),
    );
    if (!ok)
      violation(
        table,
        'no policy with BOTH USING and WITH CHECK on app.current_tenant',
      );

    // 3. tenant-first index
    const { rows: idx } = await client.query<{ n: string }>(
      `SELECT i.relname AS n
         FROM pg_index x
         JOIN pg_class t ON t.oid = x.indrelid
         JOIN pg_class i ON i.oid = x.indexrelid
         JOIN pg_namespace ns ON ns.oid = t.relnamespace AND ns.nspname = 'public'
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = x.indkey[0]
        WHERE t.relname = $1 AND a.attname = 'tenant_id'`,
      [table],
    );
    if (idx.length === 0) violation(table, 'no index leading with tenant_id');

    // 4. append-only grant check
    if (APPEND_ONLY_TABLES.includes(table)) {
      const { rows: grants } = await client.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.role_table_grants
          WHERE table_schema = 'public' AND table_name = $1 AND grantee = $2
            AND privilege_type IN ('UPDATE','DELETE')`,
        [table, RUNTIME_ROLE],
      );
      for (const g of grants)
        violation(
          table,
          `append-only table grants ${g.privilege_type} to ${RUNTIME_ROLE}`,
        );
    }
  }

  // 5. runtime role hygiene
  const { rows: role } = await client.query<{
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1`, [
    RUNTIME_ROLE,
  ]);
  if (role.length === 0) violation(RUNTIME_ROLE, 'runtime role missing');
  if (role[0]?.rolsuper) violation(RUNTIME_ROLE, 'runtime role is SUPERUSER');
  if (role[0]?.rolbypassrls)
    violation(RUNTIME_ROLE, 'runtime role has BYPASSRLS');

  await client.end();

  if (violations > 0) {
    console.error(
      `\n${violations} RLS violation(s) — every one is a potential cross-tenant PHI leak.`,
    );
    process.exit(1);
  }
  console.log(
    `✅ check-rls: ${tables.length} tenant table(s) compliant (${tables.map((t) => t.table_name).join(', ')})`,
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
