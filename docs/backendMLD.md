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

**API.**
```
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

**API.**
```
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

*Next step: expand the two highest-risk deep-dives — Phase 1 RLS/routing and Phase 4 executor — into full specs with concrete edge-case handling.*
