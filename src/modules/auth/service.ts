import {
  currentTenantId,
  getTenantDb,
  runInTenant,
} from '../../infra/db/index.js';
import { audit } from '../audit/index.js';
import { signAccessToken } from './jwt.js';
import {
  createSession,
  revokeSession,
  rotateSession,
} from './session-store.js';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
}

export async function issueTokens(
  userId: string,
  tenantId: string,
): Promise<TokenPair> {
  const { sessionId } = await createSession(userId, tenantId);
  const accessToken = await signAccessToken({
    sub: userId,
    tid: tenantId,
    sid: sessionId,
  });
  return { accessToken, refreshToken: sessionId, tokenType: 'Bearer' };
}

/**
 * JIT provisioning (backendMLD Phase 2): upsert by (tenant, idp_subject);
 * email/name refresh from the IdP claims on every login. New users get ZERO
 * memberships — an admin grants roles. MUST run inside a tenant context.
 */
export async function provisionUser(claims: {
  idpSubject: string;
  email: string;
  name: string;
  isPlatformAdmin?: boolean;
}): Promise<{ id: string; status: string; created: boolean }> {
  const db = getTenantDb();
  const existing = await db.appUser.findFirst({
    where: { idpSubject: claims.idpSubject },
    select: { id: true, status: true },
  });
  if (existing) {
    await db.appUser.update({
      where: { id: existing.id },
      data: { email: claims.email, name: claims.name },
    });
    return { ...existing, created: false };
  }
  const created = await db.appUser.create({
    data: {
      tenantId: currentTenantId(),
      idpSubject: claims.idpSubject,
      email: claims.email,
      name: claims.name,
      isPlatformAdmin: claims.isPlatformAdmin ?? false,
    },
    select: { id: true, status: true },
  });
  await audit.record({
    action: 'user.jit_provision',
    resourceType: 'app_user',
    resourceId: created.id,
    summary: { idpSubject: claims.idpSubject },
  });
  return { ...created, created: true };
}

/** Rotate refresh session → fresh token pair. Null = invalid/expired/revoked. */
export async function refreshTokens(
  refreshToken: string,
): Promise<TokenPair | null> {
  const rotated = await rotateSession(refreshToken);
  if (!rotated) return null;
  const accessToken = await signAccessToken({
    sub: rotated.data.userId,
    tid: rotated.data.tenantId,
    sid: rotated.sessionId,
  });
  return {
    accessToken,
    refreshToken: rotated.sessionId,
    tokenType: 'Bearer',
  };
}

export async function logout(refreshToken: string): Promise<void> {
  await revokeSession(refreshToken);
}

/**
 * Dev-token issuer (AUTH_DEV_MODE only; the route refuses otherwise). JIT-creates
 * a user in the tenant (idp_subject `dev:{email}`) and returns a real token pair —
 * tests and local clients exercise the exact same auth path as production.
 */
export async function issueDevTokens(
  input: {
    tenantId: string;
    email: string;
    name?: string | undefined;
    isPlatformAdmin?: boolean | undefined;
  },
  meta: { correlationId?: string } = {},
): Promise<TokenPair & { userId: string }> {
  const user = await runInTenant(
    input.tenantId,
    () =>
      provisionUser({
        idpSubject: `dev:${input.email}`,
        email: input.email,
        name: input.name ?? input.email,
        ...(input.isPlatformAdmin !== undefined
          ? { isPlatformAdmin: input.isPlatformAdmin }
          : {}),
      }),
    meta,
  );
  const tokens = await issueTokens(user.id, input.tenantId);
  return { ...tokens, userId: user.id };
}
