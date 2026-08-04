# Emergency Care Coordination Platform — Architecture Plan

**A multi-tenant, multi-hospital, multi-disease SaaS for time-critical clinical workflows (STEMI, Stroke, Trauma, OBGYN, Shock, and more).**

Version 0.1 — Architecture proposal for review. Backend: Node.js/Express · Web admin: React · Mobile: React Native · AI: third-party, integrated later.

---

## 1. Executive Summary

This platform generalizes the existing STEMI application into a configurable engine that any health system can adopt. The central design idea is that **a workflow is data, not code**. A STEMI pathway, a stroke pathway, and a trauma pathway are all the same engine executing different JSON definitions (like the sample workflow provided). This is what makes "multi-disease" and "customizable per health system" achievable without shipping new code for every hospital.

Four architectural pillars carry the whole design:

1. **A tenant hierarchy** — Tenant (health system) → Facility (hospital) → Workflow (care pathway) → Case (a live patient event) — with strict data isolation at every level.
2. **A workflow engine** that interprets versioned JSON definitions of stages, roles, notifications, SLAs, and escalation rules at runtime.
3. **Dynamic RBAC** where permissions are scoped to tenant, facility, and workflow, and roles are defined per workflow rather than hardcoded.
4. **An EHR integration layer** that abstracts each hospital's system (Epic and others) behind a common interface, pre-filling stage data where available.

Everything is built HIPAA-compliant from day one: encryption everywhere, complete audit logging, least-privilege access, and tenant isolation enforced in the data layer rather than trusted to application code alone.

---

## 2. Domain Model & Tenancy Hierarchy

Getting the core entities right is the foundation everything else rests on. The hierarchy is:

```
Tenant (Health System, e.g. "Mass General Brigham")
  └── Facility (Hospital, e.g. "MGH Main Campus")
        └── WorkflowDefinition (e.g. "STEMI v3", "Stroke v1")
              └── Case (a live patient event running through a workflow)
```

Alongside this operational hierarchy sits the identity/access model: **Users**, **Roles** (workflow-scoped), and **Memberships** (which user holds which role, at which facility, for which workflows).

### 2.1 Core Entities

| Entity                          | Purpose                                                     | Key relationships                                  |
| ------------------------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| `Tenant`                        | A health system; the top-level isolation boundary           | Has many Facilities, Users, WorkflowDefinitions    |
| `Facility`                      | A physical hospital within a tenant                         | Belongs to Tenant; has many Cases                  |
| `WorkflowDefinition`            | Versioned JSON pathway (stages, roles, SLAs, escalations)   | Belongs to Tenant; optionally scoped to Facilities |
| `WorkflowVersion`               | An immutable published version of a definition              | Belongs to WorkflowDefinition                      |
| `Role`                          | A workflow-scoped role (e.g. `INTERVENTIONAL_CARDIOLOGIST`) | Defined within a WorkflowDefinition                |
| `Permission`                    | An atomic capability (e.g. `case.accept`, `stage.advance`)  | Assigned to Roles                                  |
| `User`                          | A clinical or admin person                                  | Belongs to a Tenant; has Memberships               |
| `Membership`                    | Binds User → Role → Facility → Workflow(s)                  | The heart of dynamic RBAC                          |
| `Case`                          | A live instance of a workflow for one patient               | Belongs to Facility + WorkflowVersion              |
| `CaseStageState`                | Current + historical state of each stage in a case          | Belongs to Case                                    |
| `CaseEvent`                     | Immutable audit/event log entry (who did what, when)        | Belongs to Case                                    |
| `Schedule` / `OnCallAssignment` | Who is on-call for a role at a given time                   | Links Role + User + time window                    |

### 2.2 Why definitions are versioned and immutable

A `WorkflowDefinition` is edited freely while in **draft**. When an admin publishes it, the system freezes a `WorkflowVersion` (an immutable snapshot). **Live cases always pin to the version they started on.** This is non-negotiable in a clinical setting: you cannot have an admin editing the STEMI pathway mid-case and changing which cardiologist gets alerted for a patient already on the table. New cases pick up the new version; in-flight cases finish on the version they began.

