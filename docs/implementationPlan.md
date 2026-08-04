# Production MVP — Generic Emergency-Care Platform Backend (Express), MSH STEMI First Client

## Context

This repo (`cathaid-api`) is the **backend only** — Node.js + **Express** + TypeScript, per user decision (NestJS scaffold gets replaced). Clients live in separate repos: **React admin portal** (super-admin, tenant-admin, facility-admin) and **React Native mobile app** (facility users: providers, nurses, techs, transfer center). This API serves both.

`docs/backendMLD.md` is the spec-of-record — it is already written for Express (module layout, middleware order, Zod at the edge) and supersedes `docs/architecture.md` on tenancy: **shared DB, shared tables, tenant_id + mandatory Postgres RLS**. Goal: **production-grade MVP** running the MSH STEMI workflow (`docs/msh.md`) purely as **workflow data** — zero MSH-specific code paths — plus:

1. **EHR/Epic**: Raise Case with **MRN only** → patient name/DOB/phone prefill from Epic FHIR (sandbox target); generic `ehr_source` field mechanism.
2. **AI layer**: (a) missed critical alarm → **AI-initiated voice call** (Claude-generated TTS summary, DTMF 1=ack/2=decline via Twilio); (b) **AI summarization of provider-to-provider case chat**.
3. **Chat**: server-owned case-scoped group chat (replaces old PubNub client-built channels) + contact-provider directory.

User decisions (fixed): Express backend / React admin / RN mobile; chat only in MVP (video deferred); TTS-call for now (**revisit conversational voice agent later — ask again**); **SSO/OIDC auth now**; Epic **public FHIR sandbox**.

## Working process (user requirement — applies to every phase)

- **`docs/backendPhases/` folder**: one file per phase (`M<N>-<name>.md`) containing the **phase plan** (objectives, task breakdown, exit test) written BEFORE the phase starts, followed by a **progress section** updated as tasks complete.
- **`progress.md` at repo root**: readable cross-phase log. After **every completed task**, append an entry (date, task, what was done, files touched, test status) AND update the phase file's progress section.
- **Task discipline**: before executing a phase, create tasks via TaskCreate from the phase plan, then execute **one by one** (in_progress → completed, progress updates each time).
- CLAUDE.md rewrite (first task) encodes these rules so future sessions follow them.

## CLAUDE.md rewrite (first task)

Project `CLAUDE.md` is stale (NestJS commands, "Phase 1 = config authoring only, no case runtime/EHR/push", `steps_config`/`WorkflowTemplate`/`diagnosis-types` vocabulary). Rewrite: Express stack, backendMLD.md as spec-of-record, module map below, `WorkflowDoc` contract, commands (docker-compose, dev, seed, check-rls, tests), tenancy/RLS invariants, the working-process rules above. Drop `diagnosis-types` (taxonomy = `workflow_definition.clinical_category` text).

## Stack

- **Runtime**: Node ≥22, TypeScript (strict), ESM. Express 5.
- **DB**: PostgreSQL 16 + **Prisma 7** (already installed; new `prisma-client` generator, `prisma.config.ts`). Redis 7 (sessions, queues, cache, pub/sub). BullMQ.
- **Validation**: Zod everywhere (API edge + WorkflowDoc contract + env config), per MLD convention. OpenAPI via `@asteasolutions/zod-to-openapi` + `swagger-ui-express` at `/docs`.
- **Auth**: `openid-client` v6 (multi-tenant OIDC, PKCE, JIT provisioning); own access JWT signed/verified with `jose` (15 min; claims `sub`/`tid`/`sid` only) + opaque refresh sessions in Redis. Drop passport/bcrypt (SSO-only).
- **DI**: none — MLD Phase 0 pattern: each module exports a typed interface from `index.ts`; wiring in `app.ts` composition root.
- **Dev**: `tsx watch` dev server; `tsc` build; Jest (installed) + supertest; docker-compose (postgres, redis, keycloak w/ realm import, minio).
- **Logging**: pino + pino-http with **PHI scrubber** (redact key-paths + value-pattern scrub); correlation-id middleware.

## Architecture spine (from backendMLD.md)

