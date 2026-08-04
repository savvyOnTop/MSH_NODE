-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "isolation_mode" TEXT NOT NULL DEFAULT 'shared',
    "region" TEXT NOT NULL DEFAULT 'us-east-1',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "facility" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" JSONB,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "status" TEXT NOT NULL DEFAULT 'active',
    "attributes" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "facility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "resource_type" TEXT NOT NULL,
    "resource_id" UUID,
    "summary" JSONB,
    "ip" INET,
    "correlation_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "facility_tenant_id_status_idx" ON "facility"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "facility_tenant_id_name_key" ON "facility"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- ============================================================================
-- Hand-appended per prisma/rls.template.sql (tenancy invariant — do not remove)
-- ============================================================================

-- CHECK constraints (Prisma cannot express these)
ALTER TABLE "tenant" ADD CONSTRAINT tenant_status_check
  CHECK (status IN ('active', 'suspended', 'provisioning'));
ALTER TABLE "tenant" ADD CONSTRAINT tenant_isolation_mode_check
  CHECK (isolation_mode IN ('shared', 'schema', 'dedicated_db'));

-- Platform (control-plane) table: NO RLS; narrow grants for runtime role
GRANT SELECT, INSERT, UPDATE ON "tenant" TO app_runtime;

-- facility: RLS + full grants
ALTER TABLE "facility" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "facility" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "facility"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "facility" TO app_runtime;

-- audit_log: RLS + append-only grants (no UPDATE/DELETE for runtime)
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_log"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT ON "audit_log" TO app_runtime;
