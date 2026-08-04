// Test env defaults — real services (pg/redis) come from docker-compose.
process.env['NODE_ENV'] = 'test';
process.env['DATABASE_URL'] ??=
  'postgresql://app_runtime:runtime_dev_password@localhost:5432/cathaid?connection_limit=10';
process.env['DIRECT_DATABASE_URL'] ??=
  'postgresql://cathaid_owner:owner_dev_password@localhost:5432/cathaid';
process.env['REDIS_URL'] ??= 'redis://localhost:6379';
process.env['AUTH_JWT_SECRET'] ??= 'test-secret-not-for-prod';
// Dev principal shim (x-tenant-id) + dev-gated admin surface for e2e.
process.env['AUTH_DEV_MODE'] = 'true';
process.env['LOG_LEVEL'] ??= 'error';