- **Tenancy**: every table `tenant_id`, tenant-first indexes, tenant-composite uniques, RLS `ENABLE+FORCE`, policy `USING`+`WITH CHECK` on `current_setting('app.current_tenant', true)::uuid`. Runtime DB role `app_runtime` (non-owner, no BYPASSRLS); migrations run under separate owner URL (`DIRECT_DATABASE_URL`).
- **Per-request tenant tx (the one unbypassable mechanism)** — MLD Phase 1 pseudocode, hand-rolled with AsyncLocalStorage: tenant-scope middleware opens `prisma.$transaction(async tx => als.run({ tx, tenantId, afterCommit: [] }, ...))`, first statement `SELECT set_config('app.current_tenant', $1, true)`; commit on success / rollback on error; **after-commit queue** flushes BullMQ enqueues + domain-event emits only post-COMMIT. `src/infra/db/` exports only `getTenantDb()` (reads ALS, **throws if no store**) and narrow `platformDb` (tenant/permission/idp lookup pre-auth); raw PrismaClient not exported. ESLint `no-restricted-imports` on `generated/prisma` outside `src/infra/db/**`.
- **Middleware order (load-bearing)**: correlation → auth (JWT verify) → tenant-scope → authz (`requirePermission(perm, scopeFrom)`) → zod validate → handler → error handler (`{code, message, details}`, no stacks/PHI).
- **Workers/webhooks/WS run outside HTTP middleware** → shared `runInTenant(tenantId, fn)` (same ALS helper); every BullMQ job payload carries `tenantId`; enforced via a worker wrapper all processors go through.
- **Engine**: workflow-as-data. `WorkflowDoc` JSON (stages/roles/escalation_rules/chat/metadata), system vs custom actions, `blocks_advance` + `requires_prior_actions`/`advance_requires` gates, `action.transitions_to` state machine, optimistic `lock_version` (updateMany count=0 ⇒ 409), `Idempotency-Key` (row committed atomically with mutation), immutable `case_event` ledger + `case_stage_state.captured_data` snapshot. Cases pin an immutable `workflow_version`.
- **Decoupling seams** (`src/infra/events.ts`, typed EventEmitter): `notification.exhausted` → AI voice; `case.accepted`/`case.participant_added`/`case.closed` → chat provisioner + AI on-close summary; EHR consumed only via optional REST prefill (failure ⇒ manual entry proceeds). Core imports nothing from ehr/ai/chat.

## Repo layout (replaces NestJS scaffold; MLD Phase 0 shape)

```
src/
  app.ts  server.ts                  # composition root; module wiring
  middleware/  correlation, auth, tenant-scope, authz, validate, error, idempotency
  infra/
    db/          prisma client (private), getTenantDb(), platformDb, runInTenant
    redis/       ioredis factory
    queues/      BullMQ queue registry + tenant-aware worker wrapper
    events.ts    typed domain-event emitter + event-name constants
    storage/     S3/MinIO presigned URLs
    secrets/     Secrets adapter (env-backed now, cloud later) — no process.env in module code
    push/        PushProvider interface: FCM adapter + FakePush
    logger/      pino + PHI scrubber
  modules/       each: index.ts (typed public interface) · service.ts · repository.ts · routes.ts · schema.ts (zod)
    auth/            OIDC flows, JIT provisioning, sessions, dev-token issuer (AUTH_DEV_MODE, refused in prod)
    tenancy/         platform tenant provisioning/suspend, idp-config admin, facilities CRUD (+ attributes Json
                     for virtual locations: Floor, MSH ED, Field/FDNY, Outer Hospital)
    identity/        app_user (incl. phone_e164), permission catalog seed (~35 codes), roles, role_permission,
                     memberships, effective-permissions
    audit/           audit.record() — sole write path to append-only audit_log
    workflow-def/    zod WorkflowDoc contract + validator, draft/validate/publish/versions, role reconcile,
                     WorkflowDraftGenerator interface + StubGenerator (AI workflow builder seam)
    engine/          cases routes; lifecycle (raise/enterStage/close, EHR prefill hook); executor
                     (authorize→validate→record→gate→transition→lock); workflow-doc LRU cache (immutable versions);
                     writeEvent + after-commit domain events; escalation evaluator
    notification/    dispatch, channels, device tokens, ack, retry processor; emits notification.exhausted
    scheduling/      on_call_assignment CRUD, resolveOnCall, self on/off toggle
    uploads/         presigned URLs, media_object (ECG images)
    ehr/             EhrConnector interface, connector registry, EpicConnector (SMART Backend Services RS384 via
                     jose, thin fetch FHIR client, Patient/Observation mappers), PrefillService, circuit breaker,
                     GET /.well-known/jwks.json (public)
    ai/              anthropic service (env ANTHROPIC_MODEL, claude-sonnet-4-6); voice/ (exhausted-listener →
                     BullMQ ai-voice-call → Claude script w/ deterministic template fallback → Twilio call →
                     signature-validated webhooks twiml/gather/status → retry → SMS fallback);
                     summarize/ (on-demand + on-close, ai_summary + disclaimer)
    chat/            socket.io (Redis adapter): /chat namespace, room-per-thread, presence; thread provisioner
                     (workflow chat config-driven); send-window gates; REST history keyset paging; attachments
                     (presigned S3); directory (contact provider)
    metrics/         (thin MVP) time-interval queries from case_event (D2B, alert-to-accept)
  workers/           sla-sweeper (delayed jobs, deterministic jobIds, boot reconciler from sla_timer),
                     notification-retry, escalation, ehr, ai-voice-call
  health/            GET /api/v1/health (pg SELECT 1 + redis ping)
prisma/              schema.prisma, migrations (RLS hand-appended), rls.template.sql, seed/
scripts/             check-rls.ts, seed.ts
docs/backendPhases/  M<N>-<name>.md — phase plan + progress per phase (process rule)
progress.md          cross-phase readable progress log (process rule)
```

