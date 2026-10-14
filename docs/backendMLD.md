# Backend HLD + LLD — Emergency Care Coordination Platform

**A combined High-Level and Low-Level Design, phase by phase.**

Version 0.1. For each phase: the **HLD** covers component architecture, data flow, and the design decisions behind them; the **LLD** gives concrete table schemas, API contracts, key algorithms in pseudocode, and interface signatures. This is a design document for engineering review, not final code — types and names are indicative and meant to be refined in implementation.

Conventions used throughout:
- `id` columns are UUIDs (v7 preferred, for time-sortable keys) unless noted.
- All PHI-bearing tables live inside a tenant schema and carry RLS (Phase 1).
- Timestamps are `timestamptz`, stored UTC.
- API paths are prefixed `/api/v1`. All state-changing endpoints accept an `Idempotency-Key` header.
- Request validation via Zod schemas at the edge; DB access via a query builder with a central tenant-scoping layer.

---

## Reconciliation with businessLogic.md (added 2026-10-14)

[businessLogic.md](businessLogic.md) is the **product requirements** (how CathAID must behave). This MLD is the **engineering design**. Where they disagree on *behaviour*, businessLogic wins; where they disagree on *mechanism* (tenancy, RLS, ledger, idempotency), this MLD wins. Policy: the data model is designed now for every item in businessLogic — including its [Not built]/[Partial] gaps — and the build is phased ([Built] parity first, gaps later).

**Deferred by decision (designed when its phase starts, Phase 15):** anything crossing a tenant boundary — transfers between health systems, independent EMS agencies serving several health systems, a shared patient master. Until then every row belongs to exactly one tenant, and EMS providers are tenant-owned ("hospital-owned EMS").

| businessLogic § | Covered in | Change vs. earlier MLD |
|---|---|---|
| 2.1 Organisations (department, dept role/head, group, diagnosis type, facility geo + scheduling mode) | Phase 1 amend + **Phase 9** | New org entities below facility |
| 2.2 System roles · 3.3 permission sets | Phase 2 amend | System roles = seeded tenant-level role templates; permission sets = role_permission. No forced re-login (perms already resolved per request) |
| 2.3 Workflow roles · workspace | Phase 2/3 amend, Phase 9 | Workflow-role assignment per facility; workspace = client-selected (facility, workflow) + default preference |
| 3.2 Departments, groups, join requests | **Phase 9** | New |
| 3.3 Invites | **Phase 9** | Invite pre-creates a pending `app_user` + memberships; bound on first SSO login (JIT stays) |
| 4 Templates, scope, adoption, private copy, Case Manager role | Phase 3 amend | Template scope platform/tenant/facility; adoption creates a private facility copy; contract extensions C1–C12 |
| 5 Cases, statuses, raise rules, field-level edit, timeline, lists | Phase 4 amend | Origin/destination facility, case number, patient columns, 5 statuses, frozen terminal cases, field edit rights |
| 6 Team builder, case managers, escalations | Phase 5 amend | `case_team_member` with pick-reason; availability-aware team build; coverage-gap alert; once-per-case escalations scoped to case facilities; `code_blue` |
| 7 Epic | Phase 6 amend | Prefill first stage only, fill-only-empty, encounter/meds/conditions, MAP calc; AI chart review |
| 8 Chat | Phase 8 amend | One case chat created at raise; members = team; add by search or department group; text ≤4000; immutable messages; AI catch-up |
| 9 Calls and video | **Phase 13** | New |
| 10 Scheduling (roster, swaps, time off, Amion) | **Phase 10** | Replaces Phase 5's thin on-call model |
| 11 Hospital-to-hospital transfer | **Phase 11** | Two linked cases + `transfer_request` |
| 12 EMS, ambulances, tracking | **Phase 12** | New |
| 13 Notifications catalogue | Phase 5 amend | Typed notification catalogue + inbox |
| 14 Permissions | Phase 2 amend | New catalog codes listed there |
| 15 AI | **Phase 14** | Real workflow builder (feedback/regenerate), field linking, chart review, chat catch-up, call summary, Amion matching |
| 16 Audit/metrics | Phase 1, Phase 7 | Case monitor role gets real read access |
| 18 Open gaps | Each phase marks gap items `(gap)` | Designed now, built later |

---

## Phase 0 — Project Foundation & Environment

### HLD

**Purpose:** a deployable modular-monolith skeleton where compliance and operability are inherited, not retrofitted.

**Component view.** A single Express service organized into internal modules that talk to each other through typed service interfaces (not HTTP), so boundaries are enforced in code and can later be extracted into separate services without rewrites.

```
                ┌─────────────────────────────────────────┐
   HTTPS  ─────▶│  API Edge (Express)                       │
                │   ├─ request-id / correlation middleware  │
                │   ├─ auth middleware        (Phase 2)     │
                │   ├─ tenant-scope middleware (Phase 1)    │
                │   ├─ authz middleware       (Phase 2)     │
                │   ├─ validation (Zod)                     │
                │   └─ error handler                        │
                ├─────────────────────────────────────────┤
                │  Modules (in-process, typed interfaces):  │
                │  auth · tenancy · workflow-def · engine · │
                │  notification · scheduling · ehr · audit ·│
                │  realtime                                 │
                ├─────────────────────────────────────────┤
                │  Infra adapters: PG pool · Redis · S3 ·   │
                │  secrets · push · logger                  │
                └─────────────────────────────────────────┘
```

**Key decisions.**
- **Modular monolith over microservices** — one deployable, clean module seams. Extraction later is a deployment change, not a redesign.
- **Middleware order is fixed and load-bearing:** correlation → auth → tenant-scope → authz → validation → handler. Tenant scope must be set before any handler or query runs.
- **Structured JSON logging with a PHI scrubber** in the logging adapter itself, so no module can accidentally log PHI.

### LLD

**Repository layout.**
```
/src
  /modules/{auth,tenancy,workflow-def,engine,notification,scheduling,ehr,audit,realtime}
    index.ts        // public typed interface of the module
    service.ts      // business logic
    repository.ts   // DB access (tenant-scoped)
    routes.ts       // Express routes
    schema.ts       // Zod request/response schemas
  /infra/{db,redis,storage,secrets,push,logger}
  /middleware/{correlation,auth,tenant-scope,authz,validate,error}
  /migrations
  app.ts  server.ts
```

**Core middleware contract (pseudocode).**
```ts
// correlation.ts
req.correlationId = header('x-correlation-id') ?? uuidv7();
logger = baseLogger.child({ correlationId: req.correlationId });

// error.ts — single error shape
type ApiError = { code: string; message: string; details?: unknown };
// never leak stack traces or PHI to the client
```

**Config/secrets interface.**
```ts
interface Secrets {
  get(name: string): Promise<string>;      // from Secrets Manager / Key Vault
}
// No secret is ever read from process.env in module code — only via this adapter.
```

**Exit test.** `GET /api/v1/health` returns 200, emits one structured log line with a correlation id, and performs a trivial `SELECT 1` through the PG pool.

---

## Phase 1 — Tenancy, Data Isolation & Audit Foundation

### HLD

**Purpose:** the isolation and auditability substrate. **Tenancy model: shared database, shared tables** — all tenants' rows live in the same tables, distinguished by a `tenant_id` column on every table. This is the simplest, cheapest model to operate and is the chosen starting point.

