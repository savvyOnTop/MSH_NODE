# M0 — Foundation & Re-scaffold (Express)

> Phase plan written before execution per working process. Progress section at bottom updated as tasks complete.

## Objective

Replace the NestJS scaffold with a deployable Express 5 + TypeScript (ESM) skeleton where compliance and operability are inherited, not retrofitted (backendMLD.md Phase 0): correlation-id logging with PHI scrubber, single error shape, zod-validated config, secrets adapter, health check through the PG pool, Swagger, docker-compose dev environment, and a working spike of the AsyncLocalStorage tenant-transaction mechanism against Prisma 7.

## Tasks

| # | Task | Details |
|---|------|---------|
| 1 | Rewrite CLAUDE.md + create progress.md | New stack, spec-of-record pointers, commands, tenancy invariants, working-process rules |
| 2 | Re-scaffold package/tooling | Remove NestJS deps + files (src/app.*, nest-cli.json, tsconfig.build.json, test/ boilerplate, dist/); new package.json (ESM, `dev`=tsx watch, `build`=tsc, jest), strict tsconfig, eslint flat config with `no-restricted-imports` on `generated/prisma`, install new deps |
| 3 | Dev environment | docker-compose.yml: postgres:16 (+ app_runtime bootstrap), redis:7, keycloak:26 (realm import), minio; .env.example with all M0 keys |
| 4 | Infra base | `src/infra/logger` (pino + PHI scrubber), `src/infra/config` (zod env), `src/infra/secrets` (env-backed adapter), `src/infra/redis` (ioredis factory) |
| 5 | Express skeleton | `src/app.ts` + `src/server.ts`, correlation middleware, ApiError + error handler (`{code,message,details}`, no stacks/PHI), `GET /api/v1/health` (pg SELECT 1 + redis ping), Swagger UI at `/docs` (zod-to-openapi registry) |
| 6 | Prisma + ALS tenant-tx spike | `src/infra/db`: private PrismaClient, ALS store, `runInTenant(tenantId, fn)` with `set_config('app.current_tenant',$1,true)` first statement + after-commit queue, `getTenantDb()` throws outside context. Spike test proves: set_config visible to queries in same tx, resets after, works with Prisma 7 `prisma-client` generator |
| 7 | Tests + CI | jest ESM config, supertest e2e: health 200 + correlated structured log line; GitHub Actions: lint, typecheck, unit, e2e (pg+redis services) |

## User-action item (long lead — start now)

**Epic sandbox registration**: create account at https://fhir.epic.com → Build Apps → new app, audience "Backend Systems", APIs: Patient.Read/Search (R4), Observation.Search (Vitals) (R4). Needs RSA-2048 keypair public key or JWKS URL. Client ID propagates ~30–60 min. Needed by M6.

## Exit test

`docker compose up` + `npm run dev` → `GET /api/v1/health` returns 200 `{status:'ok'}` having done `SELECT 1` through the PG pool + redis ping; one structured JSON log line with correlation id; spike test green proving tenant-scoped transaction mechanism on Prisma 7.

---

## Progress

### ✅ 1. Project guidance rewritten (2026-08-04)

- **Rewrote** [CLAUDE.md](../../CLAUDE.md) — it still described the old NestJS scaffold. Now documents the real stack (Express 5), the spec-of-record, all commands, the 7 architecture invariants, and the working process (phase plans + progress logging).
- **Created** [progress.md](../../progress.md) — the running cross-phase log you're tracking the project with.

### ✅ 2. Project re-scaffolded from NestJS to Express (2026-08-04)

- **Removed** all NestJS boilerplate and dependencies (user decision: Node + Express backend).
- **Rewrote** [package.json](../../package.json) — modern ESM setup, `npm run dev` (auto-reloading server), `build`, `test`, `test:e2e`, `check-rls`, `seed`.
- **Created** [eslint.config.mjs](../../eslint.config.mjs) with one rule worth knowing: importing the raw Prisma client outside `src/infra/db` is a **lint error** — that's what forces all data access through the tenant-safe path.
- **Created** the `src/` module layout matching the spec: `middleware/`, `infra/`, `modules/{auth,tenancy,identity,audit,workflow-def,engine,notification,…}`, `workers/`.