## Prisma models (all RLS + tenant-first index unless noted)

No-RLS platform set: `Tenant`, `Permission` (global catalog).
RLS set: `Facility`, `IdpConfig`, `AppUser`, `Role`, `RolePermission`, `Membership`, `WorkflowDefinition`, `WorkflowVersion`, `WorkflowFacilityAssignment`, `ClinicalCase` (lock_version), `CaseStageState`, `CaseEvent` (append-only, no UPDATE/DELETE grants), `CaseParticipant`, `IdempotencyKey`, `OnCallAssignment`, `Notification`, `DeviceToken`, `SlaTimer`, `MediaObject`, `AuditLog` (append-only), `EhrConnection`, `PatientLink`, `AiVoiceCall` (voice script kept in Redis TTL 15m, not DB — PHI), `AiSummary`, `ChatThread`, `ChatThreadMember`, `ChatMessage` (uuidv7 ids, clientMessageId dedupe).

**RLS/migrate sync**: `prisma migrate dev --create-only` + hand-append block from `prisma/rls.template.sql` (+ `app_runtime` grants); CI `scripts/check-rls.ts` fails if any tenant_id table lacks FORCE RLS / dual policy / tenant-first index; `prisma migrate diff --exit-code` catches drift. Adversarial isolation e2e per MLD Phase 1 exit test.

## WorkflowDoc contract extensions (freeze at M3; all diagnosis-agnostic)

1. `Notification.when: DataCondition` — conditional fan-out (Transfer Center only for transfers; ED Resident only when MSH ED).
2. `Notification.target_facility_field` — on-call resolution against a captured field's facility ("Accepting MD of toLocation").
3. `DataField.derived: { source_field, map, overridable }` + tiny closed `derived_expr` (eq/neq/and/or) — cath-lab mapping, `is_transfer`.
4. Nested trigger groups `{logic, rules}` (one recursion level) — shock rule `hr>90 AND (sbp<90 OR map<65)`.
5. System-action `advance_requires: [{stage_id, action_id}]` cross-stage gate (discharge needs vitals/move_to_cathlab/shock decision) — also legitimizes sample doc's `requires_prior_actions`.
6. `DataField.ehr_source: { resource: 'Patient'|'Observation', path?|loinc? }` — EHR prefill.
7. `chat: { groups[] (member_roles, created_on), open_gate, send_window {active_days, terminal_days} }`.
8. `escalation_fallback: { voice_call, sms_fallback }` + `ai: { summarize_on_close }` — per-workflow AI opt-in.

## MSH STEMI as data (`prisma/seed/workflows/msh-stemi.v1.json`, published via normal pipeline)

Roles: REFERRING_MD, REFERRING_RN, ED_RESIDENT_PA, FELLOW, ACCEPTING_MD, ACCEPTING_RN, TRANSFER_CENTER, CATHLAB_TECH + add_team-only CT_SURGEON, CICU_MD, CHF_MD.
Stages: `raise_case` (entry; MRN→EHR prefill; ECG media 1–3; derived to_location/is_transfer; conditional fan-out) → `pending_review` (`start_review` custom action) → `under_review` (decision: accept / reject→`rejected` / reject_accept_transfer→`transfer_coordination`→`transferred`) → `treatment` (blocks_advance: patient details + vitals; shock screening 8 booleans; shock approval; medications; preprocedural metrics; cancel→`cancelled`) → `cathlab` (ready_to_receive; move_to_cathlab blocks_advance — D2B stop event) → `clinical_documentation` (32-field discharge metrics blocks_advance; discharge→`discharged`). Team assembly on accept = `action_performed` escalation `add_team` [ACCEPTING_RN, REFERRING_RN, CATHLAB_TECH, FELLOW]. Shock 8/8 `add_team` [CT_SURGEON, CICU_MD, CHF_MD]; D2B 75-min `time_elapsed` warning. MSH sites = facility rows; pseudo-locations = `attributes.kind='virtual'`.
**Product sign-offs needed**: explicit `start_review` action replaces legacy view-promotion; push retries capped (2 min × 60) not infinite.