---

## 3. Multi-Tenancy & Data Isolation Strategy

This is the most consequential decision in the whole design, because it drives HIPAA posture, cost, blast radius, and operational complexity. Here are the three standard models and my recommendation.

### 3.1 The three models

**Option A — Shared database, shared schema (row-level tenancy).**
Every table carries a `tenant_id` column; queries filter on it. Cheapest and simplest to operate, but isolation depends entirely on every query being correct. One missing `WHERE tenant_id = ?` is a cross-tenant PHI leak. Weakest isolation.

**Option B — Shared database, schema-per-tenant.**
One PostgreSQL database, one schema (namespace) per tenant. Stronger logical isolation, per-tenant migrations possible, still reasonably economical. Scales to a few hundred tenants comfortably; thousands of schemas become an operational strain.

**Option C — Database-per-tenant.**
Each tenant gets its own database (or its own instance). Strongest isolation, simplest compliance story ("your data lives in its own database"), easy per-tenant backup/restore and geographic placement. Higher cost and more operational overhead (migrations must fan out across N databases).

### 3.2 Recommendation: a hybrid, defense-in-depth approach

For a HIPAA platform handling emergency PHI, I recommend **schema-per-tenant on PostgreSQL as the default, with database-per-tenant available for large or high-sensitivity tenants** — combined with **PostgreSQL Row-Level Security (RLS) as a mandatory safety net**.

The reasoning:

- **Schema-per-tenant** gives you real isolation without the operational weight of thousands of databases from day one. Each tenant's tables live in their own namespace, so an accidental cross-schema query is structurally far harder than a forgotten `WHERE` clause.
- **RLS as a backstop** means even within a schema, the database itself enforces that a connection scoped to Tenant A cannot read Tenant B's rows. You set a session variable (`SET app.current_tenant = '...'`) on each request, and RLS policies filter automatically. This protects you when application code has a bug — the database refuses to leak.
- **Database-per-tenant as an upgrade path** for enterprise customers who contractually require physical isolation or data residency in a specific region. The application talks to a connection router that resolves the right database/schema per request, so the app code doesn't change.

This layered approach (schema boundary + RLS + application-level tenant scoping) is defense-in-depth: three independent mechanisms must all fail simultaneously to leak PHI across tenants.

### 3.3 Why PostgreSQL

For this platform, **PostgreSQL is the best-suited primary database**, for concrete reasons:

- **Native Row-Level Security** — the isolation backstop described above is a first-class Postgres feature.
- **`JSONB` columns** — workflow definitions, per-stage data fields, and vitals payloads are naturally semi-structured. `JSONB` lets you store the flexible workflow JSON _and_ index into it, giving schema flexibility without giving up query power. This directly serves the "dynamically created workflow" requirement.
- **Strong relational integrity** for the parts that must be strict: tenancy, memberships, audit logs, case state transitions.
- **Mature managed offerings** — AWS RDS/Aurora and Azure Database for PostgreSQL both sign BAAs (essential for HIPAA), handle encryption at rest, automated backups, and point-in-time recovery.

You get the best of both worlds: rigid relational structure where safety demands it (auth, audit, tenancy), and schema-flexible `JSONB` where the domain is genuinely dynamic (workflow definitions and stage data).

### 3.4 Supporting data stores

- **Redis** — session state, real-time presence ("who has viewed this case"), notification retry queues, SLA timers, and pub/sub for live case updates pushed to mobile/web.
- **Object storage (S3 / Azure Blob, encrypted, BAA-covered)** — ECG images, videos, and documents attached to stages. Store only references (keys) in Postgres; never the binaries. Access via short-lived signed URLs.
- **A time-series or append-only event store** — the `CaseEvent` log (for time metrics and audit) can live in Postgres initially; if event volume grows, move it to a dedicated append-only store. Time metrics (door-to-balloon, alert-to-acceptance) are derived from this log.

---

## 4. The Workflow Engine — The Heart of the Platform

