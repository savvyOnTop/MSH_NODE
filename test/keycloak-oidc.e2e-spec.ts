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

// M2 exit test (SSO half): the REAL OIDC authorization-code flow against local
// Keycloak (cathaid-dev realm from docker/keycloak/realm-export.json).
// Gated: requires docker Keycloak → run with KEYCLOAK_E2E=1 npm run test:e2e
const gated = process.env['KEYCLOAK_E2E'] === '1' ? describe : describe.skip;

gated('Keycloak OIDC code flow (M2 exit, SSO half)', () => {
  const app = createApp();
  let tenantId = '';
  let adminToken = '';

  beforeAll(async () => {
    const boot = await bootstrapPlatformAdmin(app);
    tenantId = await provisionTenant(
      app,
      boot.accessToken,
      `KC E2E ${Date.now()}`,
    );
    const pa = await devToken(app, {
      tenantId,
      email: 'pa@kc-e2e.io',
      isPlatformAdmin: true,
    });
    adminToken = pa.accessToken;
    const idp = await request(app)
      .put(`/api/v1/admin/tenants/${tenantId}/idp-config`)
      .set(...bearer(adminToken))
      .send({
        issuerUrl: 'http://localhost:8080/realms/cathaid-dev',
        clientId: 'cathaid-api',
        clientSecretRef: 'env:KEYCLOAK_DEV_CLIENT_SECRET',
      });
    expect(idp.status).toBe(200);
  });

  afterAll(async () => {
    await disconnectDb();
    await closeSharedRedis();
  });

  it('login → Keycloak form → callback → JIT user + our tokens; state single-use', async () => {
    // Keycloak's redirect back to PUBLIC_BASE_URL is not followed; the code+state
    // from its Location header are fed to OUR callback via supertest — the token
    // exchange reconstructs the same redirect_uri from PUBLIC_BASE_URL, so it matches.
    const login = await request(app).get(
      `/api/v1/auth/login?tenantId=${tenantId}`,
    );
    expect(login.status).toBe(302);
    const authUrl = login.headers['location'] as string;
    expect(authUrl).toContain('/realms/cathaid-dev/');

    // Fetch the Keycloak login page (keep cookies), post credentials.
    const page = await fetch(authUrl, { redirect: 'manual' });
    const cookies = page.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const html = await page.text();
    const action = /action="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
    expect(action).toBeTruthy();

    const submit = await fetch(action as string, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookies,
      },
      body: new URLSearchParams({
        username: 'referring.md',
        password: 'password',
      }),
    });
    expect(submit.status).toBe(302);
    const cbUrl = new URL(submit.headers.get('location') as string);

    // Hit OUR callback with Keycloak's code+state.
    const cb = await request(app).get(
      `/api/v1/auth/callback?${cbUrl.searchParams.toString()}`,
    );
    expect(cb.status).toBe(200);
    const tokens = cb.body as {
      accessToken: string;
      refreshToken: string;
      userId: string;
    };
    expect(tokens.accessToken).toBeTruthy();

    // JIT row landed with the IdP identity.
    const users = await request(app)
      .get('/api/v1/users')
      .set(...bearer(adminToken));
    const emails = (users.body as { users: { email: string }[] }).users.map(
      (u) => u.email,
    );
    expect(emails).toContain('referring.md@mountsinai.dev');

    // Our access token works on a protected route (403 = authenticated but
    // unprivileged — auth layer passed; 401 would mean the token failed).
    const probe = await request(app)
      .get('/api/v1/facilities')
      .set(...bearer(tokens.accessToken));
    expect(probe.status).toBe(403);

    // State is single-use: replaying the callback fails.
    const replay = await request(app).get(
      `/api/v1/auth/callback?${cbUrl.searchParams.toString()}`,
    );
    expect(replay.status).toBe(401);
  });
});