## Key flows

- **EHR prefill**: `GET /api/v1/ehr/patients?facilityId&mrn` → per-facility EpicConnector (token cached in Redis, RS384 client assertion via jose, JWKS served publicly) → `PatientSummary[] + prefill` for entry-stage `ehr_source` fields → clinician **confirms** (never silently authoritative) → `POST /cases/:id/link-patient` → `patient_link` + `case_event('ehr.patient_linked')`. 4s timeout / circuit breaker / Epic down ⇒ `{patients: [], ehrStatus:'unavailable'}` — manual entry always works. Audit field *names*, never values.
- **AI voice call**: notification retries exhausted unacked → `notification.exhausted` event → (workflow opted-in) BullMQ job (jobId = notificationId:attempt) → Claude script, PHI-minimized (first name + age, workflow, facility, stage, elapsed; NO MRN/DOB/phone) with deterministic template fallback → Twilio call → `<Gather>` DTMF: 1 ⇒ notification ack + `case_event('notification.acknowledged',{via:'voice_call'})`; 2 ⇒ declined → escalation continues to backup on-call. no-answer/failed → retry (≤AI_VOICE_MAX_ATTEMPTS) → PHI-free SMS fallback. All webhooks `X-Twilio-Signature` validated; public routes outside auth/tenant middleware, tenant resolved from AiVoiceCall row via `runInTenant`.
- **Chat**: `case.accepted` → provision threads per workflow `chat.groups`; members derived from `case_participant`; add_team syncs members + system message. One send path (REST+WS): authz → window gate → persist → Redis room fan-out → offline members get push (`sound_type:'chat'`, no retries, PHI-minimized body). Images: presigned PUT, key-only in Postgres, HeadObject verify.
- **Chat summary**: `POST /api/v1/cases/:id/chat/summary` (+ optional on-close) → last ≤500 messages (role + first name) + condensed case timeline → Claude → `ai_summary` with fixed decision-support disclaimer + `case_event` pointer; dedupe on unchanged inputRange.

## Packages

**Add**: `express@^5`, `zod@^4`, `jose`, `openid-client@^6`, `pino`+`pino-http`, `ioredis@^5`, `bullmq@^5`, `socket.io`+`@socket.io/redis-adapter`, `firebase-admin@^13`, `@aws-sdk/client-s3`+`@aws-sdk/s3-request-presigner`, `twilio@^5`, `@anthropic-ai/sdk`, `@asteasolutions/zod-to-openapi`, `swagger-ui-express`, `helmet`, `express-rate-limit`, `uuidv7`, `libphonenumber-js`, `@types/fhir` (dev), `tsx` (dev), `supertest` (dev).
**Remove**: all `@nestjs/*`, `passport*`, `bcrypt`, `class-validator`, `class-transformer`, `reflect-metadata`, `rxjs`, nest-cli/tsconfig.build. **Keep**: `@prisma/client`/`prisma` 7, `dotenv`, jest toolchain, eslint/prettier (configs adjusted).

## Milestones (per process: phase plan → TaskCreate → execute one-by-one → progress.md after each task)

