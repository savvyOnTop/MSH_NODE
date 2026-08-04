import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';

// Shared e2e helpers. Bootstrap identity: the dev-token issuer works for any
// tenant id (it only opens a tenant context), while tenantScope checks the
// tenant row — so a platform-admin token in a throwaway tenant id can drive
// the control-plane /admin endpoints to provision REAL tenants. Dev-mode only.

export interface DevTokens {
  accessToken: string;
  refreshToken: string;
  userId: string;
}

export async function devToken(
  app: Express,
  input: {
    tenantId: string;
    email: string;
    name?: string;
    isPlatformAdmin?: boolean;
  },
): Promise<DevTokens> {
  const res = await request(app).post('/api/v1/auth/dev-token').send(input);
  if (res.status !== 200) {
    throw new Error(
      `dev-token failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return res.body as DevTokens;
}

/** Platform-admin token in a throwaway tenant (for /admin control-plane calls). */
export async function bootstrapPlatformAdmin(app: Express): Promise<DevTokens> {
  return devToken(app, {
    tenantId: randomUUID(),
    email: `boot-${randomUUID().slice(0, 8)}@test.io`,
    isPlatformAdmin: true,
  });
}

export async function provisionTenant(
  app: Express,
  adminAccessToken: string,
  name: string,
): Promise<string> {
  const res = await request(app)
    .post('/api/v1/admin/tenants')
    .set('authorization', `Bearer ${adminAccessToken}`)
    .send({ name });
  if (res.status !== 201) {
    throw new Error(
      `provision failed: ${res.status} ${JSON.stringify(res.body)}`,
    );
  }
  return (res.body as { id: string }).id;
}

export const bearer = (t: string): [string, string] => [
  'authorization',
  `Bearer ${t}`,
];
