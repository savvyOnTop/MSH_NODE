# M1 — Tenancy, RLS & Audit Foundation

> Phase plan written before execution per working process. Progress section at bottom updated as tasks complete.
> Spec: `docs/backendMLD.md` Phase 1. Plan: `docs/implementationPlan.md`.

## Objective

The isolation + auditability substrate. Shared-DB shared-tables tenancy becomes real: first Prisma models (`Tenant` platform table; `Facility`, `AuditLog` RLS tables), migrations with hand-appended RLS (`ENABLE + FORCE`, `USING` + `WITH CHECK` on `current_setting('app.current_tenant', true)::uuid`) and `app_runtime` grants, the tenant-scope middleware that wires `runInTenant` into every HTTP request, the append-only audit writer, provisioning/facility endpoints, and the `check-rls.ts` CI gate. Ends with the adversarial isolation e2e — the highest-stakes test in the repo.

## Design notes (locked before execution)

- **Prisma layout**: single `public` schema (no Postgres `platform` schema — Prisma multi-schema adds friction, zero isolation value; "platform vs shared" is a *policy* distinction). `Tenant` has **no** `tenant_id` and **no RLS** (control plane; only `platformDb` may read it). `Facility`, `AuditLog` carry `tenant_id` + RLS + tenant-first index.
- **Migration workflow**: `npx prisma migrate dev --create-only` → hand-append per-table block from `prisma/rls.template.sql` (RLS enable/force, dual policy, grants to `app_runtime`; audit_log gets INSERT/SELECT only — no UPDATE/DELETE) → `npx prisma migrate dev` to apply. Migrations run under `DIRECT_DATABASE_URL` (owner); runtime under `app_runtime` — FORCE RLS means even owner is policy-bound, but runtime role additionally lacks BYPASSRLS.
- **Tenant-scope middleware**: reads `req.principal.tenantId` (M2 will set principal from JWT; M1 ships a dev-principal shim: `x-tenant-id` header honored only when `AUTH_DEV_MODE=true`, 401 otherwise). Verifies tenant exists + `status='active'` via `platformDb`, then wraps the rest of the pipeline in `runInTenant`: promise resolves on response `finish` (statusCode < 400 ⇒ commit, else rollback), per MLD pseudocode. Caveat (accepted, per spec): commit happens just after response flush; `afterCommit` queue keeps side effects safe.
- **Provisioning** (MLD algorithm): insert `tenant` row `status='provisioning'` via owner-privileged path, seed baseline rows inside `runInTenant(newTenantId, …)`, flip `status='active'`, `audit.record('tenant.provision')`, compensating cleanup on failure. Admin routes (`/api/v1/admin/*`) are platform-scope — dev-mode gate in M1, real super_admin authz lands in M2 (flagged in code with TODO(M2)).
- **Audit**: `audit.record()` is the sole write path to `audit_log`; stamps `tenant_id` + `correlation_id` from ALS/request context; summary must be PHI-minimized (field names, not values).

## Tasks