- **M0 Foundation + re-scaffold**: create `progress.md`; rewrite CLAUDE.md; replace NestJS scaffold with Express layout (app.ts/server.ts, middleware chain, zod-validated env config, pino + PHI scrubber, correlation, error handler, Swagger `/docs`, health); docker-compose (postgres:16, redis:7, keycloak:26 w/ realm import, minio); ALS tenant-tx spike against Prisma 7; CI (lint, unit, e2e, check-rls). Exit: health 200 + structured correlated log + SELECT 1 through pool. **Start Epic sandbox app registration immediately (longest lead; JWKS URL or S3-hosted static JWKS).**
- **M1 Tenancy+RLS+Audit**: Tenant/Facility/AuditLog models + first migrations w/ RLS + `app_runtime` role; tenant-scope middleware + getTenantDb/platformDb/runInTenant; provisioning endpoints; check-rls script. Exit: adversarial isolation e2e (no-WHERE select ⇒ 0 foreign rows; foreign-tenant INSERT rejected by WITH CHECK; no residual session var post-request).
- **M2 OIDC+RBAC**: IdpConfig/AppUser/Role/RolePermission/Membership + permission catalog seed; openid-client flows + Redis sessions + JIT + dev-token issuer; requirePermission middleware + effective-permissions. Exit: Keycloak login e2e, JIT user created, 403 e2e.
- **M3 Workflow definitions**: zod WorkflowDoc **incl. all 8 extensions — contract frozen + versioned (`metadata.schema_version`)**; validator (entry/terminal/reachability/refs/system-code-in-catalog/custom-has-no-code); draft/validate/publish/versions; role reconcile; draft-generator stub seam. Exit: MSH STEMI doc validates + publishes; broken docs rejected per rule.
- **M4 Engine**: case models; executor (MLD pseudocode: two-gate authz incl. case_participant, DataField→zod runtime validation, dual-write ledger+snapshot, gates, transition, optimistic lock ⇒ 409); idempotency middleware; uploads; EhrConnector noop prefill hook at raise. Exit: full STEMI raise→discharge e2e; reject path; concurrent double-accept ⇒ one 200 + one 409; idempotent replay.
- **M5 Notifications/SLA/Escalations**: BullMQ queues + tenant-aware workers; DeviceToken + FCM behind PushProvider (FakePush in CI); in-app feed + ack endpoints; scheduling + resolveOnCall; sla_timer delayed jobs + boot reconciler; escalation evaluator (inline eval, post-commit effects); `notification.exhausted` + domain events. Exit: doc-driven fan-out incl. conditional/facility-routed recipients; retry until ack; SLA fires after Redis flush+restart; shock 8/8 add_team grants case roles.
- **M6 EHR**: connector interface/registry, EpicConnector + backend-services auth + mappers, PrefillService, link-patient, JWKS route, breaker, connection admin + test endpoints. Exit: sandbox e2e (`EPIC_SANDBOX_E2E=1`) MRN→demographics prefill on raise_case; Epic-down ⇒ manual raise unaffected.
- **M7 Chat + AI summary**: chat module (gateway, provisioner, windows, history, attachments, directory, offline push), then summarization. Exit: two-instance WS fan-out via Redis adapter; send-window matrix; membership authz; RLS adversarial test on chat_message; summary w/ disclaimer + dedupe (fake Anthropic client in CI).
- **M8 AI voice + hardening**: voice pipeline + Twilio webhooks (test creds + magic numbers, signature 403 tests, PHI-free-prompt regex assertion, template fallback, SMS fallback); seed script (tenant "Mount Sinai", 12 facilities incl. virtual, roles/memberships/demo users, published MSH STEMI v1); helmet + rate limit + graceful shutdown; pool-exhaustion load check; README runbook; ADRs in `docs/decisions/`. Exit: clean `docker compose up` → seed → full case via Swagger; missed alarm → voice call → DTMF ack recorded as case_event.

## Risks / notes

- Tx-per-request holds a connection: explicit `connection_limit`, tx timeout, slow I/O (S3/push/EHR/AI) always outside tx / post-commit.
- BAA prerequisites (Anthropic, Twilio HIPAA) — `PHI_VENDORS_BAA_CONFIRMED` flag disables AI features in prod when false.
- AI + EHR degrade gracefully; never on the critical alerting path.
- Epic production access = months (Connection Hub); sandbox is the explicit MVP target.
- **Open question to re-ask user later**: conversational AI voice agent (two-way) vs TTS; FCM/Firebase real creds needed before M5 device e2e.
- Memory to save post-approval: stack = Express backend / React admin / RN mobile (NOT NestJS); process = progress.md + phase plans + tasks; MSH = first client but platform generic; production MVP target; EHR critical; TTS-call decision pending revisit.

## Verification (end-to-end)

`docker compose up` → migrate + seed → Swagger: dev-token login → raise case with MRN (Epic sandbox patient, e.g. Camila Lopez) → verify prefill → accept as ACCEPTING_MD → chat thread auto-created, send messages → summarize endpoint → advance through treatment/cathlab/discharge → check case_event timeline + D2B derivable → let a notification exhaust retries with Twilio test creds → assert AiVoiceCall row + signed-webhook ack path. CI: lint, unit, e2e (FakePush, mock Anthropic, MinIO), check-rls, migrate diff.
