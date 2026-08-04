# M2 — Identity, Authentication (OIDC/SSO) & Dynamic RBAC

> Phase plan written before execution per working process. Progress section at bottom updated as tasks complete.
> Spec: `docs/backendMLD.md` Phase 2. Plan: `docs/implementationPlan.md`.

## Objective

Enterprise SSO login + the scoped permission model gating every later action. Multi-tenant OIDC (openid-client v6, PKCE, per-tenant `idp_config`), JIT user provisioning, our own short-lived access JWT (15 min; claims `sub`/`tid`/`sid` only) + opaque refresh sessions in Redis, the fixed platform permission catalog, roles / role_permission / memberships, `effectivePermissions` resolution, and `requirePermission` authz middleware — completing the load-bearing chain: correlation → **auth** → tenant-scope → **authz** → validate → handler.

## Design notes (locked before execution)

- **Models** (all RLS + tenant-first unless noted): `IdpConfig` (per-tenant issuer/client; secrets as `env:`-refs via Secrets adapter, never plaintext), `AppUser` (unique `(tenant_id, idp_subject)`, `phone_e164`, `is_platform_admin`), `Role` (unique `(tenant_id, workflow_def_id, code)`; `workflow_def_id` null = tenant-level), `RolePermission` (**gets `tenant_id` too** — invariant #1 uniformity, unlike MLD's minimal shape), `Membership` (facility/workflow scope, null = all). `Permission` = **global catalog, NO tenant_id/RLS** (platform-owned like `tenant`): code PK, seeded IN the migration (`ON CONFLICT DO NOTHING`), SELECT-only for `app_runtime` — codes grow only via engineering migration, never AI/admin.
- **Pre-auth IdP lookup without breaking RLS**: login knows the claimed tenant (`?tenantId=`), so the flow reads `idp_config` inside `runInTenant(tenantId, ...)` — no RLS exemption, no policy hole.
- **Token model** (MLD): access JWT via jose (HS256 dev / RS256 prod path), claims `sub`, `tid`, `sid`, `exp` ONLY — permissions resolved per-request so revocation is immediate. Refresh = opaque uuid → Redis `session:{id}` `{userId, tenantId, issuedAt}`, TTL = refresh lifetime, rotated on use (old id deleted).
- **Auth middleware**: `Authorization: Bearer` → jose verify → `req.principal = {userId, tenantId, sessionId}`. Replaces the M1 `devPrincipal` header shim on tenant routes (shim stays only for tests/dev via dev-token issuer instead: `POST /api/v1/auth/dev-token`, refused outside AUTH_DEV_MODE).
- **JIT provisioning** (callback): upsert `app_user` by `(tenant_id, idp_subject)` (email/name refreshed from claims); zero memberships by default — an admin grants roles. `audit.record('user.jit_provision')`.
- **requirePermission(perm, scopeFrom)**: runs after tenantScope (inside tenant tx); `effectivePermissions(userId, facilityId?, workflowDefId?)` = union over memberships (`facility_id IS NULL OR = $2`, same for workflow) joined to role_permission. 403 on miss. Admin/tenants surface switches from `devAdminGate` to `requirePlatformAdmin` (principal's `app_user.is_platform_admin`, read via their own tenant tx).
- **Keycloak e2e reality**: CI has no Keycloak service. Full browser-code-flow e2e is **flag-gated** (`KEYCLOAK_E2E=1`, local only, drives the login form with fetch). CI covers: dev-token issue → authenticated call, 401 matrix (no/expired/garbage token), 403 permission miss, JIT upsert (via callback with mocked token exchange seam), refresh rotation + revocation.

## Tasks

| # | Task | Details |
|---|------|---------|
| 1 | Models + migration + catalog seed | 6 models; `--create-only` + hand-appended RLS blocks (rls.template) + permission catalog INSERTs + grants; check-rls green |
| 2 | Auth core | `modules/auth/`: jwt service (jose sign/verify), Redis session store (create/rotate/revoke), auth middleware → `req.principal`, dev-token issuer endpoint |
| 3 | OIDC flows | openid-client v6: `GET /auth/login?tenantId` (PKCE, state in Redis) → IdP; `GET /auth/callback` (exchange, JIT provision, tokens); `POST /auth/refresh`; `POST /auth/logout`; idp-config admin endpoints (tenancy module) |
| 4 | RBAC | `modules/identity/`: permission catalog constant, users/roles/memberships CRUD + effective-permissions endpoint; `requirePermission` middleware; `requirePlatformAdmin`; wire onto existing audit/facilities/admin routes |
| 5 | Tests | Unit: jwt roundtrip/expiry, effectivePermissions scope matrix. E2E: dev-token → 200; 401 matrix; 403 without permission → 200 with role; JIT upsert; refresh rotation (old token dead); logout revokes. Flag-gated Keycloak code-flow e2e |
| 6 | Phase closeout | Full suite green (lint, tsc, unit, e2e, check-rls, drift, spike); progress + phase file; CLAUDE.md middleware note already accurate |

## Exit test

Dev-token + RBAC e2e green in CI (401/403/200 matrix, JIT, refresh rotation). Locally with `KEYCLOAK_E2E=1`: full code flow against `cathaid-dev` realm — login redirect → Keycloak form → callback → JIT `app_user` row created → access JWT works on tenant route; suspended user refused.

---

## Progress

### ✅ 1. Identity models + permission catalog (2026-08-04)

**Created 6 database models** in [prisma/schema.prisma](../../prisma/schema.prisma):
- `IdpConfig` — each tenant's single-sign-on settings (which identity provider, which client). Secrets are stored as *references* (e.g. `env:KEYCLOAK_DEV_CLIENT_SECRET`), never the secret itself.
- `AppUser` — a person within a tenant; linked to their SSO identity; carries `phone_e164` (needed later for AI voice calls) and an `is_platform_admin` flag.
- `Permission` — the **fixed catalog of 36 permission codes** (like `case.accept`, `stage.advance`). Platform-owned: no tenant can add codes; only an engineering migration can. Hospital-specific behavior comes from workflow JSON instead (M3).
- `Role` — a named bundle of permissions per tenant (e.g. ACCEPTING_MD), optionally tied to one workflow.
- `RolePermission` — which permissions a role holds.
- `Membership` — which user has which role, optionally narrowed to one facility and/or one workflow.

**Migrated**: [20260804075212_identity_rbac](../../prisma/migrations/20260804075212_identity_rbac/migration.sql) — table creation plus hand-appended row-security for all five tenant tables (same reason as M1: RLS is the isolation mechanism, Prisma can't write it), plus the seed of all 36 catalog codes.
check-rls now reports 7 compliant tables.

### ✅ 2. Auth core — tokens, sessions, login guard (2026-08-04)

- **Created** [src/modules/auth/jwt.ts](../../src/modules/auth/jwt.ts) — issues/verifies our 15-minute access tokens. Tokens carry only *who you are* (user, tenant, session) — never permissions, so revoking a role takes effect on the very next request.
- **Created** [src/modules/auth/session-store.ts](../../src/modules/auth/session-store.ts) — refresh sessions in Redis (30 days). Each refresh token is single-use: using it atomically kills the old one and issues a new one, so a stolen old token is worthless.
- **Created** [src/middleware/auth.ts](../../src/middleware/auth.ts) — `requireAuth`: checks the `Authorization: Bearer` header on every protected route; bad/missing token → 401.
- **Created** `POST /api/v1/auth/dev-token` in [src/modules/auth/routes.ts](../../src/modules/auth/routes.ts) — local/testing login shortcut that goes through the *real* token machinery. Pretends not to exist (404) outside dev mode.

Verified live: issue → refresh rotates → replaying the old refresh token 401 → logout kills the session.

### ✅ 3. Single sign-on (OIDC) against Keycloak (2026-08-04)

**Created** [src/modules/auth/oidc.ts](../../src/modules/auth/oidc.ts) — the browser login flow:
1. `GET /api/v1/auth/login?tenantId=…` looks up that tenant's IdP settings and redirects to *their* login page (multi-tenant SSO — every hospital brings its own identity provider).
2. User signs in at the IdP → IdP redirects back to `GET /api/v1/auth/callback`.
3. Callback verifies the response (PKCE + single-use state stored in Redis), **creates the user on first login** ("JIT provisioning" — email/name copied from the IdP), and hands out our own tokens. New users start with zero roles; an admin grants access.

**Created** `PUT /api/v1/admin/tenants/:id/idp-config` in [src/modules/tenancy/routes.ts](../../src/modules/tenancy/routes.ts) — how an admin registers a tenant's IdP.

Verified live against the dockerized Keycloak: full login round-trip, user `accepting.md@mountsinai.dev` auto-created, replaying the callback rejected.
(Also updated [docker/keycloak/realm-export.json](../../docker/keycloak/realm-export.json) — our API runs on port 3001, the realm only allowed 3000.)

### ✅ 4. RBAC — roles, memberships, permission gates (2026-08-04)

**Created** [src/modules/identity/](../../src/modules/identity/index.ts) — user/role/membership management APIs plus `GET /users/:id/effective-permissions`, which answers "what can this person do *here*": the union of their memberships that match the facility/workflow in question. A grant scoped to Facility A is invisible everywhere else. Creating a role with a permission code not in the catalog → 400.

**Created** [src/middleware/authz.ts](../../src/middleware/authz.ts):
- `requirePermission('case.accept')` — route gate; looks the caller's permissions up in the DB *on every request* (that's why revocation is instant). Platform admins bypass it — that's how a brand-new tenant with no roles gets bootstrapped.
- `requirePlatformAdmin` — guards the control-plane `/api/v1/admin/*` surface.

**Wired everything**: tenant provisioning now auto-creates a `TENANT_ADMIN` role holding the full catalog; facilities/audit routes carry their permission gates; the M1 dev header shim is gone from the app — the full chain is now `correlation → auth → tenant-scope → authz → validate → handler`.

### ✅ 5. Tests (2026-08-04)

- **Created** [src/modules/auth/jwt.spec.ts](../../src/modules/auth/jwt.spec.ts) — 5 unit tests: valid round-trip; tampered, expired, foreign-issuer and incomplete tokens all rejected.
- **Created** [test/auth-rbac.e2e-spec.ts](../../test/auth-rbac.e2e-spec.ts) — the 401/403/200 matrix: no permission → 403, grant TENANT_ADMIN → 200; facility-scoped grants don't leak tenant-wide; refresh rotation/revocation; JIT idempotency; control plane refuses non-admins.
- **Created** [test/keycloak-oidc.e2e-spec.ts](../../test/keycloak-oidc.e2e-spec.ts) — the real SSO round-trip; runs only with `KEYCLOAK_E2E=1` (CI has no Keycloak; it auto-skips there).
- **Updated** [test/tenancy-isolation.e2e-spec.ts](../../test/tenancy-isolation.e2e-spec.ts) to authenticate with real JWTs, and [test/health.e2e-spec.ts](../../test/health.e2e-spec.ts) for the new rule: unknown `/api/v1/*` paths answer 401 to anonymous callers (we don't reveal which routes exist), plain 404 elsewhere.
- **Created** [test/helpers.ts](../../test/helpers.ts) — shared bootstrap (dev tokens, tenant provisioning) for all e2e suites.

### ✅ 6. Phase closeout (2026-08-04)

Everything green: lint, typecheck, unit 9/9, e2e 19/19 (18 + Keycloak flow when enabled), check-rls 7 tables, schema drift, tenant-tx spike.

### Exit test — PASSED (2026-08-04)
CI half: 401/403/200 matrix, JIT idempotency, refresh rotation + revocation, catalog-fenced roles, scope-correct effective permissions. SSO half (`KEYCLOAK_E2E=1`): full authorization-code flow against `cathaid-dev` realm — Keycloak form login → callback → JIT `app_user` with real IdP subject → our access JWT authenticates on tenant routes; state single-use.

**M2 complete.** Next: M3 (Workflow definitions — freeze the WorkflowDoc contract) — write `M3-workflow-definitions.md` before starting.