| # | Task | Details |
|---|------|---------|
| 1 | Models + RLS template + first migration | `Tenant`/`Facility`/`AuditLog` in schema.prisma; `prisma/rls.template.sql`; `--create-only` migration + hand-appended RLS/grants; apply; verify policies via psql |
| 2 | `scripts/check-rls.ts` CI gate | Introspects live DB: every table with `tenant_id` must have ENABLE+FORCE RLS, policy with both USING and WITH CHECK on `app.current_tenant`, ≥1 tenant-first index; `audit_log` must lack UPDATE/DELETE grants for `app_runtime`. Nonzero exit on violation. Wire into CI + `npm run check-rls` |
| 3 | Tenant-scope middleware | `src/middleware/tenant-scope.ts` + dev-principal shim; commit/rollback semantics on `finish`; 401 without principal, 403 `tenant_unavailable` for missing/suspended tenant; app.ts wiring for tenant-scoped router |
| 4 | Audit module | `modules/audit/`: `audit.record()` (tenant tx via `getTenantDb()`), `GET /api/v1/audit?resourceType&from&to` scoped list; repository is the only file touching the audit_log model |
| 5 | Tenancy module | `modules/tenancy/`: `POST /api/v1/admin/tenants` (provision per MLD algorithm), `POST /api/v1/admin/tenants/:id/suspend`, facilities CRUD (`POST`/`GET /api/v1/facilities` — tenant-scoped, Json `attributes` for virtual locations), zod schemas, OpenAPI registration |
| 6 | Adversarial isolation e2e + unit tests | e2e: no-WHERE `SELECT * FROM facility` inside Tenant-A request returns zero Tenant-B rows; foreign-tenant INSERT rejected by WITH CHECK; no residual `app.current_tenant` on pooled connection post-request; suspended tenant ⇒ 403. Unit: check-rls violation detection, audit record shape |
| 7 | Phase closeout | Lint + typecheck + unit + e2e + `check-rls` green; CI updated (migrate deploy + check-rls steps un-commented); progress.md + phase file updated |

## Exit test

Adversarial isolation e2e green (MLD Phase 1 exit): RLS alone blocks cross-tenant reads with WHERE omitted; `WITH CHECK` rejects foreign-tenant writes; pooled connection carries no residual tenant setting after request commit. `check-rls` passes against migrated DB.

---

## Progress

### ✅ 1. Database models + first migration (2026-08-04)

**Created 3 database models** in [prisma/schema.prisma](../../prisma/schema.prisma):
- `Tenant` — the registry of hospital organizations on the platform (name, status, region). Lives on the "control plane": it has no `tenant_id` and no row security, because it's the table that *defines* tenants.
- `Facility` — hospital sites within a tenant. Virtual locations (like "Floor" or "Field/FDNY") are ordinary rows with `attributes: {"kind": "virtual"}`.
- `AuditLog` — append-only compliance ledger. Every sensitive action lands here; nothing can ever update or delete a row.

**Created the RLS template** → [prisma/rls.template.sql](../../prisma/rls.template.sql). This is the copy-paste block every future migration must include for every new table.

**Migrated**: [20260804071723_init_tenancy_audit](../../prisma/migrations/20260804071723_init_tenancy_audit/migration.sql).
**Why the migration is hand-edited:** RLS is a *Postgres* feature and it is fully active — Postgres itself refuses to return another tenant's rows, even if application code has a bug. Prisma (the ORM layer on top) simply has no *syntax* in `schema.prisma` to declare policies, so each migration is generated with `--create-only` and the `CREATE POLICY` SQL is appended into the migration file, which Prisma then applies like any other SQL. Enforcement is 100% Postgres; nothing is lost. The only risk — forgetting the append on a future table — is caught by the check-rls CI gate (task 2).

**Small but important deviation from the spec:** the policy uses `NULLIF(current_setting(...), '')` instead of a plain cast. Reason: after a request finishes, the tenant setting reverts to an empty string on the pooled connection, and casting `''` to uuid crashes any unscoped query. With NULLIF, an unscoped query just returns zero rows — still safe, no crash.

**Fixed** [prisma.config.ts](../../prisma.config.ts): migrations now run as the database *owner* (`DIRECT_DATABASE_URL`); the app itself keeps running as the restricted `app_runtime` user that cannot bypass RLS.

Verified by hand in psql: a scoped query sees its own row; an unscoped query sees zero rows; inserting a row for another tenant is rejected; updating the audit log is denied.

### ✅ 2. RLS safety gate for CI (2026-08-04)

**Created** [scripts/check-rls.ts](../../scripts/check-rls.ts) (`npm run check-rls`) — a script that inspects the live database and **fails the build** if any table carrying `tenant_id` is missing its protections: row security enabled+forced, a policy covering both reads and writes, a tenant-first index, no update/delete rights on append-only tables, and a runtime DB role that can't bypass RLS.
**Why:** future migrations are hand-edited (see task 1); a forgotten RLS block would silently create a cross-tenant data leak. This gate makes that mistake impossible to merge.

