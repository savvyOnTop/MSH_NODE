# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**cathaid-api** — Node.js + **Express 5** + TypeScript (ESM) backend for CathAID NextGen, a multi-tenant SaaS platform for time-critical emergency-care workflows (STEMI, Stroke, Trauma, …). This repo is **backend only**; the React admin portal (super/tenant/facility admins) and React Native mobile app (facility users: providers, nurses, techs, transfer center) live in separate repos and consume this API.

**Spec-of-record: `docs/backendMLD.md`** (HLD+LLD, phase by phase). Where it conflicts with `docs/architecture.md`, the MLD wins (notably tenancy: shared DB, shared tables, `tenant_id` + mandatory Postgres RLS — NOT schema-per-tenant). First client workflow: MSH STEMI (`docs/msh.md`), shipped purely as workflow data (`prisma/seed/workflows/msh-stemi.v1.json`) — **zero MSH-specific code paths**. Sample workflow JSON: `docs/sample.trauma.workflow.md`. Approved implementation plan lives in the plan file referenced by `progress.md`.

## Working process (mandatory)

- **Before starting any phase**: write its plan to `docs/backendPhases/M<N>-<name>.md` (objectives, task table, exit test), create tasks from it, execute one by one.
- **After every completed task**: update the phase file's Progress section AND `progress.md` (root: phase table + milestone summary; task detail lives in the phase file).
- **Progress style is reader-first**: plain "Created X / Migrated Y" statements, a markdown link to every file mentioned, one-sentence "why" for migrations and non-obvious decisions. No compressed jargon lines.
- **Phase gate**: when a milestone completes, STOP and ask the user before starting the next one.
- Each milestone ends green: lint + tests + its exit test from the phase file.

## Commands

```bash
docker compose up -d        # postgres:16, redis:7, keycloak:26, minio
npm run dev                  # tsx watch src/server.ts
npm run build                 # tsc
npm run lint                   # eslint --fix
npm test                        # jest (unit + integration)
npm run test:e2e                 # e2e suite (needs docker services)
npx prisma migrate dev --create-only   # ALWAYS --create-only, then hand-append RLS block (prisma/rls.template.sql)
npx prisma migrate dev                  # apply
npx tsx scripts/check-rls.ts             # CI gate: every tenant_id table must have FORCE RLS + dual policy + tenant-first index
npx tsx scripts/seed.ts                   # tenant "Mount Sinai", facilities, users, published MSH STEMI v1
```

`.env` from `.env.example`: `DATABASE_URL` = runtime user `app_runtime` (non-owner, no BYPASSRLS); `DIRECT_DATABASE_URL` = owner, used only by migrations (`prisma.config.ts`).

## Architecture invariants (violating any of these is a PHI-leak or audit bug)

1. **Tenancy**: every table carries `tenant_id`, a tenant-first index, tenant-composite uniques, and RLS `ENABLE + FORCE` with a policy `USING` + `WITH CHECK` on `current_setting('app.current_tenant', true)::uuid`.
2. **One unbypassable scoping mechanism**: per-request interactive Prisma transaction + AsyncLocalStorage (`src/infra/db/`): first statement `SELECT set_config('app.current_tenant', $1, true)`; commit/rollback at request end; **after-commit queue** flushes BullMQ enqueues + domain events only post-COMMIT. Only `getTenantDb()` (throws outside context) and narrow `platformDb` (tenant/permission/idp pre-auth lookups) are exported; raw `PrismaClient` never leaves `src/infra/db/`. ESLint bans importing `generated/prisma` elsewhere.
3. **Middleware order is load-bearing**: correlation → auth (JWT verify) → tenant-scope → authz `requirePermission` → zod validate → handler → error handler (`{code, message, details}`, never stacks/PHI).
4. **Outside HTTP** (BullMQ workers, Twilio webhooks, socket.io): all DB access via `runInTenant(tenantId, fn)`; every job payload carries `tenantId`; processors go through the tenant-aware worker wrapper.
5. **Workflow-as-data**: cases pin an immutable `workflow_version`; every state change writes exactly one `case_event` (append-only ledger; `case_stage_state.captured_data` is the rebuildable snapshot). System actions carry a catalog `permission_code` + engine behavior; custom actions are `allowed_roles`-gated, record-only. New permission *codes* require engineering; everything else is workflow-JSON edits + republish.
6. **State-changing endpoints are idempotent** under `Idempotency-Key`; concurrency via `lock_version` optimistic locking (updateMany count=0 ⇒ 409).
7. **PHI**: pino PHI scrubber on all logs; audit field *names* not values; no PHI to any vendor without BAA (`PHI_VENDORS_BAA_CONFIRMED` gates AI features in prod); AI and EHR degrade gracefully and never sit on the critical alerting path (manual entry always works; deterministic TTS template fallback).