### ✅ 3. Local dev environment (2026-08-04)

- Docker Desktop on this Mac was broken (dead symlink to an unmounted installer) — **installed Colima** (lightweight docker runtime) per your choice.
- **Created** [docker-compose.yml](../../docker-compose.yml): Postgres 16, Redis 7, Keycloak 26 (dev identity provider, auto-imports the `cathaid-dev` realm), MinIO (local S3). One command: `docker compose up -d`.
- **Created** [docker/postgres/init.sql](../../docker/postgres/init.sql) — sets up the restricted `app_runtime` database user the app runs as. It cannot bypass row security; that's deliberate.
- **Created** [.env.example](../../.env.example) — every configuration key with dev defaults.

### ✅ 4. Infrastructure base (2026-08-04)

- **Created** [src/infra/config/](../../src/infra/config/index.ts) — all environment variables validated at boot; the server refuses to start misconfigured, and refuses dev-auth mode in production.
- **Created** [src/infra/logger/](../../src/infra/logger/index.ts) with a **PHI scrubber** ([phi-scrubber.ts](../../src/infra/logger/phi-scrubber.ts)): every log line is scanned and patient-identifying fields (names, DOB, phone, MRN, SSN…) are redacted before they're written. Why: logs leave the security boundary (log aggregators, vendors).
- **Created** [src/infra/secrets/](../../src/infra/secrets/index.ts) — modules ask for secrets by reference; swapping env-vars for a cloud secrets manager later touches one file.
- **Created** [src/infra/redis/](../../src/infra/redis/index.ts) — Redis connection factory.

### ✅ 5. Express app skeleton (2026-08-04)

- **Created** [src/app.ts](../../src/app.ts) (request pipeline) + [src/server.ts](../../src/server.ts) (startup/graceful shutdown).
- Every request gets a **correlation id** ([src/middleware/correlation.ts](../../src/middleware/correlation.ts)) — one id ties together the response header, every log line, and (later) audit entries, so any incident can be traced end to end.
- One **error shape** for the whole API ([src/middleware/error.ts](../../src/middleware/error.ts)): `{code, message, details}` — never stack traces, never PHI.
- `GET /api/v1/health` does a real DB query + Redis ping. Interactive API docs at `/docs`.
- Note: the API runs on **port 3001** locally — 3000 is occupied by your other project.

### ✅ 6. The tenant-transaction mechanism — M0's make-or-break (2026-08-04)

- **Created** [src/infra/db/](../../src/infra/db/index.ts) — `runInTenant(tenantId, fn)`: opens one DB transaction, first statement tells Postgres which tenant is active (this is what row security keys off), and carries the transaction invisibly through all async code ([tenant-context.ts](../../src/infra/db/tenant-context.ts)). Side effects (queue jobs, events) wait until the transaction commits.
- **Proved it works** with [scripts/spike-tenant-tx.ts](../../scripts/spike-tenant-tx.ts) — 7 checks against real Postgres, all passed, including: no tenant residue leaks onto reused connections, and two concurrent requests never see each other's tenant. **Go decision for M1.**

### ✅ 7. Tests + CI (2026-08-04)

- **Created** jest setups ([jest.config.ts](../../jest.config.ts) unit, [jest.e2e.config.ts](../../jest.e2e.config.ts) e2e) and first suites: PHI scrubber unit tests, health/correlation/error-shape e2e ([test/health.e2e-spec.ts](../../test/health.e2e-spec.ts)).
- **Created** [.github/workflows/ci.yml](../../.github/workflows/ci.yml) — every push runs lint, typecheck, unit, e2e (with real Postgres+Redis services), and the tenant-tx spike as a regression test.

### Exit test — PASSED (2026-08-04)
`docker compose up` + `npm run dev` → health returns 200 with db+redis up, correlation id echoed, structured scrubbed logs; tenant-tx spike 7/7 on Prisma 7.

**M0 complete.** Next: [M1-tenancy-rls-audit.md](M1-tenancy-rls-audit.md).
