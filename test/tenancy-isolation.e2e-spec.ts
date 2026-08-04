import express, { type Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/app.js';
import {
  disconnectDb,
  getTenantDb,
  platformDb,
} from '../src/infra/db/index.js';
import { closeSharedRedis } from '../src/infra/redis/index.js';
import { correlation } from '../src/middleware/correlation.js';
import { errorHandler } from '../src/middleware/error.js';
import { devPrincipal, tenantScope } from '../src/middleware/tenant-scope.js';
import {
  bearer,
  bootstrapPlatformAdmin,
  devToken,
  provisionTenant,
} from './helpers.js';

// M1 exit test (backendMLD Phase 1, adversarial): RLS alone must enforce
// isolation. A handler scoped to Tenant A runs a raw SELECT with the WHERE
// tenant_id clause DELIBERATELY OMITTED and must still see zero foreign rows;
// a foreign-tenant INSERT must be rejected by the policy's WITH CHECK; and a
// pooled connection must carry no residual app.current_tenant after a request.
// (Updated in M2: main-app routes authenticate with real JWTs via dev-token.)

/** Adversarial surface: raw SQL behind the tenant-tx mechanism (dev principal shim). */
function rawSqlApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(correlation);
  app.use(devPrincipal, tenantScope);
  app.get('/raw/facilities', async (_req, res) => {
    // NO WHERE clause — RLS is the only thing scoping this.
    const rows = await getTenantDb().$queryRaw<
      { tenant_id: string; name: string }[]
    >`SELECT tenant_id::text AS tenant_id, name FROM facility`;
    res.json({ rows });
  });
  app.post('/raw/foreign-insert', async (req, res) => {
    const { foreignTenantId } = req.body as { foreignTenantId: string };
    await getTenantDb()
      .$executeRaw`INSERT INTO facility (id, tenant_id, name, timezone)
                   VALUES (gen_random_uuid(), ${foreignTenantId}::uuid, 'intruder', 'UTC')`;
    res.status(201).json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe('tenant isolation (M1 exit, adversarial)', () => {
  const app = createApp();
  const raw = rawSqlApp();
  const suffix = Date.now();
  let bootToken = '';
  let tenantA = '';
  let tenantB = '';
  let tokenA = ''; // platform-admin tokens inside each tenant (bypass RBAC, keep tenancy)
  let tokenB = '';

  beforeAll(async () => {
    const boot = await bootstrapPlatformAdmin(app);
    bootToken = boot.accessToken;
    tenantA = await provisionTenant(app, bootToken, `Isolation A ${suffix}`);
    tenantB = await provisionTenant(app, bootToken, `Isolation B ${suffix}`);
    tokenA = (
      await devToken(app, {
        tenantId: tenantA,
        email: 'pa@iso-a.io',
        isPlatformAdmin: true,
      })
    ).accessToken;
    tokenB = (
      await devToken(app, {
        tenantId: tenantB,
        email: 'pa@iso-b.io',
        isPlatformAdmin: true,
      })
    ).accessToken;
    for (const [token, name] of [
      [tokenA, 'Alpha General'],
      [tokenB, 'Beta Medical'],
    ] as const) {
      const res = await request(app)
        .post('/api/v1/facilities')
        .set(...bearer(token))
        .send({ name });
      expect(res.status).toBe(201);
    }
  });

  afterAll(async () => {
    await disconnectDb();
    await closeSharedRedis();
  });

  it('no-WHERE raw SELECT returns zero foreign rows (RLS-only scoping)', async () => {
    const res = await request(raw)
      .get('/raw/facilities')
      .set('x-tenant-id', tenantA);
    expect(res.status).toBe(200);
    const rows = (res.body as { rows: { tenant_id: string; name: string }[] })
      .rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    expect(rows.some((r) => r.name === 'Beta Medical')).toBe(false);
  });

  it('foreign-tenant INSERT is rejected by WITH CHECK', async () => {
    const res = await request(raw)
      .post('/raw/foreign-insert')
      .set('x-tenant-id', tenantA)
      .send({ foreignTenantId: tenantB });
    expect(res.status).toBe(500); // policy violation surfaces as opaque error
    const check = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(tokenB));
    const names = (
      check.body as { facilities: { name: string }[] }
    ).facilities.map((f) => f.name);
    expect(names).not.toContain('intruder');
  });

  it('pooled connection carries no residual app.current_tenant after a request', async () => {
    await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(tokenA));
    const rows = await platformDb.$queryRaw<
      { v: string | null }[]
    >`SELECT current_setting('app.current_tenant', true) AS v`;
    const v = rows[0]?.v ?? null;
    expect(v === null || v === '').toBe(true);
  });

  it('API-level isolation: each tenant lists only its own facilities', async () => {
    const a = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(tokenA));
    const b = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(tokenB));
    const aNames = (
      a.body as { facilities: { name: string }[] }
    ).facilities.map((f) => f.name);
    const bNames = (
      b.body as { facilities: { name: string }[] }
    ).facilities.map((f) => f.name);
    expect(aNames).toContain('Alpha General');
    expect(aNames).not.toContain('Beta Medical');
    expect(bNames).toContain('Beta Medical');
    expect(bNames).not.toContain('Alpha General');
  });

  it('suspended tenant is refused at admission (403 tenant_unavailable)', async () => {
    const tenantC = await provisionTenant(
      app,
      bootToken,
      `Isolation C ${suffix}`,
    );
    const tokenC = (
      await devToken(app, {
        tenantId: tenantC,
        email: 'pa@iso-c.io',
        isPlatformAdmin: true,
      })
    ).accessToken;

    const suspend = await request(app)
      .post(`/api/v1/admin/tenants/${tenantC}/suspend`)
      .set(...bearer(bootToken));
    expect(suspend.status).toBe(204);

    const res = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(tokenC));
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('tenant_unavailable');
  });

  it('audit trail: provisioning + facility.create recorded with correlation id', async () => {
    const res = await request(app)
      .get('/api/v1/audit')
      .set(...bearer(tokenA))
      .set('x-correlation-id', 'corr-audit-check');
    expect(res.status).toBe(200);
    const entries = (
      res.body as {
        entries: { action: string; correlationId: string | null }[];
      }
    ).entries;
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('tenant.provision');
    expect(actions).toContain('facility.create');
    expect(entries.every((e) => e.correlationId)).toBe(true);
  });

  it('rolled-back request writes nothing (409 duplicate facility)', async () => {
    const dup = await request(app)
      .post('/api/v1/facilities')
      .set(...bearer(tokenA))
      .send({ name: 'Alpha General' });
    expect(dup.status).toBe(409);
    expect((dup.body as { code: string }).code).toBe('facility_exists');

    const list = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(tokenA));
    const names = (
      list.body as { facilities: { name: string }[] }
    ).facilities.filter((f) => f.name === 'Alpha General');
    expect(names).toHaveLength(1);
  });
});
