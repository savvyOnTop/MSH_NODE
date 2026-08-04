import request from 'supertest';
import { createApp } from '../src/app.js';
import { disconnectDb } from '../src/infra/db/index.js';
import { closeSharedRedis } from '../src/infra/redis/index.js';
import {
  bearer,
  bootstrapPlatformAdmin,
  devToken,
  provisionTenant,
} from './helpers.js';

// M2 exit test (CI half): the auth + RBAC matrix through the real middleware
// chain — 401s, 403 → grant → 200, effective permissions, refresh rotation,
// revocation, JIT idempotency. (The Keycloak code-flow half lives in
// keycloak-oidc.e2e-spec.ts, gated by KEYCLOAK_E2E=1.)

describe('auth + RBAC (M2 exit, CI half)', () => {
  const app = createApp();
  const suffix = Date.now();
  let tenantId = '';
  let platformAdminToken = ''; // platform admin inside the real tenant
  let userToken = '';
  let userRefresh = '';
  let userId = '';

  beforeAll(async () => {
    const boot = await bootstrapPlatformAdmin(app);
    tenantId = await provisionTenant(
      app,
      boot.accessToken,
      `RBAC E2E ${suffix}`,
    );
    const pa = await devToken(app, {
      tenantId,
      email: 'pa@rbac-e2e.io',
      isPlatformAdmin: true,
    });
    platformAdminToken = pa.accessToken;
    const user = await devToken(app, { tenantId, email: 'user@rbac-e2e.io' });
    userToken = user.accessToken;
    userRefresh = user.refreshToken;
    userId = user.userId;
  });

  afterAll(async () => {
    await disconnectDb();
    await closeSharedRedis();
  });

  it('401 without token, 401 with garbage token', async () => {
    const none = await request(app).get('/api/v1/facilities');
    expect(none.status).toBe(401);
    expect((none.body as { code: string }).code).toBe('missing_token');

    const garbage = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer('garbage.token.here'));
    expect(garbage.status).toBe(401);
    expect((garbage.body as { code: string }).code).toBe('invalid_token');
  });

  it('403 without permission → membership grant → 200', async () => {
    const before = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(userToken));
    expect(before.status).toBe(403);
    expect((before.body as { code: string }).code).toBe('missing_permission');

    // provisioning seeded TENANT_ADMIN with the full catalog
    const roles = await request(app)
      .get('/api/v1/roles')
      .set(...bearer(platformAdminToken));
    const role = (
      roles.body as { roles: { id: string; code: string }[] }
    ).roles.find((r) => r.code === 'TENANT_ADMIN');
    expect(role).toBeDefined();

    const grant = await request(app)
      .post('/api/v1/memberships')
      .set(...bearer(platformAdminToken))
      .send({ userId, roleId: role?.id });
    expect(grant.status).toBe(201);

    const after = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(userToken));
    expect(after.status).toBe(200);
  });

  it('effective permissions = full catalog after TENANT_ADMIN grant', async () => {
    const res = await request(app)
      .get(`/api/v1/users/${userId}/effective-permissions`)
      .set(...bearer(platformAdminToken));
    expect(res.status).toBe(200);
    const perms = (res.body as { permissions: string[] }).permissions;
    expect(perms.length).toBe(36);
    expect(perms).toContain('case.accept');
    expect(perms).toContain('audit.read');
  });

  it('facility-scoped membership does NOT apply tenant-wide', async () => {
    const scoped = await devToken(app, {
      tenantId,
      email: 'scoped@rbac-e2e.io',
    });
    const facility = await request(app)
      .post('/api/v1/facilities')
      .set(...bearer(platformAdminToken))
      .send({ name: `Scoped Facility ${suffix}` });
    expect(facility.status).toBe(201);
    const facilityId = (facility.body as { id: string }).id;

    const roles = await request(app)
      .get('/api/v1/roles')
      .set(...bearer(platformAdminToken));
    const role = (
      roles.body as { roles: { id: string; code: string }[] }
    ).roles.find((r) => r.code === 'TENANT_ADMIN');

    await request(app)
      .post('/api/v1/memberships')
      .set(...bearer(platformAdminToken))
      .send({ userId: scoped.userId, roleId: role?.id, facilityId });

    // tenant-wide question (no facility scope) → facility-scoped grant invisible
    const tenantWide = await request(app)
      .get(`/api/v1/users/${scoped.userId}/effective-permissions`)
      .set(...bearer(platformAdminToken));
    expect((tenantWide.body as { permissions: string[] }).permissions).toEqual(
      [],
    );

    // scoped question → full grant visible
    const inFacility = await request(app)
      .get(
        `/api/v1/users/${scoped.userId}/effective-permissions?facilityId=${facilityId}`,
      )
      .set(...bearer(platformAdminToken));
    expect(
      (inFacility.body as { permissions: string[] }).permissions.length,
    ).toBe(36);
  });

  it('role creation refuses permission codes outside the catalog', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set(...bearer(platformAdminToken))
      .send({
        code: 'HACKER_ROLE',
        name: 'Nope',
        permissions: ['case.view', 'totally.made.up'],
      });
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe(
      'unknown_permission_codes',
    );
  });

  it('JIT is idempotent: same dev email → same user id', async () => {
    const again = await devToken(app, { tenantId, email: 'user@rbac-e2e.io' });
    expect(again.userId).toBe(userId);
  });

  it('refresh rotates; old refresh token dies; logout revokes', async () => {
    const r1 = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: userRefresh });
    expect(r1.status).toBe(200);
    const rotated = (r1.body as { refreshToken: string }).refreshToken;
    expect(rotated).not.toBe(userRefresh);

    const replay = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: userRefresh });
    expect(replay.status).toBe(401);

    const out = await request(app)
      .post('/api/v1/auth/logout')
      .send({ refreshToken: rotated });
    expect(out.status).toBe(204);

    const afterLogout = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: rotated });
    expect(afterLogout.status).toBe(401);
  });

  it('control plane refuses non-platform-admins', async () => {
    const res = await request(app)
      .post('/api/v1/admin/tenants')
      .set(...bearer(userToken))
      .send({ name: 'nope' });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('platform_admin_required');
  });
});
