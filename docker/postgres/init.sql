-- Runtime role for the API: NOT the table owner, no BYPASSRLS.
-- FORCE ROW LEVEL SECURITY + this separation is what makes RLS the real isolation boundary.
-- Migrations run as cathaid_owner (DIRECT_DATABASE_URL); the app runs as app_runtime (DATABASE_URL).
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'runtime_dev_password' NOBYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE cathaid TO app_runtime;
GRANT USAGE ON SCHEMA public TO app_runtime;
-- Table/sequence grants are issued per-migration (see prisma/rls.template.sql);
-- append-only tables (case_event, audit_log) deliberately get no UPDATE/DELETE grant.
