# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**cathaid-api** — NestJS backend for CathAID NextGen, a multi-tenant SaaS platform generalizing STEMI CathAID into a universal emergency-care workflow coordination system. Full design spec: `docs/architecture.md` (read this before implementing any module — it defines the data hierarchy, the `steps_config` contract, all API endpoints, and validation rules in detail).

Currently in **Phase 1 scaffold state**: project setup only (NestJS + Prisma installed, module folders created as empty stubs). No business logic, no models, no endpoints implemented yet.

## Commands

```bash
npm run start:dev      # dev server, watch mode
npm run build           # nest build
npm run lint             # eslint --fix over src/apps/libs/test
npm run format            # prettier --write
npm test                   # jest, all specs
npm run test:watch          # jest --watch
npm run test:cov             # jest --coverage
npm run test:e2e              # jest --config ./test/jest-e2e.json
npx jest path/to/file.spec.ts   # run a single test file
npx prisma migrate dev            # apply schema changes to dev DB
npx prisma generate                # regenerate Prisma client after schema edits
npx prisma studio                   # browse DB
```

Jest `rootDir` is `src` — spec files live next to the code they test (`*.spec.ts`), not in a separate `test/` tree (that directory is e2e-only).

## Architecture

This is one of three planned repos (`cathaid-api`, `cathaid-admin`, `cathaid-mobile` — see doc §1); only the backend lives here.

### Core data hierarchy

```
TENANT (health org) → FACILITY (hospital/site) → DIAGNOSIS_TYPE (STEMI, Stroke...) → WORKFLOW_TEMPLATE
```

Every table carries `tenant_id`. Full data isolation, no cross-tenant access — `tenant_id` is injected from JWT via `TenantContextMiddleware` (`src/common/middleware/`) on every request. Any new table or query must respect this scoping.

### steps_config — the central contract

`WorkflowTemplate.stepsConfig` (JSONB) is the single source of truth for how a diagnosis workflow behaves — stages, roles, escalation rules. In Phase 2 it will drive the alarm engine, mobile UI rendering, and escalation engine; in Phase 1 the backend only builds tooling to create/validate/edit this JSON, nothing executes it yet. Full schema (stage objects, field types, notification objects, transitions, escalation trigger types) is in doc §3 — read it before touching `WorkflowValidatorService` or the AI workflow builder.

Validation rules for `steps_config` (doc §3.9) are enforced by `WorkflowValidatorService` (`src/modules/workflow-templates/workflow-validator.service.ts`, not yet implemented) — e.g. exactly one `is_entry` stage, all transition targets must exist, decision stages need ≥2 actions, scale_form/computed_field cross-references must resolve.

### Module layout (`src/modules/`)

- `auth/` — register/login, JWT strategy + guards, roles guard
- `tenants/` — tenant self-service (GET/PATCH `/tenants/me`)
- `facilities/` — CRUD, soft delete
- `diagnosis-types/` — includes `seeds/` for pre-seeded diagnosis templates (stemi, stroke, trauma, ob-pph, ob-preeclampsia, vascular-*)
- `workflow-templates/` — CRUD + draft/publish/version lifecycle + the validator service
- `ai-workflow/` — AI-assisted workflow generation from uploaded docs (`document-extractor.service.ts` using pdf-parse/mammoth → `prompt-builder.service.ts` → Claude tool_use call → `response-parser.service.ts` → validator → insert as draft). Model: claude-sonnet-4-6 with `tool_choice: { type: "any" }`.
- `uploads/` — document upload endpoint backing the AI workflow pipeline

`src/common/` holds cross-cutting concerns: `middleware/tenant-context.middleware.ts`, `decorators/` (tenant, current-user), `guards/tenant-scope.guard.ts`.

### Explicit non-scope for Phase 1

No case runtime (cases aren't executed, only workflow config is authored), no push notifications, no real-time/WebSocket, no EHR integration, no on-call scheduling, no SSO, no analytics dashboard. Don't build toward these until Phase 2/3 doc sections say so — see doc §10 for the full roadmap and what's explicitly deferred.

### Prisma

Schema at `prisma/schema.prisma` (provider: postgresql, client output to `generated/prisma`). Core models per doc §4.1: `Tenant`, `Facility`, `DiagnosisType`, `WorkflowTemplate`, `AdminUser` — not yet written into the schema file. `prisma.config.ts` loads `DATABASE_URL` from `.env` via `dotenv/config` — copy `.env.example` to `.env` and point it at a real Postgres instance before running migrations.
