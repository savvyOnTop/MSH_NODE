# Progress Log — cathaid-api

Production-grade MVP backend (Express + Prisma 7 + Postgres RLS), MSH STEMI as first workflow-as-data client.
Approved plan: [docs/implementationPlan.md](docs/implementationPlan.md) · Task-by-task detail lives in each phase file under [docs/backendPhases/](docs/backendPhases/).

| Phase | Status | Detail |
|-------|--------|--------|
| M0 Foundation & re-scaffold | ✅ complete (2026-08-04) | [M0-foundation.md](docs/backendPhases/M0-foundation.md) |
| M1 Tenancy + RLS + Audit | ✅ complete (2026-08-04) | [M1-tenancy-rls-audit.md](docs/backendPhases/M1-tenancy-rls-audit.md) |
| M2 OIDC + RBAC | ✅ complete (2026-08-04) | [M2-oidc-rbac.md](docs/backendPhases/M2-oidc-rbac.md) |
| M3 Workflow definitions | ⚪ pending | — |
| M4 Engine | ⚪ pending | — |
| M5 Notifications/SLA/Escalations | ⚪ pending | — |
| M6 EHR (Epic sandbox) | ⚪ pending | — |
| M7 Chat + AI summary | ⚪ pending | — |
| M8 AI voice + hardening | ⚪ pending | — |

## What exists right now (plain English)

**You can:** start the stack (`docker compose up -d` + `npm run dev`), provision a hospital organization, register its single-sign-on provider, log in through Keycloak (or a dev token), get auto-created as a user on first login, be granted roles, and manage facilities — with every action audit-logged and every byte of data isolated per tenant at the database level.

**API surface so far:**
- `GET /api/v1/health` · Swagger docs at `/docs`
- `POST /api/v1/auth/{dev-token, refresh, logout}` · `GET /api/v1/auth/{login, callback}` (SSO)
- `POST /api/v1/admin/tenants` · `…/:id/suspend` · `PUT …/:id/idp-config` (platform admins only)
- `POST|GET /api/v1/facilities` · `GET /api/v1/audit` · `GET /api/v1/permissions`
- `POST|GET /api/v1/users` · `POST|GET /api/v1/roles` · `POST /api/v1/memberships` · `GET /api/v1/users/:id/effective-permissions`

## Milestone summaries

### ✅ M0 — Foundation (2026-08-04)
Replaced the NestJS scaffold with an Express 5 + TypeScript skeleton where compliance is built in, not bolted on: PHI-scrubbed logging, correlation ids on every request, one error shape, validated config, dockerized dev stack (Postgres/Redis/Keycloak/MinIO via Colima), CI. Proved the core tenant-transaction mechanism against real Postgres before building anything on it.
→ task-by-task: [M0-foundation.md](docs/backendPhases/M0-foundation.md)

### ✅ M1 — Tenancy, RLS & Audit (2026-08-04)
The isolation substrate. First real tables ([schema.prisma](prisma/schema.prisma): `Tenant`, `Facility`, `AuditLog`) with Postgres Row-Level Security so the *database itself* refuses cross-tenant reads/writes even if app code is buggy. Tenant-scope middleware wires every HTTP request into one tenant-scoped transaction. Append-only audit ledger with a single write path. A CI gate ([scripts/check-rls.ts](scripts/check-rls.ts)) makes it impossible to merge a table that's missing its protections. Exit test: an adversarial suite that *tries* to leak data across tenants — [test/tenancy-isolation.e2e-spec.ts](test/tenancy-isolation.e2e-spec.ts), all green.
→ task-by-task: [M1-tenancy-rls-audit.md](docs/backendPhases/M1-tenancy-rls-audit.md)

### ✅ M2 — Sign-on & permissions (2026-08-04)
Multi-tenant SSO: each hospital registers its own identity provider; users are auto-created on first login with zero access until an admin grants roles. Our own short-lived tokens + rotating refresh sessions ([src/modules/auth/](src/modules/auth/index.ts)). Fixed catalog of 36 permission codes; roles bundle them; memberships scope them to facility/workflow ([src/modules/identity/](src/modules/identity/index.ts)). Permission checks hit the DB per request, so revoking access is instant. Verified end-to-end against real Keycloak. Exit tests: [test/auth-rbac.e2e-spec.ts](test/auth-rbac.e2e-spec.ts) + [test/keycloak-oidc.e2e-spec.ts](test/keycloak-oidc.e2e-spec.ts).
→ task-by-task: [M2-oidc-rbac.md](docs/backendPhases/M2-oidc-rbac.md)

## Notes & pending items

- ⏭ **Your action:** Epic sandbox app registration at fhir.epic.com (Backend Systems app, Patient + Observation R4 APIs) — long lead time, needed by M6.
- API runs on **port 3001** locally (3000 is your other project).
- Unknown `/api/v1/*` URLs return 401 (not 404) to anonymous callers — deliberate: don't reveal which routes exist.
- Decision deferred to M8 (will re-ask): conversational two-way AI voice agent vs. current plan (TTS summary call).
- AI features stay disabled in production until vendor BAAs are signed (`PHI_VENDORS_BAA_CONFIRMED`).