## Module map (`src/`)

`app.ts`/`server.ts` composition root (no DI framework — modules export typed interfaces from `index.ts`, wired in app.ts). `middleware/` correlation, auth, tenant-scope, authz, validate, error, idempotency. `infra/` db, redis, queues (BullMQ + tenant-aware wrapper), events (typed emitter + name constants — the decoupling seam), storage (S3 presigned), secrets adapter (no `process.env` in module code), push (FCM + FakePush), logger.

`modules/` (each: `index.ts · service.ts · repository.ts · routes.ts · schema.ts`):
- `auth/` — multi-tenant OIDC (openid-client v6, PKCE, JIT provisioning), 15-min access JWT (`sub`/`tid`/`sid` only) + Redis refresh sessions, dev-token issuer (`AUTH_DEV_MODE`, refused in prod)
- `tenancy/` — tenant provisioning/suspend, idp-config, facilities (Json `attributes` for virtual locations)
- `identity/` — app_user (incl. `phone_e164`), fixed permission catalog (~35 codes, seeded), roles, memberships, effective-permissions
- `audit/` — `audit.record()`, sole write path to append-only `audit_log`
- `workflow-def/` — zod **WorkflowDoc contract** (`schema.ts` — the platform's most important artifact; frozen + versioned) + validator + draft/publish/versions + role reconcile + `WorkflowDraftGenerator` stub seam
- `engine/` — case lifecycle (raise w/ EHR prefill hook, enterStage, close), executor (authorize→validate→record→gate→transition→lock), immutable-version LRU doc cache, writeEvent, escalation evaluator
- `notification/` — dispatch, channels, device tokens, ack, retry processor; emits `notification.exhausted`
- `scheduling/` — on-call assignments, `resolveOnCall`
- `uploads/` — presigned URLs, `media_object` (ECG images)
- `ehr/` — `EhrConnector` interface + registry; EpicConnector (SMART Backend Services RS384 via jose, thin-fetch FHIR client, Patient/Observation mappers), PrefillService (`ehr_source` data fields), circuit breaker, public `/.well-known/jwks.json`
- `ai/` — Anthropic service (`ANTHROPIC_MODEL`, default claude-sonnet-4-6); voice: `notification.exhausted` → Claude PHI-minimized script (template fallback) → Twilio call → signature-validated webhooks (DTMF 1=ack/2=decline) → SMS fallback; summarize: chat-thread + timeline → `ai_summary` with decision-support disclaimer
- `chat/` — socket.io (Redis adapter, `/chat` namespace), threads provisioned from workflow `chat.groups` on `case.accepted`, members derived from `case_participant`, config-driven send windows, keyset history, presigned image attachments, contact-provider directory
- `metrics/` — time intervals from `case_event` (door-to-balloon, alert-to-accept)

`workers/` — sla-sweeper (BullMQ delayed jobs, deterministic jobIds, boot reconciler from `sla_timer`), notification-retry, escalation, ehr, ai-voice-call.

## Testing

Jest + supertest. Specs next to code (`*.spec.ts`); e2e in `test/`. CI: lint, typecheck, unit, e2e (pg+redis+minio services, FakePush, mocked Anthropic, Twilio test creds), `check-rls`, `prisma migrate diff --exit-code`. Adversarial tenancy e2e is the M1 gate: no-WHERE select returns zero foreign rows; foreign-tenant INSERT rejected; no residual session var after request.