Tested both directions: passes on the migrated DB, correctly fails (exit 1) when I deliberately weakened a table, passes again after restoring.

**Updated CI** → [.github/workflows/ci.yml](../../.github/workflows/ci.yml): now applies migrations, runs check-rls, and runs a schema-drift check (fails if schema.prisma and the migrations folder disagree) against a dedicated scratch database — never the real one.

### ✅ 3. Tenant-scope middleware (2026-08-04)

**Created** [src/middleware/tenant-scope.ts](../../src/middleware/tenant-scope.ts) — the piece that connects HTTP to the tenant-transaction mechanism from M0. For every request it: checks the caller's tenant exists and is active → opens one database transaction → sets `app.current_tenant` (which activates RLS) → runs the whole request inside it → commits if the response succeeded, rolls back otherwise.
**Why it matters:** this is the *single* place tenant scoping happens. Handlers and repositories can't forget it — they physically can't get a database connection any other way.

Also: request metadata (correlation id, acting user, IP) now rides along the tenant context in [src/infra/db/tenant-context.ts](../../src/infra/db/tenant-context.ts), so the audit writer can stamp entries without every caller passing those values around.

### ✅ 4. Audit module (2026-08-04)

**Created** [src/modules/audit/](../../src/modules/audit/index.ts) — `audit.record()` is the one and only way any code writes to the audit ledger; it automatically stamps tenant, actor, IP and correlation id from the request context. `GET /api/v1/audit` lists entries (filterable by action/type/date).
**PHI rule baked in:** audit summaries record field *names* ("phone was updated"), never field *values*.

**Created** [src/middleware/validate.ts](../../src/middleware/validate.ts) — zod validation at the API edge; handlers only ever see validated, typed input.

### ✅ 5. Tenancy module (2026-08-04)

**Created** [src/modules/tenancy/](../../src/modules/tenancy/index.ts):
- `POST /api/v1/admin/tenants` — provisions a new hospital org: inserts the tenant row, seeds its baseline data, flips it active. If anything fails midway it cleans up after itself, so a half-created tenant can never serve traffic.
- `POST /api/v1/admin/tenants/:id/suspend` — locks a tenant out at the front door (every request checks tenant status before opening a transaction).
- `POST` / `GET /api/v1/facilities` — facility management inside a tenant; duplicate names return a clean 409.

Verified live with curl: provision → create facility → duplicate rejected → another tenant sees none of it → audit trail shows everything with correlation ids.

### ✅ 6. Adversarial isolation test — the M1 exit test (2026-08-04)

**Created** [test/tenancy-isolation.e2e-spec.ts](../../test/tenancy-isolation.e2e-spec.ts) — 7 tests that actively try to break tenant isolation:
1. Raw `SELECT * FROM facility` with the tenant filter **deliberately omitted** → still returns only the caller's rows (RLS alone did the scoping).
2. Raw INSERT stamped with another tenant's id → rejected by the database.
3. After a request finishes, the pooled connection carries no leftover tenant setting.
4. Each tenant's facility list shows only its own facilities.
5. A suspended tenant gets 403 before touching any data.
6. The audit trail captured provisioning + facility creation, correlation-stamped.
7. A failed (409) request rolls back — nothing half-written.

### ✅ 7. Phase closeout (2026-08-04)

Everything green: lint, typecheck, unit tests 4/4, e2e 10/10, check-rls, schema drift, tenant-tx spike 7/7.

### Exit test — PASSED (2026-08-04)
RLS alone blocks cross-tenant reads even with the WHERE clause omitted; foreign-tenant writes are rejected; no tenant residue survives on pooled connections. The check-rls gate passes on the real schema and fails on induced violations.

**M1 complete.** Next: M2 (OIDC + RBAC) — see [M2-oidc-rbac.md](M2-oidc-rbac.md).
