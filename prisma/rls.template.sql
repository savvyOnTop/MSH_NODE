-- ============================================================================
-- RLS template — hand-append one block per tenant_id table to EVERY migration
-- created with `prisma migrate dev --create-only`. Replace __TABLE__.
--
-- Rules (CI-enforced by scripts/check-rls.ts):
--   * ENABLE + FORCE row level security (FORCE binds even the table owner)
--   * one policy with BOTH `USING` (reads) and `WITH CHECK` (writes)
--   * current_setting('app.current_tenant', true) — the `true` makes it return
--     NULL instead of erroring when unset, so an unscoped connection sees
--     zero rows rather than crashing
--   * grants for the runtime role `app_runtime` (non-owner, NOBYPASSRLS)
--   * append-only tables (audit_log, case_event): INSERT + SELECT only
-- ============================================================================

ALTER TABLE "__TABLE__" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "__TABLE__" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "__TABLE__"
  USING      (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "__TABLE__" TO app_runtime;

-- Append-only variant (audit_log, case_event, ...): use INSTEAD of the GRANT above
-- GRANT SELECT, INSERT ON "__TABLE__" TO app_runtime;

-- Platform (control-plane) tables have NO tenant_id and NO RLS; grant narrowly:
-- GRANT SELECT, INSERT, UPDATE ON "tenant" TO app_runtime;