The sample JSON you provided is essentially the specification for this engine. The engine's job is to load a `WorkflowVersion`, instantiate a `Case`, and drive it through stages while enforcing SLAs, firing notifications, and evaluating escalation rules.

### 4.1 Anatomy of a workflow definition

Building on your sample, a definition contains four collections:

- **Stages** — ordered steps, each with a `type` (`action`, `decision`, `terminal`), the `actor_roles` who act on it, `required_data_fields` (which can be EHR-prefilled), `notifications`, `transitions`, and `sla_minutes` with `on_sla_breach` behavior.
- **Roles** — workflow-scoped roles with properties like `can_raise_alarm`, `scheduling_required`, and `default_notification_sound`.
- **Escalation rules** — triggered by data-field checks, elapsed time, or vitals thresholds; actions include `notify`, `escalate`, and `add_team` (this is your "add ECMO/shock team mid-case" requirement).
- **Metadata** — version, clinical category, tenant, provenance (including whether AI-generated).

### 4.2 State machine execution

Each case is a state machine. The engine:

1. Instantiates the case at the `is_entry` stage.
2. Records a `CaseStageState` and a timestamped `CaseEvent` for entry.
3. Fires the stage's `notifications` (resolving roles → actual on-call users via the scheduling system).
4. Starts SLA timers (in Redis) for `sla_minutes`.
5. On a user action, validates the actor holds a role in `actor_roles` **and** has the required permission, validates `required_data_fields`, evaluates `transitions`, and moves the case forward — writing a new event each time.
6. Continuously evaluates `escalation_rules` against incoming data and elapsed time.

### 4.3 Tiered and dynamic alerting

Your requirement that "STEMI may need one tier, stroke needs 2 or 3" is handled by making notifications a per-stage, per-role list with independent `sound_type`, `retry_interval_minutes`, `max_retries`, and `sla_alert_minutes`. Tiers emerge naturally: tier 1 is the initial notification set; adding a group later (the ECMO/shock team) is an `add_team` escalation action that injects new roles into the live case and notifies them. This directly satisfies "add groups of specialists after a case is raised."

### 4.4 SLA timers and time metrics

Two distinct mechanisms:

