-- CreateTable
CREATE TABLE "idp_config" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'oidc',
    "issuer_url" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_ref" TEXT NOT NULL,
    "scopes" TEXT NOT NULL DEFAULT 'openid profile email',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idp_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "idp_subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone_e164" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_platform_admin" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "code" TEXT NOT NULL,
    "description" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_def_id" UUID,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "tenant_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission")
);

-- CreateTable
CREATE TABLE "membership" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "facility_id" UUID,
    "workflow_def_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "membership_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idp_config_tenant_id_enabled_idx" ON "idp_config"("tenant_id", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "idp_config_tenant_id_issuer_url_client_id_key" ON "idp_config"("tenant_id", "issuer_url", "client_id");

-- CreateIndex
CREATE INDEX "app_user_tenant_id_status_idx" ON "app_user"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_tenant_id_idp_subject_key" ON "app_user"("tenant_id", "idp_subject");

-- CreateIndex
CREATE UNIQUE INDEX "app_user_tenant_id_email_key" ON "app_user"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "role_tenant_id_code_idx" ON "role"("tenant_id", "code");

-- CreateIndex
CREATE UNIQUE INDEX "role_tenant_id_workflow_def_id_code_key" ON "role"("tenant_id", "workflow_def_id", "code");

-- CreateIndex
CREATE INDEX "role_permission_tenant_id_role_id_idx" ON "role_permission"("tenant_id", "role_id");

-- CreateIndex
CREATE INDEX "membership_tenant_id_user_id_idx" ON "membership"("tenant_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "membership_tenant_id_user_id_role_id_facility_id_workflow_d_key" ON "membership"("tenant_id", "user_id", "role_id", "facility_id", "workflow_def_id");

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "membership" ADD CONSTRAINT "membership_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- Hand-appended per prisma/rls.template.sql (tenancy invariant — do not remove)
-- ============================================================================

ALTER TABLE "idp_config" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idp_config" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "idp_config"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "idp_config" TO app_runtime;

ALTER TABLE "app_user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "app_user" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "app_user"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "app_user" TO app_runtime;

ALTER TABLE "role" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "role" TO app_runtime;

ALTER TABLE "role_permission" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "role_permission" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "role_permission"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "role_permission" TO app_runtime;

ALTER TABLE "membership" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "membership" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "membership"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "membership" TO app_runtime;

-- Platform-owned catalog: runtime may only read it.
GRANT SELECT ON "permission" TO app_runtime;

-- ============================================================================
-- Fixed permission catalog seed (backendMLD Phase 2). A code exists ONLY if
-- backend code enforces it; grows only via engineering migration.
-- ============================================================================
INSERT INTO "permission" (code, description) VALUES
  -- case lifecycle
  ('case.view',            'View cases and case details'),
  ('case.raise',           'Raise (create) a case'),
  ('case.accept',          'Accept a case under review'),
  ('case.reject',          'Reject a case under review'),
  ('case.transfer',        'Reject-accept a case as transfer'),
  ('case.close',           'Close / discharge a case'),
  ('case.cancel',          'Cancel an in-flight case'),
  ('case.participant.add', 'Add team members to a case'),
  -- stage / actions
  ('stage.advance',        'Advance a case to the next stage'),
  ('action.perform',       'Perform system actions on a case stage'),
  ('data.capture',         'Capture or edit stage data fields'),
  -- media
  ('media.upload',         'Upload media (ECG images, attachments)'),
  ('media.view',           'View case media'),
  -- notifications
  ('notification.view',    'View notification feed'),
  ('notification.ack',     'Acknowledge notifications'),
  ('notification.test',    'Send test notifications'),
  -- scheduling
  ('schedule.view',        'View on-call schedules'),
  ('schedule.manage',      'Manage on-call assignments'),
  ('schedule.self_toggle', 'Toggle own on-call availability'),
  -- workflow authoring
  ('workflow.view',        'View workflow definitions'),
  ('workflow.author',      'Create and edit workflow drafts'),
  ('workflow.publish',     'Publish workflow versions'),
  ('workflow.assign',      'Assign workflows to facilities'),
  -- RBAC / identity
  ('user.view',            'View users'),
  ('user.manage',          'Create/edit users and memberships'),
  ('role.manage',          'Create/edit roles and their permissions'),
  -- metrics
  ('metrics.view',         'View metrics and time intervals'),
  -- tenant / facility admin
  ('tenant.manage',        'Manage tenant settings (tenant admin)'),
  ('facility.view',        'View facilities'),
  ('facility.manage',      'Create/edit facilities'),
  -- EHR
  ('ehr.query',            'Query EHR for patient prefill'),
  ('ehr.link',             'Link an EHR patient to a case'),
  -- chat
  ('chat.view',            'View case chat threads'),
  ('chat.send',            'Send chat messages'),
  ('chat.summarize',       'Request AI chat summarization'),
  -- audit
  ('audit.read',           'Read the audit log')
ON CONFLICT (code) DO NOTHING;