Because the schema boundary is gone, isolation now rests on **two** independent mechanisms rather than three: **Postgres RLS** (the database itself refuses to return another tenant's rows) and **application tenant-scoping** (the central middleware sets the tenant context). With shared tables, RLS is not a nice-to-have backstop — it is the single mechanism standing between a buggy query and a cross-tenant PHI leak. **RLS is therefore mandatory on every PHI-bearing table, without exception.**

**Tenant-resolution flow.**
```
request → auth (principal has tenant_id) → tenant-scope middleware:
   1. acquire a connection from the shared pool
   2. BEGIN transaction
   3. SET LOCAL app.current_tenant = <tenant_id>   (drives RLS; auto-resets at COMMIT)
   4. attach scoped client to req.ctx
handler → repository uses req.ctx client only → COMMIT (or ROLLBACK)
```

**Why `SET LOCAL` inside a transaction.** The tenant is carried in a Postgres session variable, and pooled connections are reused across requests. A plain `SET` persists on the connection and could leak a stale tenant value into the *next* request that reuses it — a cross-tenant breach. `SET LOCAL` scopes the value to the current transaction and resets automatically at `COMMIT`/`ROLLBACK`, so a request can never inherit another request's tenant. This is the single most important operational rule in the shared-DB model.

**Indexing & constraints for shared tables.** Every query filters by tenant, so **every index leads with `tenant_id`** (e.g. `(tenant_id, status)`), and **every uniqueness constraint includes `tenant_id`** (a workflow name is unique *within* a tenant, not globally). This keeps performance sane as tenants share physical tables and prevents one tenant's data from colliding with another's.

> **`[DEEP-DIVE]`** RLS policy completeness — auditing that *every* PHI-bearing table has RLS enabled and a correct policy is the highest-stakes review in this model; consider a CI check that fails if any tenant table lacks a policy.

**Upgrade path (deliberately preserved).** Because `tenant_id` is on every table and tenant-scoping is centralized in one middleware, a large or high-sensitivity tenant can later be migrated to its own schema or database with a routing change, not a rewrite. The `platform.tenant` table keeps an `isolation_mode` column anticipating this, though only `shared` is used today.

**Audit path.** A single append-only writer. Every module calls `audit.record(...)`; there is no other write path to the audit store. Storage is WORM/object-lock for retention.

### LLD

**Schema — control plane (a small `platform` table set, tenant-agnostic):**
```sql
CREATE TABLE platform.tenant (
  id              uuid PRIMARY KEY,
  name            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('active','suspended','provisioning')),
  isolation_mode  text NOT NULL DEFAULT 'shared'   -- only 'shared' used today;
                  CHECK (isolation_mode IN ('shared','schema','dedicated_db')),
                                                    -- 'schema'/'dedicated_db' reserved for
                                                    -- future per-tenant migration (upgrade path)
  region          text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

**Schema — shared tables (all tenants share these; every table carries `tenant_id` + RLS):**
```sql
CREATE TABLE facility (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  name        text NOT NULL,
  address     jsonb,
  timezone    text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- tenant-first index: every query filters by tenant
CREATE INDEX idx_facility_tenant ON facility (tenant_id, status);
-- names are unique WITHIN a tenant, not globally
CREATE UNIQUE INDEX uq_facility_name ON facility (tenant_id, name);

-- RLS is MANDATORY on every PHI-bearing table — the only isolation boundary in shared-DB mode
ALTER TABLE facility ENABLE ROW LEVEL SECURITY;
ALTER TABLE facility FORCE ROW LEVEL SECURITY;   -- applies even to the table owner
CREATE POLICY tenant_isolation ON facility
  USING      (tenant_id = current_setting('app.current_tenant')::uuid)   -- reads
  WITH CHECK (tenant_id = current_setting('app.current_tenant')::uuid);  -- writes can't set a foreign tenant_id

CREATE TABLE audit_log (               -- append-only
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  actor_user_id uuid,
  action        text NOT NULL,          -- 'tenant.provision','case.advance',...
  resource_type text NOT NULL,
  resource_id   uuid,
  summary       jsonb,                  -- before/after digest, PHI-minimized
  ip            inet,
  correlation_id uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_tenant ON audit_log (tenant_id, created_at);
-- no UPDATE/DELETE grants; enforced by role privileges + storage WORM
```
> The same three rules — `tenant_id` column, tenant-first index, RLS `USING` + `WITH CHECK` policy — apply verbatim to **every** table introduced in later phases (`app_user`, `role`, `membership`, `clinical_case`, `case_event`, …). They are not repeated in each phase's schema block; assume them.

**Tenant-scope middleware (pseudocode).**
```ts
async function tenantScope(req, res, next) {
  const tenantId = req.principal.tenantId;
  const t = await platform.tenant.find(tenantId);
  if (!t || t.status !== 'active') throw ApiError('tenant_unavailable');

  // Shared pool — all tenants share the same database and tables.
  const client = await sharedPool.connect();
  await client.query('BEGIN');
  // SET LOCAL: scoped to THIS transaction, auto-resets at COMMIT/ROLLBACK.
  // Prevents a pooled connection from leaking a stale tenant into the next request.
  await client.query(`SET LOCAL app.current_tenant = $1`, [tenantId]);

  req.ctx = { db: client, tenantId };
  res.on('finish', async () => {
    try { await client.query(res.statusCode < 400 ? 'COMMIT' : 'ROLLBACK'); }
    finally { client.release(); }
  });
  next();
}
// Every repository query for the request runs on req.ctx.db, inside this one transaction,
// so RLS sees the correct app.current_tenant for every statement.
```

**Audit interface.**
```ts
interface Audit {
  record(input: {
    action: string; resourceType: string; resourceId?: string;
    summary?: object; actorUserId?: string;
  }): Promise<void>;   // writes with req.correlationId + tenantId from ctx
}
```

**API (super_admin).**
```
POST /api/v1/admin/tenants           → provision tenant (inserts tenant row, seeds baseline)
POST /api/v1/admin/tenants/:id/suspend
POST /api/v1/tenants/:id/facilities  → create facility
GET  /api/v1/tenants/:id/facilities
GET  /api/v1/audit?resourceType=&from=&to=   (scoped)
```

**Provisioning algorithm.**
```
BEGIN
  insert platform.tenant (isolation_mode='shared', status='provisioning')
  seed baseline tenant data (default permissions catalog, etc.) — plain INSERTs
     into the shared tables, all stamped with the new tenant_id
  set status='active'; audit('tenant.provision')
COMMIT  (with compensating cleanup on failure)
```
> No schema or database is created — provisioning a tenant in shared-DB mode is just inserting a `platform.tenant` row and seeding baseline rows. This is a major operational simplification over per-tenant schemas.

**Amendment (businessLogic §2.1, §3.1).** `facility` gains `lat`, `lng` (geocoded from address — needed for EMS geofences/ETA), `scheduling_mode` (`roster` | `amion`), and allowed diagnoses via `facility_diagnosis(facility_id, diagnosis_type_id)`. `diagnosis_type` = platform defaults (STEMI, Stroke, Trauma, Vascular, Custom — global, no-RLS catalog like `permission`) plus tenant-specific rows in `tenant_diagnosis_type` (RLS). `workflow_definition.clinical_category` becomes a reference to a diagnosis type. Platform audit log for super-admin actions is a separate non-tenant table `platform_audit_log`.

**Adversarial exit test.** In a handler scoped to Tenant A, run `SELECT * FROM facility` with the `WHERE tenant_id` clause *deliberately omitted*; assert zero Tenant-B rows return — RLS alone must enforce isolation, since in shared-DB mode there is no schema boundary behind it. Additionally, attempt to `INSERT` a row with a foreign `tenant_id`; the policy's `WITH CHECK` must reject it. A second test asserts that after a request commits, the pooled connection carries no residual `app.current_tenant` (proving `SET LOCAL` reset).

---

## Phase 2 — Identity, Authentication & Dynamic RBAC

### HLD

**Purpose:** enterprise SSO login and the scoped permission model that gates every later action. Enforcement layers: **RLS** (tenant) from Phase 1, **authz middleware** (permission) here, and later **notification scoping** (Phase 5).

**Auth flow (OIDC/SAML).**
```
client → /auth/login?tenant=... → redirect to tenant IdP
IdP → /auth/callback → validate assertion → JIT-provision/lookup User
   → issue short-lived access JWT + refresh token (session store in Redis)
```

**Permission model.** `Permission` (atomic, system-defined) ← `Role` (per-workflow set of permissions) ← `Membership` (user↔role, scoped to facility + workflow(s)). A principal's **effective permissions** for a target `(facility, workflow)` = union of permissions from memberships matching that scope.

> **`[DEEP-DIVE]`** multi-tenant SSO / IdP federation + JIT provisioning.

### LLD

**Schema (per-tenant).**
```sql
CREATE TABLE app_user (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  idp_subject   text NOT NULL,          -- from SSO
  email         text NOT NULL,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'active',
  is_platform_admin boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, idp_subject)
);

CREATE TABLE permission (               -- the FIXED, platform-owned catalog (system permissions)
  code text PRIMARY KEY                 -- 'case.view','case.accept','stage.advance',...
);
-- A code exists ONLY if backend code enforces it (engine behavior, or an outside-a-case/admin
-- capability). Seeded from the permission catalog (~35 codes across case-lifecycle, stage,
-- media, alerts, scheduling, workflow-authoring, RBAC, metrics, tenant/facility, EHR groups).
-- Grows only via an engineering change + migration — never by AI or admin action. The AI and
-- admins SELECT from this catalog; they cannot add to it. Anything hospital-specific is a
-- workflow-declared CUSTOM action (see Phase 3), which carries no code here.

CREATE TABLE role (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  workflow_def_id uuid,                 -- NULL = tenant-level role (e.g. QA/QI)
  code          text NOT NULL,          -- 'INTERVENTIONAL_CARDIOLOGIST'
  name          text NOT NULL,
  UNIQUE (tenant_id, workflow_def_id, code)
);

CREATE TABLE role_permission (          -- many-to-many: a role holds many permissions
  role_id     uuid NOT NULL REFERENCES role(id),        -- (one row per granted permission)
  permission  text NOT NULL REFERENCES permission(code),
  PRIMARY KEY (role_id, permission)     -- PK only prevents the same permission twice per role
);

CREATE TABLE membership (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  user_id     uuid NOT NULL REFERENCES app_user(id),
  role_id     uuid NOT NULL REFERENCES role(id),
  facility_id uuid,                     -- NULL = all facilities (tenant scope)
  workflow_def_id uuid,                 -- NULL = all workflows in scope
  created_at  timestamptz NOT NULL DEFAULT now()
);
-- RLS on all four tables as in Phase 1
```

**Effective-permission resolution (pseudocode).**
```ts
function effectivePermissions(userId, facilityId?, workflowDefId?): Set<string> {
  const rows = query(`
    SELECT rp.permission
    FROM membership m
    JOIN role_permission rp ON rp.role_id = m.role_id
    WHERE m.user_id = $1
      AND (m.facility_id IS NULL OR m.facility_id = $2)
      AND (m.workflow_def_id IS NULL OR m.workflow_def_id = $3)
  `, [userId, facilityId, workflowDefId]);
  return new Set(rows.map(r => r.permission));
}
```

**Authz middleware.**
```ts
const requirePermission = (perm: string, scopeFrom: (req)=>Scope) =>
  async (req, res, next) => {
    const scope = scopeFrom(req);   // derives facilityId/workflowId from route/body
    const perms = await rbac.effectivePermissions(req.principal.userId, scope.facilityId, scope.workflowDefId);
    if (!perms.has(perm)) throw ApiError('forbidden', 403);
    next();
  };
// usage: router.post('/cases/:id/accept', requirePermission('case.accept', caseScope), handler)
```

**API.**
```
GET  /auth/login    POST /auth/callback   POST /auth/refresh   POST /auth/logout
POST /api/v1/users                       (user.manage)
POST /api/v1/roles                       (role.manage)  — attaches permissions
POST /api/v1/memberships                 (user.manage)  — scoped to caller's scope
GET  /api/v1/users/:id/effective-permissions?facilityId=&workflowId=
```

**Session store (Redis).** `session:{refreshTokenId}` → `{ userId, tenantId, issuedAt, mfaSatisfied }`, TTL = refresh lifetime; access JWT carries `userId, tenantId, exp` only (permissions resolved per-request, never baked into the token so revocation is immediate).

**Amendment (businessLogic §2.2, §2.3, §3.3, §14).**
- **System roles** are seeded, tenant-level role templates (`role.workflow_def_id IS NULL`): `TENANT_ADMIN`, `HOSPITAL_ADMIN` (membership scoped to facility), `CLINICIAN`, `CASE_MONITOR`, `SCHEDULER_ADMIN`, `EMS_ADMIN`, `EMS_CREW`. Super/platform admin stays `app_user.is_platform_admin`. "Permission sets" in the brief = editing a role's `role_permission` rows or creating a custom tenant role; because permissions resolve per request, changes take effect immediately (no forced re-login needed).
- **Workflow roles** stay workflow-scoped `role` rows (reconciled at publish); a workflow-role **assignment** = `membership(user, role, facility_id NOT NULL, workflow_def_id)`. Assignment requires the facility to have adopted that workflow.
- **Hierarchy guard**: a hospital admin may only manage users/memberships inside facilities they administer and may never deactivate a tenant admin (service-level check, audited).
- **Deactivation** is soft (`app_user.status = 'inactive'`); sessions revoked immediately.
- **Catalog additions** (engineering migration, per the fixed-catalog rule): `case.list`, `case.view_all`, `data.edit`, `case.add_member`, `case.remove_member`, `department.manage`, `group.manage`, `group.join_approve`, `invite.manage`, `roster.manage`, `timeoff.request`, `timeoff.approve`, `amion.manage`, `transfer.raise`, `transfer.respond`, `ems.provider.manage`, `ems.alert.raise`, `ems.alert.ack`, `ems.transport.request`, `ems.transport.assign`, `ems.trip.advance`, `call.start`, `video.start`, `diagnosis.manage`. The brief's per-workflow-role flags map onto codes: raise→`case.raise`, complete→`stage.advance`, accept→`case.accept`, list→`case.list`, view→`case.view`, edit→`data.edit`.

---

## Phase 3 — Workflow Definitions & Versioning

### HLD

**Purpose:** the lifecycle of workflow JSON — draft → validate → publish (immutable version). The engine (Phase 4) only ever executes published, validated versions.

**Design decisions.**
- **Two categories of action: system vs. custom.** Every action a user can take on a case is one of two kinds. **System actions** carry a `permission_code` from the fixed catalog and have real engine behavior wired to them (`accept` assembles the team, `reject` terminates, `advance` moves stage). This set is small, bounded, and universal across diagnoses. **Custom actions** are hospital/workflow-specific steps the platform has no built-in behavior for (`confirm_perfusionist_notified`, `activate_mtp`, the ABCDE survey logs) — declared inline in the workflow JSON, authorized by their own `allowed_roles`, and handled generically (authorize → validate data → record event → maybe transition). This split is what lets one platform cover unlimited diagnosis- and site-specific variation without an engineering change per hospital: fixed vocabulary for what the engine must understand, open-ended declaration for everything else. The AI *selects* system permissions from the catalog and *invents* custom actions freely; it can never create a system permission code.
- **The workflow schema is one formal, versioned contract shared by three consumers.** The full structure — stages, roles, permissions, transitions, notifications, escalation rules — is defined once as a formal schema (JSON Schema, backed by the same Zod schemas used at the API edge). That single definition is the contract that the **AI generator** produces to, the **admin builder UI** reads and renders, and the **engine + validator** (Phase 4) execute and check against. Defining it once and pointing all three at it is what keeps them from drifting apart; it is the most important artifact in the platform.
- **Permissions live at three scopes, not one.** (1) *System permissions* — the fixed catalog, global, held by roles via `role_permission`. (2) *Workflow-declared custom actions* — defined on a workflow, inherited by every case of that workflow, authorized by `allowed_roles`. (3) *Case-specific grants* — a role attached to one live case at runtime via `case_participant` (e.g. the ECMO team added mid-case by an `add_team` escalation). Only the first is a named code the backend keys on; custom-action ids and case grants are handled generically/by role.
- **`json_document` stored as `JSONB`** — the full stages/roles/notifications/escalations structure (the sample file) lives in one validated column, giving schema flexibility with queryability.
- **Publish = freeze.** A `WorkflowVersion` is immutable; drafts are mutable on the definition. This is what lets live cases pin safely.
- **Validation is a gate, not a warning.** A definition that fails schema validation cannot be published.
- **Drafts have many possible producers; publishing has one path.** A draft `WorkflowDoc` can come from the human visual builder *or* from the AI Workflow Builder (requirement E). Both produce a draft in the identical shape, and both go through the same validate → review → publish gate. The AI is just another draft *producer*, never a publisher.

**AI-generated workflow mechanism (HLD).** The AI Workflow Builder scans an existing protocol (an uploaded document or pasted text describing a hospital's STEMI/stroke process) and emits a *draft* `WorkflowDoc` — stages, roles, transitions, SLAs — that a human then reviews, edits, renames, and publishes. The AI is instructed with the **formal workflow schema as its output contract** and uses the API's structured-output / constrained-decoding mode, so it returns JSON already conforming to that schema — which then drops straight into `draft_document` and renders in the builder UI without a parsing step. Architecturally this is a swappable `WorkflowDraftGenerator` behind an interface, isolated exactly like the EHR connectors (Phase 6): the third-party AI is a plug-in implementation, and the platform ships with the socket even before the AI is wired up.

> **Schema-conformance is not semantic correctness.** Structured output guarantees the JSON is well-formed and type-valid; it does *not* guarantee the workflow is clinically or logically sound. The AI can emit perfectly-shaped JSON that still points a transition at a non-existent stage, references an undeclared role in an escalation, defines an entry stage that never reaches a terminal, or assigns a permission to the wrong role. So structured output solves the *parsing* problem, not the *validation* problem: every AI draft still runs through `validateWorkflow()` (which catches exactly these graph/reference errors) and still requires human review before publish.

```
source material (protocol doc / text)
        │
        ▼
  WorkflowDraftGenerator.generate()   ← today: stub;  later: third-party AI (under BAA)
        │  returns an UNSAVED draft WorkflowDoc + provenance
        ▼
  save as workflow_definition.draft_document   (ai_generated = true, source recorded)
        │
        ▼
  human reviews/edits in builder → validate() → publish (freezes immutable version)
```

Two hard rules on this seam: **(1)** an AI-produced draft is never authoritative — it must pass the same `validateWorkflow()` gate and a human publish action; the AI cannot publish or activate anything. **(2)** if source material contains PHI, it may not be sent to any AI vendor lacking a BAA (the platform-wide PHI rule). Most written protocols are not PHI, but chart-derived source is — so the generator enforces a PHI check on its input.

> **`[DEEP-DIVE]`** the workflow-definition schema + validation rules — the contract the whole engine depends on.
> **`[DEEP-DIVE]`** the AI draft-generator prompt/output contract + how confidently-wrong AI output is surfaced for human correction (deferred until the third-party AI is selected).

### LLD

**Schema (per-tenant).**
```sql
CREATE TABLE workflow_definition (
  id                uuid PRIMARY KEY,
  tenant_id         uuid NOT NULL,
  name              text NOT NULL,
  clinical_category text,               -- 'cardiac','stroke','trauma',...
  owner_scope       text NOT NULL CHECK (owner_scope IN ('tenant','facility')),
  owner_facility_id uuid,               -- when facility-owned
  draft_document    jsonb,              -- editable working copy
  draft_origin      text NOT NULL DEFAULT 'human'   -- 'human' | 'ai' — how the draft was produced
                    CHECK (draft_origin IN ('human','ai')),
  ai_source_type    text,               -- 'text' | 'document' | NULL — what the AI scanned (if any)
  current_version_id uuid,
  status            text NOT NULL DEFAULT 'draft',
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workflow_version (         -- IMMUTABLE
  id             uuid PRIMARY KEY,
  tenant_id      uuid NOT NULL,
  definition_id  uuid NOT NULL REFERENCES workflow_definition(id),
  version_number int NOT NULL,
  json_document  jsonb NOT NULL,        -- frozen snapshot
  ai_generated   boolean NOT NULL DEFAULT false,  -- provenance: did this originate from AI?
  ai_source_type text,                  -- 'text' | 'document' | NULL (frozen at publish)
  published_by   uuid NOT NULL,         -- the HUMAN who reviewed + published (AI never publishes)
  published_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version_number)
);

CREATE TABLE workflow_facility_assignment (
  workflow_def_id uuid NOT NULL,
  facility_id     uuid NOT NULL,
  PRIMARY KEY (workflow_def_id, facility_id)
);
```

**Definition JSON shape — the formal schema (abbreviated from the sample).** This is the single contract the AI produces to, the builder UI renders, and the engine executes. In practice it is expressed as a JSON Schema / Zod schema and validated at every boundary.
```ts
type WorkflowDoc = {
  stages: Stage[];
  roles: RoleDef[];
  escalation_rules: EscalationRule[];  // trigger (data/time/vitals/action_performed) + action (notify/escalate/add_team)
  metadata: { version: number; clinical_category: string; ... };
};

type Stage = {
  id: string; order: number;
  type: 'action' | 'decision' | 'terminal';
  is_entry?: boolean;
  actor_roles: string[];               // roles that may act at this stage
  required_data_fields?: DataField[];  // stage-level fields
  actions: Action[];                   // the buttons available at this stage
  notifications?: Notification[];
  sla_minutes?: number; on_sla_breach?: SlaBreach;
};

type Action =
  | { id: string; type: 'system';
      permission_code: string;         // MUST be a code in the fixed catalog → engine behavior
      label: string; allowed_roles: string[];
      required_data_fields?: DataField[];
      blocks_advance?: never;          // system actions don't gate; they ARE the advance
      transitions_to: string | null; }
  | { id: string; type: 'custom';
      // NO permission_code — authorized purely by allowed_roles; engine handles generically
      label: string; description?: string; allowed_roles: string[];
      required_data_fields?: DataField[];
      blocks_advance?: boolean;        // if true, stage advance is blocked until this action is recorded
      transitions_to: string | null; };

type RoleDef = {
  id: string; name: string;
  permissions: string[];               // system permission codes from the catalog (feeds RBAC reconcile at publish)
  can_raise_alarm: boolean; scheduling_required: boolean; default_sound: string;
};
```
> **Gating advancement (`blocks_advance`).** A mandatory checklist item is a `custom` action marked `blocks_advance: true`. The engine derives the advance gate from these flags — it will not run a stage's advancing system action until every `blocks_advance: true` action in that stage has a recorded `action.performed` event. Putting the requirement *on the check itself* (rather than a separate list on the advance action) means adding a mandatory check later is a single edit that cannot fall out of sync.

**Validation algorithm (pseudocode).**
```ts
function validateWorkflow(doc, catalog): Result {   // catalog = the fixed permission codes
  errors = [];
  assert exactly-one stage with is_entry === true;
  const stageIds = set(doc.stages.map(s => s.id));
  const roleIds  = set(doc.roles.map(r => r.id));
  for (r of doc.roles)                              // roles may only hold real catalog codes
    for (p of r.permissions) if (!catalog.has(p)) errors.push(...);
  for (s of doc.stages) {
    for (r of s.actor_roles) if (!roleIds.has(r)) errors.push(...);
    for (n of s.notifications ?? []) if (!roleIds.has(n.role_id)) errors.push(...);
    for (a of s.actions) {
      for (r of a.allowed_roles) if (!roleIds.has(r)) errors.push(...);
      if (a.type === 'system' && !catalog.has(a.permission_code)) errors.push(...);  // system → real code
      if (a.type === 'custom' && a.permission_code != null) errors.push(...);        // custom → NO code
      if (a.transitions_to && !stageIds.has(a.transitions_to)) errors.push(...);
      validateDataFields(a.required_data_fields);
    }
    if (s.type === 'terminal' && s.actions.some(a => a.transitions_to)) errors.push(...);
    validateDataFields(s.required_data_fields);
  }
  for (e of doc.escalation_rules) validateTriggerAndRoles(e, stageIds, roleIds);
  assert graph is reachable from entry; assert every non-terminal reaches a terminal;
  return errors.length ? fail(errors) : ok();
}
```
> The two lines that enforce the whole model boundary: a **system** action's `permission_code` must exist in the catalog (so the AI can't invent a fake system capability), and a **custom** action must *not* carry a `permission_code` (so it can never secretly trigger reserved engine behavior like accept/add_team).

**AI draft generator (interface + flow, LLD).** The generator is swappable behind one interface — a stub today, the third-party AI later — mirroring the EHR connector pattern. The AI implementation is given the formal `WorkflowDoc` schema as a structured-output constraint, so `generate()` returns JSON that already conforms to the schema (no free-text parsing).

```ts
interface WorkflowDraftGenerator {
  // Scans source material and returns an UNSAVED draft doc + provenance.
  // Never touches the DB, never publishes — pure produce-a-draft.
  // The returned draft is guaranteed SCHEMA-CONFORMING (via structured output),
  // but NOT guaranteed semantically valid — the caller must still run validateWorkflow().
  generate(input: {
    sourceType: 'text' | 'document';
    content: string;                 // pasted protocol text, or extracted doc text
    clinicalCategory?: string;
  }): Promise<{ draft: WorkflowDoc; provenance: { aiGenerated: true; sourceType: string } }>;
}
// StubGenerator (now) → returns a minimal skeleton; ThirdPartyAiGenerator (later, under BAA)
//   → passes the WorkflowDoc JSON Schema to the model's structured-output mode as the
//     output contract, so the response is well-formed WorkflowDoc JSON by construction.
```

```ts
// POST /api/v1/workflows/generate  (workflow.edit)
async function generateDraft(input, actor) {
  assertPermission(actor, 'workflow.edit', scope);
  assertNoPhi(input.content);              // PHI-in-source guard (BAA rule)
  const { draft, provenance } = await draftGenerator.generate(input);

  // Draft is schema-conforming (structured output) but NOT yet semantically valid.
  // Run the validator to surface graph/reference errors for the human — but do NOT
  // block saving the draft; the human fixes flagged issues in the builder before publish.
  const check = validateWorkflow(draft);   // returns { valid, errors[] }

  const def = await repo.createDefinition({
    draft_document: draft,
    draft_origin: 'ai',
    ai_source_type: input.sourceType,
    status: 'draft',
  });
  audit('workflow.ai_draft_generated', { definitionId: def.id, sourceType: input.sourceType });
  return { definitionId: def.id, draft, validation: check };  // human reviews next
}
```

At publish time, the AI provenance is frozen onto the immutable version, and `published_by` is always the reviewing human — so the audit trail forever records that a version originated from AI *and* which person approved it:

```
publish(): ...
  INSERT workflow_version(
     json_document = draft_document,
     ai_generated  = (definition.draft_origin = 'ai'),
     ai_source_type = definition.ai_source_type,
     published_by  = actor.userId)     -- the human, never the AI
```

**Publish (transactional).**
```
authz: workflow.publish
validate(draft_document) → must pass
v = max(version_number for definition) + 1
INSERT workflow_version(json_document = draft_document, version_number = v)
UPDATE workflow_definition SET current_version_id = new, status='published'
reconcile roles: upsert role rows for doc.roles (assignable in RBAC)
audit('workflow.publish')
```

**Extending a published workflow later.** Adding a new check, role, custom action, gate, escalation rule, or notification after go-live is a **draft edit + republish** — never a code change — because all of it is workflow data. Open the current version into a new draft, add the item (e.g. one object in a stage's `actions` array), validate, publish → a new immutable version. **In-flight cases keep running on their pinned version; only cases raised after publish see the change.** The one thing that ever requires engineering is a new *system* permission code (Category-1), because only those have real engine behavior; a new checklist item is always just data. To make a newly added check mandatory, set `blocks_advance: true` on the action itself — the advance gate is derived from that flag, so there is no second edit to keep in sync.

**Amendment (businessLogic §4) — templates, adoption, contract extensions.**

*Scope & lineage.* Templates exist at three scopes. **Platform** templates contain no PHI and live in a global no-RLS table `platform_workflow_template(id, name, diagnosis_type_id, document jsonb, version)`, authored by platform admins. **Tenant** and **facility** templates are `workflow_definition` rows (`owner_scope` gains `'tenant'|'facility'`, already present). New columns: `source_kind ('platform'|'tenant'|'facility'|null)`, `source_id`, `source_version` — the lineage of a copy. Clone = new definition with lineage. Share = `workflow_share(definition_id, facility_id)` within the tenant. Grant edit = `workflow_editor(definition_id, user_id)`.

*Adoption = private copy* (closes brief gap §4.3). `POST /workflows/:id/adopt {facilityId}` copies the source's current version into a **new facility-owned `workflow_definition`** with lineage, and publishes v1 of it. So one hospital's later edits never affect another hospital. Table `workflow_adoption(facility_id, diagnosis_type_id, definition_id, active)` with a partial unique index `(tenant_id, facility_id, diagnosis_type_id) WHERE active` = one active workflow per hospital per diagnosis. Adoption requires the diagnosis to be allowed at the facility (`facility_diagnosis`). Republishing creates version+1 on the same definition; in-flight cases stay pinned (unchanged rule). "Upstream changed" is surfaced by comparing `source_version`; pulling an upstream change = an explicit re-copy into the draft, never automatic.

*Auto Case Manager role.* Every new definition gets a `CASE_MANAGER` role with `full_case_access: true`; the validator rejects a doc without it.

*WorkflowDoc contract extensions (C1–C12; add to the zod contract at M3, bump `metadata.schema_version`).* These are on top of implementationPlan's 8 extensions.
- **C1** `metadata.topology: 'single_hospital' | 'cross_hospital'` (origin → destination).
- **C2** `RoleDef.staffs: 'origin' | 'destination' | 'any'` — which facility the team builder resolves the role against. `RoleDef.on_call_required: boolean` (renames `scheduling_required`). `RoleDef.full_case_access: boolean`.
- **C3** `Stage.lifecycle: 'initial'|'intermediate'|'final'|'terminal'` and `Stage.kind: 'form'|'decision'|'action'|'alert'|'terminal'` (replaces `type`).
- **C4** Stage roles: `Stage.roles: { main_actor: string[]; secondary?: string[]; participating?: string[]; visible_to?: string[]; editable_by?: string[] }` (replaces `actor_roles`). `participating` = paged on entry.
- **C5** `Stage.sla_minutes` required on non-terminal stages.
- **C6** DataField types: `text|number|select|multi_select|date|datetime|checkbox|yes_no|ecg_upload|vitals_form` (+ future `document_upload` gap). `DataField.edit_roles?: string[]` (field-level edit rights; empty = anyone on the case), `DataField.clinical_field_code?` (link to the clinical field catalogue that drives Epic prefill; supersedes ad-hoc `ehr_source`). Validator rule: `required` is ignored for `yes_no`/`checkbox` (brief §5.4).
- **C7** Transition presentation on system actions: `style: 'primary'|'secondary'|'danger'`, `order: number`, `automatic?: boolean` (auto-fires when its required fields are complete).
- **C8** `Stage.outcome?: 'closed'|'cancelled'|'transferred'` on terminal stages. Case status is derived from this flag — **never** from a stage name containing "Reject" (brief §5.2 rule replaced by an explicit field).
- **C9** Escalation `action` adds `'code_blue'` (critical alert to whole team); `'notify'` also adds the targets to the team (brief §6.4). Conditions add operator `contains`.
- **C10** `RoleDef.workflow_permissions: { raise, complete, accept, list, view, edit: boolean }` — UI-friendly flags; at publish they compile into the role's catalog codes (mapping in Phase 2 amendment).
- **C11** `metadata.accept_semantics: 'first_active' | 'accept_action'` — when `case.accepted` fires (brief §5.5: single-hospital = first time Active; cross-hospital = Accepting MD's accept action).
- **C12** `Stage.notifications[].channels` includes `'email'` (gap) alongside push/in_app/sms/voice.

*AI builder.* The `WorkflowDraftGenerator` gains `revise(draft, feedback)` and accepts PDF/DOCX (text extracted server-side); generation runs as a background job with status polling. Unchanged rules: AI never publishes, never invents catalog codes (Phase 14).

**API.**
```
POST  /api/v1/workflows/:id/adopt               (workflow.assign) private copy for a facility
POST  /api/v1/workflows/:id/clone | /share | /editors
POST  /api/v1/workflows                         (workflow.edit)  create draft (human)
POST  /api/v1/workflows/generate                 (workflow.edit)  AI-generate a draft from source
PUT   /api/v1/workflows/:id/draft                (workflow.edit)  edit draft doc
POST  /api/v1/workflows/:id/validate             → { valid, errors[] }
POST  /api/v1/workflows/:id/publish              (workflow.publish)  human-only; freezes version
GET   /api/v1/workflows/:id/versions
GET   /api/v1/workflows/:id/versions/:v          → json_document (for builder UI)
POST  /api/v1/workflows/:id/assign               (facility assignments)
```

---

## Phase 4 — The Workflow Engine (Case Execution)

### HLD

**Purpose:** instantiate a case from a published version and drive it through stages with authorization, data validation, event logging, and concurrency safety. The largest phase.

**Case as pinned state machine.**
```
raiseCase(workflowDefId, facilityId):
   version = definition.current_version   → PINNED onto the case
   entry   = version.doc.stages.find(is_entry)
   create Case(current_stage = entry.id, status='active')
   create CaseStageState(entry, status='active')
   write CaseEvent('case.raised')
   run stage-entry effects → notifications + SLA timers (Phase 5)
```

**Action processing (the executor).** Every action is validated against the *pinned* document, authorized, applied under optimistic lock, and logged.

> **`[DEEP-DIVE]`** state-machine executor + transition/condition semantics (concurrency, partial completion).
> **`[DEEP-DIVE]`** media/attachment handling for ECG/imaging/video fields.

**Concurrency:** optimistic locking via a `version` column on `Case`; `Idempotency-Key` dedupes client retries.

### LLD

**Schema (per-tenant, PHI-bearing → RLS + full audit).**
```sql
CREATE TABLE clinical_case (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  facility_id        uuid NOT NULL,
  workflow_version_id uuid NOT NULL,     -- PINNED
  current_stage_id   text NOT NULL,      -- stage id within the doc
  status             text NOT NULL CHECK (status IN ('active','closed','rejected')),
  patient_ref        jsonb,             -- linked patient (Phase 6) or manual
  raised_by          uuid NOT NULL,
  raised_at          timestamptz NOT NULL DEFAULT now(),
  closed_at          timestamptz,
  lock_version       int NOT NULL DEFAULT 0,   -- optimistic lock
  UNIQUE (tenant_id, id)
);

CREATE TABLE case_stage_state (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  case_id       uuid NOT NULL REFERENCES clinical_case(id),
  stage_id      text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','active','complete','skipped')),
  captured_data jsonb NOT NULL DEFAULT '{}',  -- CURRENT snapshot of this stage's field values,
                                              -- keyed by DataField.id (the "running balance"):
                                              -- fast read path for clients; mutable if a value is corrected
  entered_at    timestamptz,
  completed_at  timestamptz,
  actor_user_id uuid
);

CREATE TABLE case_event (               -- IMMUTABLE ledger; feeds metrics (Phase 7)
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  case_id       uuid NOT NULL,
  stage_id      text,
  event_type    text NOT NULL,          -- 'case.raised','stage.entered','data.captured',
                                        -- 'action.performed','case.transitioned','case.closed'
  actor_user_id uuid,
  payload       jsonb,                  -- for action.performed: { action_id, data:{fieldId:value} }
  occurred_at   timestamptz NOT NULL DEFAULT now()
);
-- Where captured action/field data lives: it is written to BOTH.
--   case_event   = the immutable ledger (who did what, when, with what values) — source of truth
--   case_stage_state.captured_data = the derived current snapshot (fast reads, correctable)
-- If they ever disagree, the event log wins; captured_data can be rebuilt by replaying events.

CREATE TABLE case_participant (         -- CASE-SPECIFIC grants: a role attached to ONE live case
  case_id     uuid NOT NULL,
  user_id     uuid NOT NULL,
  role_id     text NOT NULL,            -- grants this user this role on THIS case only
  added_at    timestamptz NOT NULL DEFAULT now(),
  added_by    text NOT NULL,            -- 'workflow' | 'escalation' | user_id
  PRIMARY KEY (case_id, user_id, role_id)
);
-- Populated when add_team (escalation) or an admin pulls someone into a running case
-- (e.g. ECMO/shock team). This is the third authorization source, alongside the role's
-- system permissions and a stage-action's allowed_roles.

CREATE TABLE idempotency_key (
  key         text PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  response    jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
```

**Executor — perform action (pseudocode).**
```ts
async function performAction(caseId, stageId, actionId, data, actor, idemKey) {
  return withIdempotency(idemKey, async () => {
    const c = await repo.lockCase(caseId);              // reads lock_version
    const doc = await versions.doc(c.workflow_version_id);
    const stage = doc.stages.find(s => s.id === stageId);
    const action = stage.actions.find(a => a.id === actionId);

    if (c.current_stage_id !== stageId) throw ApiError('stage_not_active');

    // 1. AUTHORIZE — depends on action type
    assertUserRoleIn(actor, action.allowed_roles, caseId);   // always: stage-action role gate
                                                             // (roles from RBAC membership OR case_participant)
    if (action.type === 'system')
      assertPermission(actor, action.permission_code, c.facility_id, defOf(c));  // + RBAC catalog gate
    // custom actions have NO second gate — allowed_roles is the whole check

    // 2. VALIDATE + STORE captured data → written to BOTH stores
    validateData(action.required_data_fields, data);
    persistCapturedData(caseId, stageId, data);         // → case_stage_state.captured_data (snapshot)
    writeEvent('action.performed', caseId, stageId, actor, { action_id: actionId, data });  // → case_event (ledger)

    // 3. ENGINE BEHAVIOR — only system actions have any
    if (action.type === 'system') runEngineBehavior(action.permission_code, caseId);  // accept→assemble team, etc.
    // custom actions do nothing further — they are authorize + record only

    // 4. TRANSITION (if this action moves the case)
    if (action.transitions_to) {
      // advance gate: block if any blocks_advance custom action in this stage is unrecorded
      const required = stage.actions.filter(a => a.type === 'custom' && a.blocks_advance);
      for (r of required)
        if (!hasEvent(caseId, stageId, 'action.performed', r.id))
          throw ApiError('blocked_pending_required_action');
      const next = doc.stages.find(s => s.id === action.transitions_to);
      await repo.completeStage(caseId, stageId);
      if (next.type === 'terminal') closeCase(caseId, next);
      else enterStage(caseId, next.id);                 // runs entry effects (Phase 5)
      writeEvent('case.transitioned', caseId, stageId, actor, { to: action.transitions_to });
    }
    // transitions_to === null → checklist action; case stays in the stage

    await repo.bumpLock(caseId, c.lock_version);        // fails if changed → 409 retry
    return caseView(caseId);
  });
}
```
> **The two-gate vs one-gate rule in one place (step 1):** every action checks `allowed_roles`; a **system** action *additionally* checks the catalog permission via RBAC. A user's roles for that check come from either their RBAC memberships *or* a `case_participant` grant on this specific case (the mid-case add_team path). Custom actions are authorized by role list alone and never run engine behavior.

**Decision stages (action-centric model).** Transitions live on each action (`action.transitions_to`), not in a separate `transitions` array — so a `decision` stage is simply a stage whose actions branch to different targets. `accept` → assembly stage, `reject` → rejected terminal. The executor above resolves the target directly from the pressed action; there is no separate condition-evaluation step. A `custom` action with `transitions_to: null` in a decision stage (e.g. "to CT first") is a logged, non-advancing choice that leaves the case in place for a later re-decision.

**API.**
```
POST /api/v1/cases                          (case.raise)   raise a case
GET  /api/v1/cases?status=&facilityId=       list (scoped)
GET  /api/v1/cases/:id                        full state + stage history
POST /api/v1/cases/:id/stages/:stageId/data  (stage.capture) capture/patch fields
POST /api/v1/cases/:id/stages/:stageId/action (stage.advance/case.accept/...) 
POST /api/v1/cases/:id/close                  (case.close)
POST /api/v1/cases/:id/media                  (upload → returns object ref)  [DEEP-DIVE]
```

**Amendment (businessLogic §5) — case shape, statuses, raise rules, field edit rights.**

*`clinical_case` changes.*
```sql
  case_number          text NOT NULL,     -- 'c-0001', per-tenant sequence (tenant_case_seq); UNIQUE (tenant_id, case_number)
  origin_facility_id   uuid NOT NULL,     -- replaces facility_id
  destination_facility_id uuid,           -- required iff topology = cross_hospital
  status  CHECK (status IN ('pending','active','closed','cancelled','transferred')),
  patient_first_name text, patient_last_name text, patient_dob date NOT NULL,
  mrn text, ehr_patient_id text,          -- PHI columns; replaces patient_ref jsonb
  raised_as_kind text CHECK (raised_as_kind IN ('workflow_role','department_role')),
  raised_as_role_id uuid,
  sla_due_at timestamptz,                 -- current stage SLA (denormalised from sla_timer)
  ems_alert_id uuid, transfer_request_id uuid,   -- origin links (Phases 11/12)
  priority text,                          -- (gap) nullable until priority/severity is specified
```
Case number uses a per-tenant counter row updated in the same transaction (`UPDATE ... RETURNING`), not a Postgres sequence, so it stays tenant-local.

*Statuses (brief §5.2).* `pending` = raised, entry stage has no way forward yet; `active` = moved past entry or accepted; terminal statuses come from the terminal stage's `outcome` (C8). `closed`/`cancelled`/`transferred` cases are **frozen**: the executor rejects every data/action call with `case_frozen` (409). (Gaps, designed now: `case.reopen`, manual `case.close`/`case.cancel` system actions available on every non-terminal stage when the workflow enables them.)

*Raise preconditions (brief §5.3)* — all checked in `raiseCase`, each failure a distinct error code so the client can show the block reason:
- caller holds a workflow role in the entry stage's `roles.main_actor ∪ participating` with `case.raise` (or raises **as a department role** if an active member of a department flagged `receives_ems_alerts` at a facility that adopted the workflow);
- `destination_facility_id` required for `cross_hospital`, forbidden for `single_hospital`; destination must be in tenant, active, and have adopted the same diagnosis;
- linked EMS alert / transfer must be `acknowledged`, not already converted, and caller must be an ED member of its destination;
- minimum data: patient name + MRN (DOB required per §5.1; Epic fills it when MRN found).
Immediately (same tx): stamp number + origin, record raiser, auto-advance past entry → `active`, add raiser to team (`source='raiser'`, real role), mark linked alert/transfer `case_created`. Post-commit (after-commit queue): team build, chat creation, timers, Epic prefill, AI chart review.

*Who may advance (brief §5.4).* Holder of `stage.advance` (normal stage) / `case.accept` (decision stage) for the workflow; otherwise the stage's `main_actor`, with `participating` as fallback. Required fields must be present (`yes_no`/`checkbox` excluded). This refines the executor's step 1; system vs custom action rules are unchanged.

*Field edit rights.* A data write is allowed if the caller has `full_case_access` (case manager) on an open case; otherwise the caller's role must be in the field's `edit_roles` (empty = anyone on the team) **and** in the stage's `visible_to ∪ editable_by`. Checked per field in `persistCapturedData`; one denied field rejects the whole write. "Save Details" = data write without action (`POST .../data`), unchanged.

*Timeline* = `case_event` (already). Event types added: `team.member_added`, `team.member_removed`, `escalation.fired`, `notification.sent`, `transfer.*`, `ems.*`.

*Lists (brief §5.8).*
```
GET /api/v1/cases?scope=mine|facility|tenant|all&workspaceFacilityId=&workflowId=&diagnosis=&status=&stage=&sla=
GET /api/v1/cases/counters?groupBy=workflow|stage
```
`mine` = on team in active workspace, or all workflow cases with `case.list`, or incoming cross-hospital cases for the destination; each row carries a `needs_action` flag (caller is main actor of current stage). `facility` needs HOSPITAL_ADMIN on that facility; `tenant` needs `case.view_all`; `all` = platform admin (cross-tenant read via a platform-admin path, Phase 15 note). Case monitor = `case.view_all` read-only (closes brief §2.2 partial).

*Uploads.* `ecg_upload` uses the existing presigned flow; `document_upload` (angiogram, documents, images) is the same mechanism with a different allowed MIME list (gap).

**Exit test.** STEMI v1 runs EMS pre-alert → ED activation → cardiologist accept → CathLab → CCU → discharge; reject path terminates; concurrent double-accept produces one success + one 409.

---

## Phase 5 — Notifications, SLAs, Escalations & Scheduling

### HLD

**Purpose:** the time-critical layer. Stage entry resolves roles → on-call users, fires multi-channel alerts with retry, arms SLA timers, and runs the escalation engine (including dynamic `add_team`).

**Data flow on stage entry.**
```
enterStage(stage):
  for each notification in stage.notifications:
     recipients = resolveOnCall(stage, notification.role_id, facility)   // scheduling
     for r in recipients: enqueue Notification(channel, sound, retry policy)
  for each sla: armTimer(case, stage, due = now + sla_minutes)  → Redis + persisted
  registerEscalationWatchers(case, stage)                        // vitals/time/data
```

**Reliability model.** Notifications go through a worker queue (BullMQ). Delivery + acknowledgment are events. Unacknowledged critical alerts fall back push → in-app → SMS/voice.

> **`[DEEP-DIVE]`** life-critical delivery guarantees (multi-channel fallback, provable ack, dead-man's-switch).
> **`[DEEP-DIVE]`** on-call resolution + scheduling integrations (Amion/Epic).
> **`[DEEP-DIVE]`** escalation-rule engine (vitals thresholds + dynamic team addition).

### LLD

**Schema (per-tenant).**
```sql
CREATE TABLE on_call_assignment (
  id           uuid PRIMARY KEY,
  tenant_id    uuid NOT NULL,
  facility_id  uuid NOT NULL,
  role_id      text NOT NULL,           -- workflow role code
  user_id      uuid NOT NULL,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  coverage_type text NOT NULL DEFAULT 'primary',  -- 'primary'|'backup'
  source       text NOT NULL DEFAULT 'manual'     -- 'manual'|'amion'|'epic'
);

CREATE TABLE notification (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  case_id       uuid NOT NULL,
  stage_id      text,
  target_user_id uuid NOT NULL,
  role_id       text NOT NULL,
  channel       text NOT NULL,          -- 'push'|'in_app'|'sms'|'voice'
  sound_type    text NOT NULL,          -- 'critical_alarm'|'standard_alarm'|'silent'
  status        text NOT NULL,          -- 'queued'|'sent'|'delivered'|'acknowledged'|'failed'
  retry_count   int NOT NULL DEFAULT 0,
  max_retries   int NOT NULL,
  sent_at       timestamptz,
  acknowledged_at timestamptz
);

CREATE TABLE sla_timer (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  case_id     uuid NOT NULL,
  stage_id    text NOT NULL,
  due_at      timestamptz NOT NULL,
  status      text NOT NULL DEFAULT 'armed'  -- 'armed'|'fired'|'cancelled'
);
```
Redis keys: `sla:{timerId}` (ZSET by `due_at` for the sweeper), `notif:retry:{id}`.

**On-call resolution (pseudocode).**
```ts
function resolveOnCall(roleId, facilityId, at = now()): UserId[] {
  const primary = query(`SELECT user_id FROM on_call_assignment
     WHERE facility_id=$1 AND role_id=$2 AND coverage_type='primary'
       AND $3 BETWEEN starts_at AND ends_at`, [facilityId, roleId, at]);
  return primary.length ? primary : backupFor(roleId, facilityId, at);
  // roles with scheduling_required=false → all in-scope, on-toggle users
}
```

**SLA sweeper worker.**
```ts
every 10s:
  due = redis.zrangebyscore('sla:index', 0, now());
  for (timerId of due) {
    t = load(timerId);
    if (stageStillActive(t.case_id, t.stage_id)) {
      stage = docStage(t);
      execute(stage.on_sla_breach);      // 'notify' | 'escalate' → notify_roles
      writeEvent('sla.breached', ...);
    }
    markFired(timerId); redis.zrem('sla:index', timerId);
  }
// persisted sla_timer reconciled on boot so a Redis flush never drops a timer
```

**Escalation engine.**
```ts
// evaluated on: data.captured, action.performed, vitals ingest, and time ticks
function evaluateEscalations(case, doc) {
  for (rule of doc.escalation_rules) {
    if (matched(rule.trigger_condition, case)) {
      switch (rule.action) {
        case 'notify':   notifyRoles(rule.notification); break;
        case 'escalate': notifyRoles(rule.notification, {escalated:true}); break;
        case 'add_team': for (r of rule.add_roles) {
            users = resolveOnCall(r, case.facility_id);
            addParticipants(case.id, r, users);       // writes case_participant rows →
            notify(users, rule.notification);          // grants the role on THIS case (mid-case join)
        }
      }
      writeEvent('escalation.fired', case.id, null, null, { rule: rule.id });
    }
  }
}
// trigger types:
//   data_field_check    — a captured field meets a condition (e.g. patient_stable == false)
//   time_elapsed        — N minutes since a given stage was entered (e.g. D2B 75-min warning)
//   vitals_threshold    — vitals cross AND/OR thresholds (e.g. sbp<90 AND hr>100 → shock)
//   action_performed    — a specific (usually custom) action was recorded (e.g. activate_mtp → notify blood bank)
```
> `action_performed` is what lets a **custom** action drive downstream behavior without any per-action engine code: the rule watches the event log for that action id and fires generically. This is how a site-specific "Activate MTP" button notifies the blood bank — declared as data, not coded.

**Amendment (businessLogic §6, §13) — case team, case managers, escalation fixes, notification catalogue.**

*`case_team_member` replaces `case_participant`* (RLS, tenant-first):
```sql
CREATE TABLE case_team_member (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL, case_id uuid NOT NULL,
  user_id uuid NOT NULL, role_id uuid NOT NULL, facility_id uuid NOT NULL,
  source text NOT NULL CHECK (source IN ('raiser','stage','escalation','case_manager','manual')),
  pick_reason text CHECK (pick_reason IN ('on_call','swap','rostered','fallback_all_assignees','override','manager','manual')),
  added_by uuid, added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz, removed_by uuid,           -- removal is a (gap) feature; soft-remove
  UNIQUE (tenant_id, case_id, user_id, role_id)
);
```
*Team builder* (on raise and every stage entry; replaces `resolveOnCall` call sites):
```ts
function buildTeamForStage(c, stage, doc) {
  for (roleId of union(stage.roles.main_actor, stage.roles.participating)) {
    const role = doc.roles[roleId];
    const facilityId = role.staffs === 'origin' ? c.origin_facility_id
                     : role.staffs === 'destination' ? c.destination_facility_id
                     : /* any */ both;                          // brief §6.1 step 1
    let picked = role.on_call_required ? availability.onCall(roleId, facilityId, now) : [];   // swap → schedule (Phase 10)
    if (!picked.length) picked = availability.available(roleId, facilityId, now);             // swap → rostered → assignees − approved time-off
    if (!picked.length) { notify.coverageGap(facilityId, roleId, c.id); continue; }            // nobody paged
    addMembers(c.id, picked, { source: 'stage', reasonPerUser });
  }
}
```
*Case managers.* Users holding a role with `full_case_access` at the origin (and the destination, for cross-hospital) are added on raise (`source='case_manager'`). A newly assigned manager is backfilled onto all open cases of that facility (job). **Closing brief gap:** removing the assignment soft-removes them from open cases. Adding members manually needs `case.add_member` (default: case managers only); removing needs `case.remove_member` (gap). Team join/leave is the single source for chat membership (Phase 8).

*Escalation fixes.* Each rule fires **once per case**: `escalation_firing(tenant_id, case_id, rule_id)` with a unique constraint. Target lookup is **restricted to the case's origin/destination facilities** (closes brief gap §6.4). `notify` = notify + add to team; `code_blue` = critical alert to every current team member. Time-based check every minute re-verifies the case is still active and on that stage. SLA state per stage: `pending|breached|resolved` on `sla_timer`.

*Notification catalogue.* `notification.type` is a closed enum mirroring brief §13.2: `stage_advanced, case_accepted, case_completed, team_assignment, escalation, code_blue, sla_warning, sla_breach, chat_message, group_call_incoming, coverage_gap, roster_at_risk, timeoff_requested, timeoff_decided, transfer_alert, transfer_acknowledged, transfer_declined, transfer_linked, ems_alert, ems_alert_acknowledged, ambulance_approaching, ambulance_arrived, ambulance_requested, ambulance_request_accepted, ambulance_request_declined, transport_status`. `case_id` becomes nullable (rostering/time-off alerts are not case-bound). Every notification is an **inbox** row (`read_at`); delivery fans out to in-app (socket), web push, and mobile push. Alarm sound for `ems_alert` and `ambulance_arrived` plus workflow-configured sound tiers. Retries, SMS, email, user preferences/quiet hours are gaps but use this same table (`channel`, `retry_count` already present).

**API.**
```
POST /api/v1/cases/:id/team            (case.add_member)   manual add
DELETE /api/v1/cases/:id/team/:memberId (case.remove_member) (gap)
GET  /api/v1/notifications?unread=     inbox · POST /api/v1/notifications/:id/read
POST /api/v1/facilities/:id/on-call                (schedule.manage)
POST /api/v1/on-call/toggle                         (self on/off-call)
POST /api/v1/notifications/:id/ack                  (acknowledge)
POST /api/v1/cases/:id/add-team                     (case.add_team) manual add
GET  /api/v1/cases/:id/notifications                history
```

---

## Phase 6 — EHR / Epic Integration Layer

### HLD

**Purpose:** cut duplicate entry (pre-fill stage fields from the EHR) and auto-raise cases from EHR events — per facility, isolated, asynchronous. The core engine never depends on it.

**Adapter pattern.** Core speaks one **internal FHIR-shaped model**; each facility has a connector adapter (Epic via SMART-on-FHIR/OAuth2; legacy via HL7v2 translator). Runs in an isolated integration service, queue-buffered.

```
Case raise → PatientLink (MRN | name/dob | recent-ED search)
   → connector.fetchPatient() → map to internal model
   → prefill stage.required_data_fields where marked ehr_source
EHR event (order-set) → inbound queue → matcher → auto-raise case (deduped)
```

> **`[DEEP-DIVE]`** per-EHR connector architecture + Epic onboarding (longest lead time).
> **`[DEEP-DIVE]`** inbound event ingestion + auto-raise safety (dedup, patient-match).

### LLD

**Schema (per-tenant).**
```sql
CREATE TABLE ehr_connection (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  facility_id   uuid NOT NULL,
  ehr_type      text NOT NULL,          -- 'epic'|'cerner'|'hl7v2'|...
  fhir_base_url text,
  auth_config_ref text NOT NULL,        -- secrets manager reference
  status        text NOT NULL DEFAULT 'inactive'
);

CREATE TABLE patient_link (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  case_id       uuid NOT NULL,
  ehr_patient_id text,
  mrn           text,
  linked_by     uuid,
  linked_at     timestamptz NOT NULL DEFAULT now()
);
```

**Connector interface (adapter contract).**
```ts
interface EhrConnector {
  searchPatients(q: { mrn?; name?; dob?; recentEdAdmits?: boolean }): Promise<PatientSummary[]>;
  fetchPatient(ehrPatientId: string): Promise<InternalPatient>;   // demographics
  fetchObservations(ehrPatientId: string, kinds: string[]): Promise<InternalObservation[]>; // vitals/labs
  subscribe(eventTypes: string[], cb): Promise<Subscription>;     // inbound triggers
}
// EpicConnector, Hl7v2Connector implement this; core code is connector-agnostic.
```

**Field pre-fill (pseudocode).**
```ts
async function prefillStage(case, stage) {
  if (!link(case)) return {};
  const conn = connectorFor(case.facility_id);
  const out = {};
  for (f of stage.required_data_fields.filter(f => f.ehr_source)) {
    out[f.id] = await mapField(f, conn, link(case).ehr_patient_id);  // minimum necessary
  }
  writeEvent('ehr.prefill', case.id, stage.id, null, { fields: keys(out) });
  return out;   // clinician confirms; never silently authoritative
}
```

**Amendment (businessLogic §7).**
- At raise: MRN → patient identity + **current encounter** (`Encounter` resource added to the connector interface: `fetchCurrentEncounter`). Also `fetchMedications`, `fetchConditions`.
- **First stage only.** Prefill runs once, for the entry/first active stage's fields that carry a `clinical_field_code` (C6). Later stages are manual.
- **Fill only empty fields** — never overwrite clinician-entered values. Computed field: MAP = (SBP + 2·DBP) / 3 when both present.
- Prefill runs post-commit as a job, so raise never waits on Epic. It writes `case_event('ehr.prefill', {fields: [ids]})` (names only, no values).
- **AI chart review** (Phase 14) is generated once per case after prefill, from the same minimum-necessary EHR pull.
- Gaps designed: recent-ED-admissions search (`searchPatients({recentEdAdmits})` already in interface), periodic sync, order-set inbound triggers.

**API.**
```
POST /api/v1/facilities/:id/ehr-connection      (ehr.manage)
GET  /api/v1/cases/:id/patient-search?mrn=&name=&dob=
POST /api/v1/cases/:id/link-patient
POST /internal/ehr/inbound                        (queue producer; auto-raise)
```

---

## Phase 7 — Metrics, QA/QI & Admin Dashboard APIs

### HLD

**Purpose:** turn the immutable `case_event` log into time metrics, QA/QI reports, and a live admin monitoring board. Read-optimized; scope-gated.

**Derivation model.** Events are the source of truth; metrics are derived (materialized views + rollup workers). Live board reads current case state; historical reports read materialized metrics.

```
case_event (append-only) ──▶ rollup worker ──▶ metric_fact (materialized)
                          └▶ live board (current-state query)
```

### LLD

**Schema (per-tenant).**
```sql
CREATE MATERIALIZED VIEW metric_case_intervals AS
SELECT
  c.id AS case_id, c.facility_id, c.workflow_version_id,
  min(e.occurred_at) FILTER (WHERE e.event_type='case.raised')          AS raised_at,
  min(e.occurred_at) FILTER (WHERE e.stage_id='ed_alert_activation')    AS ed_activated_at,
  min(e.occurred_at) FILTER (WHERE e.payload->>'field'='balloon_time')  AS balloon_at
FROM clinical_case c JOIN case_event e ON e.case_id = c.id
GROUP BY c.id, c.facility_id, c.workflow_version_id;
-- door_to_balloon = balloon_at - door_time; refreshed by rollup worker
```

**QA/QI query example (pseudocode).**
```ts
// cases breaching D2B target of 90 min
SELECT case_id, facility_id, (balloon_at - door_time) AS d2b
FROM metric_case_intervals
WHERE (balloon_at - door_time) > interval '90 min'
  AND facility_id = ANY($scopedFacilities);   // scope from permissions
```

**API.**
```
GET /api/v1/metrics/time-intervals?workflow=&facility=&from=&to=   (metrics.view / view_all)
GET /api/v1/metrics/qa/deficiencies?type=slow_ekg|late_accept
GET /api/v1/dashboard/live-cases?facilityId=                       live board feed
GET /api/v1/metrics/export/ncdr?caseId=                            registry support
```
Metric anchors come from workflow data, never hard-coded stage ids: a DataField or action may carry `metric_anchor: 'door' | 'first_medical_contact' | 'device' | 'accept' | ...` and the rollup reads those anchors (keeps "zero MSH-specific code"). The **case monitor** (businessLogic §2.2) is a read-only role with `case.view_all` + `metrics.view_all`. All §16 reporting items (D2B, SLA breach reports, QA/QI, weekly report) are built here.

Scope rule: `metrics.view_all` → all facilities in tenant; otherwise restricted to the caller's membership facilities. Aggregates de-identified where identity isn't required.

---

## Phase 8 — Real-Time Layer & Mobile Support Hardening

### HLD

**Purpose:** make clients live and resilient — WebSocket fan-out for case state/alerts/presence, push at scale, offline reconciliation, GPS ingestion.

```
engine state change ──▶ Redis pub/sub channel: case:{id}
                                 │
   WS gateway subscribes ────────┘──▶ authorized subscribers (scope-checked)
backgrounded device ──▶ APNs/FCM push (Phase 5 delivery guarantees)
```

**Subscription authorization.** A client may subscribe only to `case:{id}` channels for cases within its scope; the gateway checks permissions at subscribe time and on each tenant/scope change.

> **`[DEEP-DIVE]`** mobile offline strategy + conflict reconciliation.
> **`[DEEP-DIVE]`** location data handling, consent, retention.

### LLD

**WS gateway (pseudocode).**
```ts
onConnect(ws, principal):
   authenticate(principal);  // reuse Phase 2 token
onSubscribe(ws, 'case:'+id):
   assertPermission(principal, 'case.view', scopeOfCase(id));   // scope-checked
   redis.subscribe('case:'+id, msg => ws.send(msg));
// engine publishes on every case_event: redis.publish('case:'+id, {type, stage, at})
```

**Offline reconciliation model.**
```
client queues actions offline with client-generated Idempotency-Key
on reconnect: replay queued actions → server dedupes via idempotency_key (Phase 4)
             + optimistic lock_version resolves conflicts (409 → client refetches)
server pushes missed events since client's last-seen event id (cursor)
```

**GPS ingestion.**
```sql
CREATE TABLE case_location_ping (
  id          uuid PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  case_id     uuid NOT NULL,
  lat         double precision NOT NULL,
  lng         double precision NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL              -- retention policy enforced by purge job
);
```

**API / channels.**
```
WS   /realtime            subscribe: case:{id}, dashboard:{facilityId}
POST /api/v1/cases/:id/location   (EMS GPS ping; consent-gated)
GET  /api/v1/cases/:id/events?since={cursor}   (missed-event catch-up)
```

---

**Amendment (businessLogic §8, §12.4) — chat and GPS.**
- **One case chat per case**, created post-commit at **raise** (not on accept; this supersedes implementationPlan's multi-group `chat.groups` provisioning, which is kept only as an optional future extension). Members = active `case_team_member` rows; joining the team joins the chat. Any member may add people by name search or by **department group** (adds the group roster as `source='manual'` team members, so chat and team stay one list), remove others, leave, rename the chat.
- Messages: text only, ≤ 4,000 chars, **immutable** (no edit/delete — clinical record). Members-only read/post. Notification to other members unless their read cursor (`chat_read_cursor(user, thread, last_message_id)`) is already past the message; no in-app pop-up when the chat is open.
- **AI catch-up**: when a user joins a thread that has messages, generate a private summary visible only to them (`ai_summary.visibility_user_id`). Gaps designed: DMs, department chats, attachments, @mentions, read receipts, presence, lock-on-close, paging beyond 200 (keyset paging already planned).
- GPS: `case_location_ping` is superseded by trip-scoped `trip_location_ping` (Phase 12).

---

## Phase 9 — Organisation Structure: Departments, Groups, Invites, Workspace

### HLD
**Purpose:** model the hospital's internal structure (brief §2.1, §3.2, §3.3), which raises (ED department raise), EMS alerts (ED receives), transfers (Transfer Center), chat (group rosters) and EMS-case visibility (department heads) all depend on.

### LLD
```sql
CREATE TABLE department (id uuid PK, tenant_id uuid, facility_id uuid NOT NULL, name text NOT NULL,
  receives_ems_alerts boolean NOT NULL DEFAULT false,   -- "the ED"
  is_transfer_center  boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active',
  UNIQUE (tenant_id, facility_id, name));
CREATE TABLE department_role (id uuid PK, tenant_id uuid, department_id uuid NOT NULL, name text NOT NULL,
  is_department_head boolean NOT NULL DEFAULT false, UNIQUE (tenant_id, department_id, name));
CREATE TABLE department_group (id uuid PK, tenant_id uuid, department_id uuid NOT NULL, name text NOT NULL,
  status text NOT NULL DEFAULT 'active');
CREATE TABLE department_group_role (tenant_id uuid, group_id uuid, department_role_id uuid,
  PRIMARY KEY (group_id, department_role_id));          -- must be ⊆ the department's roles (service check)
CREATE TABLE department_group_member (id uuid PK, tenant_id uuid, group_id uuid, user_id uuid,
  department_role_id uuid NOT NULL, status text NOT NULL DEFAULT 'active',
  UNIQUE (tenant_id, group_id, user_id));
CREATE TABLE group_join_request (id uuid PK, tenant_id uuid, group_id uuid, user_id uuid,
  department_role_id uuid, status text CHECK (status IN ('pending','approved','rejected','withdrawn')),
  decided_by uuid, decision_reason text, created_at timestamptz, decided_at timestamptz);
-- partial unique: one pending request per (group, user)
CREATE TABLE invitation (id uuid PK, tenant_id uuid, email text, token_hash text, invited_by uuid,
  grants jsonb,   -- roles/memberships to create on accept
  status text CHECK (status IN ('pending','accepted','revoked','expired')), expires_at timestamptz);
CREATE TABLE user_preference (tenant_id uuid, user_id uuid PRIMARY KEY, default_facility_id uuid, default_workflow_def_id uuid);
```
**Rules.** Join request: requester's own facility only, role must be allowed by the group, group and department active, no duplicate pending, not already a member; **re-checked at decision**; reject needs a reason. Admin may change a member's role or deactivate a membership. Every group is usable as a chat roster (no mirror table needed — chat adds by `group_id`). **Invites**: accept link carries an opaque token; accepting creates/links the `app_user` (matched by email to the SSO identity at first login — JIT stays the auth path) and applies `grants`; an already-registered user is joined immediately. **Workspace** is client state `(facilityId, workflowId)` sent as query params; server validates membership; default stored in `user_preference`.

**API.** `/api/v1/facilities/:id/departments` · `/departments/:id/roles` · `/departments/:id/groups` · `POST /groups/:id/join-requests` · `POST /join-requests/:id/{approve,reject}` · `/invitations` (create, accept, revoke) · `PUT /me/preferences`.

**Exit test.** Join-request matrix (duplicate pending, non-member facility, inactive group, decision-time re-check); ED department raise permitted; group roster add to chat.

---

## Phase 10 — Scheduling: Roster, Swaps, Time Off, Amion

### HLD
Each facility uses **one** scheduling mode (`facility.scheduling_mode`). Both modes produce the same normalized **availability** answers consumed by the team builder (Phase 5 amendment), so the engine never knows which source was used.

```
roster pattern ─┐                       ┌─ availability.onCall(role, facility, t)
swaps ──────────┼─▶ availability svc ───┤
time off ───────┤                       └─ availability.available(role, facility, t)
Amion (hourly) ─┘   (on_call_assignment: source='amion'|'roster'|'manual')
```

### LLD
```sql
CREATE TABLE roster_shift_pattern (id, tenant_id, facility_id, user_id, weekday smallint,
  start_local time, end_local time,                -- may cross midnight
  effective_from date, effective_to date);         -- several per day allowed; applies to all user's roles at facility
CREATE TABLE roster_week (id, tenant_id, facility_id, week_start date, status text CHECK (status IN ('draft','published')));
CREATE TABLE roster_entry (id, tenant_id, roster_week_id, user_id, starts_at timestamptz, ends_at timestamptz);
CREATE TABLE shift_swap (id, tenant_id, facility_id, occurrence_start timestamptz, from_user_id, to_user_id,
  reason text NOT NULL, status text CHECK (status IN ('pending','approved','rejected')), requested_by, decided_by);
CREATE TABLE time_off (id, tenant_id, user_id, facility_id NULL /* NULL = all facilities */,
  rrule text,                                      -- once/daily/weekly/Nth weekday/monthly/yearly (RFC 5545 subset)
  all_day boolean, start_local time, end_local time,
  status text CHECK (status IN ('pending','approved','rejected')), requested_by, decided_by, reason text);
CREATE TABLE coverage_alert (id, tenant_id, facility_id, kind text CHECK (kind IN ('coverage_gap','roster_at_risk')),
  role_id, starts_at, case_id NULL, resolved_at);
-- Amion
CREATE TABLE amion_config (tenant_id, facility_id PK, password_secret_ref text, report_settings jsonb, last_sync_at, last_sync_status);
CREATE TABLE amion_raw_line (id, tenant_id, facility_id, pulled_at, raw jsonb);         -- stored as-is
CREATE TABLE amion_person_match (id, tenant_id, facility_id, amion_name text, user_id NULL, confidence numeric,
  method text CHECK (method IN ('exact','ai')), confirmed_by NULL, confirmed_at NULL);
CREATE TABLE amion_assignment_match (id, tenant_id, facility_id, amion_assignment text, role_id NULL,
  confidence numeric, confirmed_by NULL, confirmed_at NULL);
```
**Availability algorithm** (brief §6.1, §10): approved **swap** wins → else **rostered** for that time → else all assignees of the role at that facility minus **approved** time off (pending never counts). On-call-required roles first ask the on-call schedule (Amion or roster `on_call_assignment`), then fall back. Hospital closures are display-only and never stop paging. Double booking across facilities is resolved by marking the user off at the dropped facility (a `time_off` row).

**Amion jobs.** `:00` pull report for each active Amion facility → `amion_raw_line`. `:10` convert lines into `on_call_assignment(source='amion')` in the facility time zone (overnight split). Matching: exact first, then AI; ≥ 0.80 auto-suggested but **a human must confirm both person and role**; unconfirmed lines go to review queues and are not scheduled. Never creates users; only matches users already holding a role at that facility. Gaps designed: sync-failure alert (`coverage_alert`-style admin notification), Amion-derived swaps, raise gate (open product decision: hard vs soft block when raiser not on call — default **soft** warning until decided).

**At-risk detection.** On any time-off approval or roster change, recompute affected shifts; uncovered on-call-required roles → `roster_at_risk` notification to hospital admins.

**API.** `/facilities/:id/roster` (patterns, weeks, publish) · `/swaps` (request, approve) · `/time-off` (request, approve/reject) · `/me/schedule` · `/facilities/:id/on-call-board` · `/facilities/:id/amion` (config, sync now, roster-queue, assignment-queue, confirm).

**Exit test.** Availability matrix (swap > roster > assignees − approved time-off; pending time-off ignored; overnight shift; rrule Nth weekday); Amion fixture → confirmed lines scheduled, unconfirmed queued.

---

## Phase 11 — Hospital-to-Hospital Transfer (same tenant)

### HLD
A transfer is **two linked cases**, never one case changing hospitals: the source case stays at the sending hospital on its workflow; the receiving hospital raises its **own** case on **its own** adopted workflow. A `transfer_request` is the coordination object between them. Same tenant only (cross-tenant = Phase 15).

```
source case (A) ──transfer.raise──▶ transfer_request ──notify──▶ receiving ED (B)
     │ "transfer pending"              │ ack / decline
     │ (continues working)             ▼
     │                         B raises case from request ──▶ target case (B)
     └──── status=transferred ◀── linked both ways ─────────┘
                 optional: ambulance request (Phase 12)
```

### LLD
```sql
CREATE TABLE transfer_request (id uuid PK, tenant_id uuid,
  source_case_id uuid NULL,                      -- may be raised without a case
  from_facility_id uuid NOT NULL, to_facility_id uuid NOT NULL,
  to_department_id uuid,                         -- receiving ED (receives_ems_alerts) or transfer center
  patient_snapshot jsonb NOT NULL,               -- minimum necessary handoff data
  reason text, status text CHECK (status IN ('raised','acknowledged','declined','case_created','cancelled')),
  responded_by uuid, decline_reason text, target_case_id uuid NULL,
  created_by uuid, created_at, updated_at, lock_version int);
```
**Rules.** Raise needs `transfer.raise`; receiving ED members notified (`transfer_alert`). Ack/decline needs `transfer.respond` and membership in the receiving ED; sender notified. Source case shows pending and keeps working. Target case raised via normal `raiseCase` with `transfer_request_id` (precondition: request acknowledged, not converted, caller in receiving ED). In the same tx: request → `case_created`, `target_case_id` set, source case → `transferred` (frozen) via a system-level transition that writes `case_event('case.transferred')` on the source — the one status change not driven by a workflow action, and it is recorded in the ledger like any other. Links exposed both ways on case views. Ambulance optional (Phase 12 `transport_request.transfer_request_id`).

**API.** `POST /transfers` · `POST /transfers/:id/{acknowledge,decline,cancel}` · `GET /transfers?direction=incoming|outgoing` · `POST /cases {transferRequestId}`.

**Exit test.** A→B ack → B raises → A becomes transferred & frozen, links both ways; decline notifies sender; double conversion → 409.

---

## Phase 12 — EMS Providers, 911 Pre-Alerts, Inter-Facility Transport, Live Tracking

### HLD
EMS providers own a fleet and crew. **Today providers are tenant-owned** ("hospital-owned EMS", brief §12.1): the tenant admin links one provider and finalises the link, after which it is locked. Independent providers serving many tenants is the target state but is **deferred to Phase 15** with the cross-tenant design; the schema keeps `ems_provider` tenant-scoped now, so the later change is additive.

Three flows: **911 pre-arrival alert** (crew → ED), **inter-facility ambulance request** (Transfer Center → EMS admin → crew trip), **live tracking** (crew GPS during travel only).

### LLD
```sql
CREATE TABLE ems_provider (id, tenant_id, name, link_status text CHECK (link_status IN ('pending','finalised')), finalised_at);
CREATE TABLE ems_crew (id, tenant_id, ems_provider_id, user_id,
  certification text CHECK (certification IN ('emt','aemt','paramedic','first_responder','driver_only')), status);
CREATE TABLE ambulance (id, tenant_id, ems_provider_id, call_sign text,
  vehicle_type text CHECK (vehicle_type IN ('bls','als','micu','sct')),
  status text CHECK (status IN ('available','transporting','on_call','out_of_service')), active boolean);
CREATE TABLE ems_alert (id, tenant_id, ems_provider_id, ambulance_id, raised_by,
  destination_facility_id, destination_department_id,          -- the ED
  patient_first_name, patient_last_name, patient_dob, patient_sex, chief_complaint, vitals jsonb /* hr,bp,spo2,rr,gcs */,
  findings text, eta_minutes int,
  status text CHECK (status IN ('raised','acknowledged','arrived','case_created','cancelled')),
  acknowledged_by, selected_workflow_def_id, case_id NULL, trip_id uuid, created_at, lock_version);
CREATE TABLE transport_request (id, tenant_id, ems_provider_id, case_id NULL, transfer_request_id NULL,
  requested_by, priority text CHECK (priority IN ('emergent','urgent','scheduled')),
  vehicle_type text, pickup_at timestamptz, pickup_facility_id, dropoff_facility_id, clinical_needs text,
  status text CHECK (status IN ('requested','accepted','declined','cancelled')), decline_reason, decided_by);
CREATE TABLE trip (id, tenant_id, kind text CHECK (kind IN ('ems_alert','transport')), ems_alert_id NULL, transport_request_id NULL,
  ambulance_id, driver_user_id, paramedic_user_id,
  status text CHECK (status IN ('assigned','en_route_pickup','arrived_pickup','patient_picked_up',
                                'en_route_destination','arrived_destination','completed','cancelled')),
  dest_lat, dest_lng, last_lat, last_lng, last_ping_at, route_polyline text, road_distance_m int, eta_at timestamptz,
  approaching_notified_at, arrived_at, lock_version);
CREATE TABLE trip_location_ping (id, tenant_id, trip_id, lat, lng, accuracy_m, recorded_at, expires_at);  -- retention purge job
```
**911 alert:** crew (with `ems.alert.raise`) picks any active facility of the tenant + its available ambulance → ambulance `transporting`, trip created (kind `ems_alert`), every active member of the destination ED alerted with alarm sound. ED member acknowledges and picks a workflow (**cannot reject**); crew notified. Approaching alert at 2 km road distance; arrived by tap or auto within 150 m → ED alerted with sound, ambulance `available`. ED member raises case from the alert (Phase 4 precondition) → alert `case_created`.

**Inter-facility:** requester must be a team member at the sending facility with `ems.transport.request` (Transfer Center role or its admin) → provider's EMS admins notified. EMS admin accepts (picks own active available ambulance of the right type, driver, paramedic → trip, ambulance `on_call`) or declines with a reason. Crew advances one step at a time (`ems.trip.advance`); arrivals auto-advance at 150 m; requester notified each step; `completed` → ambulance `available`. Only the provider's EMS admins assign its vehicles/crew.

**Tracking:** mobile sends pings **only while status is an en-route state**; server rejects pings otherwise. Each ping updates trip position; ETA from a `RoutingProvider` interface (road distance + duration; vendor chosen later, PHI-free inputs: coordinates only). Refresh ETA every 60 s, every 15 s within 4 km. Geofence checks (2 km approaching, 150 m arrived) run on ping ingest, idempotent via `approaching_notified_at`/`arrived_at`. Real-time fan-out on `trip:{id}` channel. Viewers: the crew (own trip), destination ED members (incoming), the case team (case screen).

**Visibility (brief §12.5).** EMS Alerts list: destination ED members. EMS Cases list: ED members see cases they raised; department heads see all EMS cases at the facility; hospital admins not by default.

**Gaps designed:** fleet live location (`ambulance.last_lat/lng`), Transfer-Center-wide map, LIFENET 12-lead feed (inbound adapter → `ecg_upload`), nearest-hospital picker (routing provider + facility geo), pre-alert log, independent field EMS + incident dispatch (Phase 15).

**API.** `/ems/providers` (link, finalise) · `/ems/crew` · `/ems/ambulances` · `POST /ems/alerts` · `POST /ems/alerts/:id/{acknowledge,arrived,cancel}` · `POST /ems/transport-requests` · `POST /ems/transport-requests/:id/{accept,decline}` · `POST /trips/:id/advance` · `POST /trips/:id/pings` (batched) · `GET /trips/:id`.

**Exit test.** 911 alert → ack → pings → approaching at 2 km → auto-arrive at 150 m → case raised from alert; transport request accept → full trip state machine; ping rejected outside travel; wrong-provider assign → 403.

---

## Phase 13 — Calls & Video

### HLD
Behind a `CallProvider` interface (vendor under BAA chosen at phase start, e.g. Twilio Voice/Video or LiveKit), same isolation pattern as EHR/AI.

### LLD
- **Voice call to case creator** (brief §9.1): team member with `call.start` taps Call → provider bridges caller to the raiser's phone; recording + transcript stored in object storage (keys only in DB); post-call job → AI call summary → `ai_summary(kind='call')` shown on the case. Table `case_call(id, tenant_id, case_id, caller_id, callee_id, provider_ref, status, started_at, ended_at, recording_key, transcript_key)`.
- **Group video in the case chat** (brief §9.2): `video_session(id, tenant_id, chat_thread_id, provider_room, status ('live','ended'), started_by, started_at, ended_at)` + `video_participant(session_id, user_id, state ('ringing','joined','declined','missed','left'))`. Start when one is live = join. All other chat members ring (`group_call_incoming`); unanswered → `missed`; ends when last participant leaves (provider webhook). List = live + last 20.
- Gaps designed: video recording, 1:1 video, ringing when phone app is closed (VoIP push / CallKit).

**Exit test.** Fake provider: start/join/decline/missed/end matrix; call summary created after transcript webhook.

---

## Phase 14 — AI Features

All behind the `ai/` module with `PHI_VENDORS_BAA_CONFIRMED` gating, PHI-minimized prompts, deterministic fallbacks, never on the critical alerting path.

| Feature (brief §15) | Trigger | Output |
|---|---|---|
| Workflow builder | `POST /workflows/generate` (text or PDF/DOCX), `POST /workflows/:id/revise {feedback}` — background job | Draft `WorkflowDoc` via structured output; validator run; human applies/publishes |
| Clinical field linking | On draft save / on demand | Suggested `clinical_field_code` per field; human confirms |
| Epic chart review | Post-prefill, once per case | `ai_summary(kind='chart_review')` with decision-support disclaimer |
| Chat catch-up | User joins a thread with messages | Private `ai_summary(kind='chat_catchup', visibility_user_id)` |
| Call summary | Transcript ready | `ai_summary(kind='call')` |
| Amion matching | Amion sync | Person/role match suggestions with confidence; human confirms |

Existing plan item kept (not in the brief, already a user decision): missed critical alarm → AI voice call fallback (implementationPlan M8).

---

## Phase 15 — Cross-Tenant Exchange (deferred — design when phase starts)

Placeholder by decision (2026-10-14). Must answer: transfers between health systems; independent EMS providers serving many tenants (EMS crews seeing alerts/trips across tenants); a shared patient master; how platform super-admin "All Cases" reads across tenants. Constraint carried forward: shared-DB RLS stays the isolation boundary; any cross-tenant visibility must be explicit, audited, and minimum-necessary. Phases 11–12 are built same-tenant so this phase is additive.

---

## Appendix — Design Invariants (must hold across all phases)

- A live case's behavior is fully determined by its **pinned** `workflow_version_id`; no live edit changes it.
- Every state change writes exactly one authoritative `case_event`; metrics never bypass it.
- No query runs without `app.current_tenant` set via `SET LOCAL` inside the request transaction; in shared-DB mode RLS is the **sole** isolation boundary, so this is absolute.
- Every table carries `tenant_id`, a tenant-first index, and an RLS policy with both `USING` and `WITH CHECK`; a table without a policy is a leak.
- Permissions are resolved per-request, never baked into tokens (immediate revocation).
- PHI crosses no boundary lacking a BAA; the future AI integration inherits this rule.
- The AI produces drafts only; every published workflow version passes the same validator and is published by a human, whose id is recorded — the AI never publishes or activates anything.
- Only **system** actions carry a catalog `permission_code` and run engine behavior; **custom** actions carry no code, are authorized by `allowed_roles` alone, and are recorded-only. The validator enforces this boundary at publish.
- New permission *codes* come only from engineering; everything else (stages, roles, custom actions, gates, escalations, notifications) is added by editing a draft and republishing.
- Captured action/field data is written to both the immutable `case_event` ledger and the mutable `case_stage_state.captured_data` snapshot; the ledger is the source of truth.
- Every state-changing endpoint is idempotent under `Idempotency-Key`.
- A transfer is two linked cases; a case never changes facility. Source case status `transferred` is written as a `case_event`.
- Case status derives from the terminal stage's declared `outcome`, never from stage names. Terminal cases are frozen.
- Adoption creates a private facility copy; no hospital's edit can change another hospital's workflow.
- One team list per case (`case_team_member`); chat membership derives from it.
- Team building and escalation targets resolve only against the case's origin/destination facilities.
- Location pings are accepted only during active travel, are trip-scoped, and expire under a retention job.
- Until Phase 15, every row belongs to exactly one tenant, including EMS providers.

*Next step: expand the two highest-risk deep-dives — Phase 1 RLS/routing and Phase 4 executor — into full specs with concrete edge-case handling.*