- **SLA breach handling** — Redis-backed timers per stage. On breach, the engine executes `on_sla_breach` (notify or escalate). This powers "alerts when conditions aren't met on time."
- **Time-metric extraction** — every transition and action writes an immutable `CaseEvent` with a server timestamp. Metrics like door-to-balloon, EMS-alert-to-ED-activation, and alert-to-acceptance are computed from this log. This is the substrate for both real-time SLA warnings and retrospective QA/QI. (Note the sample's 75-minute door-to-balloon warning escalation rule — this is exactly that pattern.)

### 4.5 The workflow builder (admin-facing)

The admin portal edits definitions through a visual builder that reads/writes this JSON. Admins can add/remove stages, reorder them, define roles, wire transitions, set SLAs, and configure escalation rules — then publish, which freezes a new version. When the third-party AI is integrated later, the "AI Workflow Builder" (feature E) simply produces a draft definition in this same JSON shape, which the admin reviews and publishes — no separate pipeline needed.

---

## 5. Dynamic Role-Based Access Control (RBAC)

The requirement is that admins decide which permissions attach to which users, dynamically per workflow. This calls for a **permission-based RBAC model scoped to the tenancy hierarchy.**

### 5.1 The layers

- **Permissions** are atomic and system-defined (e.g. `case.view`, `case.raise`, `case.accept`, `stage.advance`, `workflow.edit`, `user.manage`, `metrics.view_all`). These are the fixed vocabulary of things one can do.
- **Roles** are collections of permissions, defined _within a workflow definition_ (so `INTERVENTIONAL_CARDIOLOGIST` in the STEMI workflow can carry different permissions than a role in the trauma workflow).
- **Memberships** bind a User to a Role, scoped to a **Facility** and one or more **Workflows**.

A user's effective permissions for any action are computed as: _the permissions of the roles they hold, filtered to the specific facility and workflow the action targets._

### 5.2 Scope is what makes it flexible

The requirements describe several access patterns; scoped memberships handle all of them:

- **"Certain people only ever need one workflow"** → a single membership scoped to one workflow at one facility.
- **"Others work at multiple hospitals on different days"** → multiple memberships, one per facility.
- **"Some need to view all cases as QA/QI monitors"** → a membership with a `metrics.view_all` / `case.view_all` permission scoped at the tenant level.
- **"Configure people to receive alerts only for procedures/locations they're associated with"** → notification targeting reads from the same memberships, so a user is only ever alerted for workflows and facilities they belong to.

### 5.3 Enforcement in three places

1. **API gateway / middleware** — every request resolves the user's tenant, facility, and workflow scope and checks the required permission before the handler runs.
2. **Database RLS** — the tenant backstop from §3.2, independent of application logic.
3. **Notification routing** — a user cannot be alerted for a case outside their scope, because the role→user resolution only considers scoped, on-call memberships.

### 5.4 Platform-level roles

Above the tenant sit a few platform roles: `super_admin` (Anthropic/your ops team — can provision tenants), `tenant_admin` (manages a health system, creates facilities and org-wide workflows), and `hospital_admin` (manages one facility, creates/customizes workflows for it). This matches your stated hierarchy where a hospital_admin can use a workflow created by the tenant_admin, super_admin, or himself.

---

## 6. EHR / Epic Integration Layer

Every hospital has its own EHR, so this layer must be pluggable. The strategy is a **common integration interface with per-facility connector implementations**, standardizing on **HL7 FHIR** wherever possible.

### 6.1 Standardize on FHIR, adapt at the edges

- **FHIR R4** is the modern standard and what Epic exposes via its app-integration program (and what most current EHRs support to some degree). Build the core integration against FHIR resources: `Patient` (demographics), `Observation` (vitals, labs), `DiagnosticReport` / `DocumentReference` (ECGs, imaging), and `Encounter` (ED admits).
- For older or non-FHIR systems, write a **connector adapter** that translates that hospital's interface (HL7 v2 messages, proprietary APIs) into the same internal FHIR-shaped model. The workflow engine only ever sees the normalized model.

### 6.2 What integration enables

- **Patient linking** — connect a case to a patient by MRN, name/DOB, or a search of recent ED admits (as the requirements describe), pulling demographics and available vitals to pre-fill stage data fields. Any `required_data_field` in a stage can be marked EHR-sourced; the engine fetches it rather than asking the clinician to re-enter it — eliminating duplicate effort.
- **Inbound triggers** — if the EHR emits an event (e.g. a STEMI order set created, via FHIR Subscriptions or an HL7 feed), the platform can auto-raise a case. This is the "automated alerts if certain conditions are met" requirement.

### 6.3 Auth and safety

- Epic integration uses **SMART on FHIR / OAuth 2.0**; each facility's connector holds its own credentials, stored in a secrets manager, never in the database.
- Integration runs through an **outbound integration service** isolated from the core API, so a misbehaving EHR connector cannot destabilize case handling. Communication is queue-buffered.
- All PHI in transit uses TLS; pulled PHI is subject to the same audit logging as everything else.

### 6.4 Reality check

EHR integration — especially Epic — is the longest-lead, highest-friction part of this platform. It involves per-health-system contracts, security reviews, and Epic's App Orchard / Connection Hub process. Architecturally, treat it as **optional and asynchronous**: the platform must be fully functional with manual data entry, and EHR pre-fill is an enhancement layered on per facility as each integration goes live. Do not let the core workflow engine depend on it.

---

## 7. System Architecture & Services

I recommend a **modular monolith to start, structured along clear service boundaries**, rather than premature microservices. You get clean separation and the option to split services out later under load, without the operational tax of distributed systems on day one.

### 7.1 Logical services / modules

| Module                   | Responsibility                                                           |
| ------------------------ | ------------------------------------------------------------------------ |
| **Auth & Identity**      | SSO (SAML/OIDC), session issuance, MFA, user provisioning                |
| **Tenancy & Admin**      | Tenant/facility/user management, connection routing                      |
| **Workflow Definition**  | CRUD + versioning of workflow JSON, the builder API                      |
| **Workflow Engine**      | Case instantiation, state transitions, SLA timers, escalation evaluation |
| **Notification**         | Role→user resolution, push/in-app delivery, retry logic, sounds/tiers    |
| **Scheduling / On-Call** | On-call assignments, coverage changes, Amion/Epic schedule sync          |
| **EHR Integration**      | FHIR connectors, patient linking, inbound triggers (isolated)            |
| **Audit & Metrics**      | Immutable event log, time-metric computation, QA/QI queries              |
| **Real-time Gateway**    | WebSocket/push fan-out to mobile & web for live case state               |

### 7.2 Request and real-time flow

- **REST/GraphQL API (Express)** for command and query operations from web and mobile.
- **WebSockets (via the real-time gateway, backed by Redis pub/sub)** for pushing live case updates, new alerts, and presence to connected clients.
- **Push notifications** (APNs/FCM) for waking mobile clients when the app is backgrounded — critical for a clinician who must be alerted to a STEMI at 3 a.m.
- **Background workers** (a job queue such as BullMQ on Redis) for SLA timers, notification retries, EHR polling, and metric rollups.

### 7.3 Notification delivery — the reliability-critical path

Alerts are life-critical, so this path needs redundancy: push notification _and_ in-app _and_ (for critical roles) escalation to a phone call or SMS via a telephony provider if the app isn't acknowledged. The `retry_interval_minutes` / `max_retries` in the workflow JSON drive this. Delivery and acknowledgment are themselves logged as events, so you can prove an alert was sent and seen — important for both quality and liability.

---

## 8. Security & HIPAA Compliance

HIPAA compliance is a property of the whole system, not a feature. The essentials:

### 8.1 Foundational controls

- **Encryption in transit** — TLS 1.2+ everywhere, including internal service-to-service traffic.
- **Encryption at rest** — database, object storage, and backups all encrypted (managed keys via KMS; consider per-tenant keys for enterprise isolation).
- **Business Associate Agreements (BAAs)** — required with every vendor that touches PHI: your cloud provider, managed database, object storage, telephony/push providers, and eventually the third-party AI vendor. **Do not send PHI to any service not under a BAA** — this is the single most common HIPAA violation for platforms like this, and it directly governs how the future AI integration must be handled.

### 8.2 Access and identity

- **SSO** via SAML 2.0 / OIDC, supporting Microsoft Entra ID (Azure AD) as called out, plus generic providers. Each tenant configures its own IdP.
- **MFA** for administrative access.
- **Least privilege** — the scoped RBAC of §5 is itself a HIPAA access-control measure; users see only the PHI for cases within their scope.
- **Automatic session timeout** and re-authentication for sensitive actions.

### 8.3 Auditability

- **Comprehensive, immutable audit logging** — every PHI access, every case action, every admin change, every alert sent. HIPAA requires you be able to answer "who accessed this patient's data, and when." The `CaseEvent` log plus a separate access log covers this.
- **Log integrity** — append-only, tamper-evident (e.g. write to storage with object-lock / WORM semantics for retention).

### 8.4 Operational and organizational

- **Data residency & isolation** — the tenancy model of §3 is the technical core; database-per-tenant is available where contracts demand physical separation.
- **Backup, disaster recovery, and tested restore** — automated, encrypted, with defined RPO/RTO.
- **Minimum necessary** — only pull the EHR fields a stage actually needs.
- **Breach detection & response plan**, **penetration testing**, and **a HIPAA risk assessment** are organizational must-haves alongside the technical build.
- Consider **SOC 2 Type II** in parallel — health systems will ask for it during procurement.

### 8.5 A note on the future AI features

Every AI feature described (call summarization, chart summarization, "Mommy Sofiya" monitoring, QA/QI, live recommendations) will process PHI. When you integrate the third-party AI: it must be under a BAA, PHI sent to it must be minimized and logged, and its outputs should be treated as **decision support, not autonomous action** — a human in the loop for anything that changes case state. Architecturally, expose AI through the same integration-service isolation pattern as EHR, so the AI vendor is swappable and contained.

---

## 9. Technology Stack Summary

| Layer                          | Choice                                                   | Rationale                                                                  |
| ------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Backend**                    | Node.js + Express (TypeScript)                           | Your preference; TypeScript strongly recommended for a domain this complex |
| **Primary DB**                 | PostgreSQL (schema-per-tenant + RLS)                     | Isolation, `JSONB` for dynamic workflows, BAA-ready managed hosting        |
| **Cache / real-time / queues** | Redis (+ BullMQ)                                         | Sessions, SLA timers, pub/sub, notification retries                        |
| **Object storage**             | S3 / Azure Blob (encrypted, BAA)                         | ECGs, imaging, videos — references stored in Postgres                      |
| **Admin web portal**           | React (TypeScript)                                       | Your preference; hosts the workflow builder and admin dashboard            |
| **Mobile (clinical users)**    | React Native (TypeScript)                                | Your preference; push notifications, alert sounds, GPS                     |
| **Real-time transport**        | WebSockets + APNs/FCM push                               | Live case state + waking backgrounded devices                              |
| **EHR integration**            | HL7 FHIR R4, SMART on FHIR / OAuth2                      | Standard, Epic-compatible, per-facility connectors                         |
| **Identity**                   | SAML 2.0 / OIDC, Entra ID + generic SSO, MFA             | Enterprise SSO requirement                                                 |
| **Scheduling integration**     | Amion / Epic scheduling adapters                         | On-call resolution                                                         |
| **Cloud**                      | AWS or Azure (BAA-covered, HIPAA-eligible services only) | Azure is a natural fit given Entra ID usage                                |

### A note on ORM and tenancy

Use an ORM/query builder that cleanly supports setting a per-request schema and session variable — **Prisma** (with a client-per-tenant or middleware approach) or **Knex/Objection** both work. Whatever you choose, the tenant-scoping and RLS session variable must be set in one central place (connection middleware) so no query can bypass it.

---

## 10. Suggested Build Sequence

A rough phasing that de-risks the hardest parts and gets a usable product early:

1. **Foundation** — tenancy hierarchy, auth/SSO, RBAC, PostgreSQL with schema isolation + RLS, audit logging. Nothing clinical works safely without this.
2. **Workflow engine + one hardcoded pathway** — port the existing STEMI workflow as data, prove the engine drives it end to end (raise → alert → accept → advance → close), with SLA timers and event logging. Web + mobile clients for this single flow.
3. **Workflow builder** — the admin UI to create/version/publish arbitrary pathways; add a second disease (e.g. stroke) purely as configuration to prove genericity.
4. **Notification depth** — tiers, retries, escalation to telephony, add-team mid-case, scheduling/on-call resolution.
5. **EHR integration** — start with FHIR patient-linking and demographic/vitals pre-fill at one pilot facility; add inbound triggers.
6. **Metrics & QA/QI dashboards** — time-metric reporting from the event log.
7. **AI integration** — layer in the third-party AI behind the isolation boundary, under a BAA, as decision support.

---

## 11. Key Risks & Open Questions

- **EHR integration effort is easy to underestimate** — treat it as parallel, per-facility, and optional to the core. (Flagged in §6.4.)
- **Alert reliability is life-critical** — the notification path needs redundancy and provable delivery/acknowledgment; invest here early.
- **Tenant count trajectory** — schema-per-tenant is right for tens-to-low-hundreds of tenants. If you expect thousands, revisit toward pooled schemas with strict RLS or selective database-per-tenant. _Open question: what's the 2–3 year tenant projection?_
- **Offline behavior on mobile** — clinicians may be in areas with poor connectivity; decide how much a device must function offline and how state reconciles.
- **Regulatory scope beyond HIPAA** — if any AI feature crosses into clinical decision-making, FDA SaMD (Software as a Medical Device) considerations may apply. Worth a legal/regulatory review before building features D and F.
- **GPS/location** — EMS GPS tracking (requirement 6) needs a clear consent and data-retention policy, as location is sensitive.

---

_This is a proposed architecture for team review, not a final specification. The next step would be to turn §2's domain model into a concrete schema and §4's engine into an interface definition._
