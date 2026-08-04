import { randomBytes } from 'node:crypto';
import { config } from '../../infra/config/index.js';
import { sharedRedis } from '../../infra/redis/index.js';

// Refresh sessions (backendMLD Phase 2): opaque 256-bit token = Redis key id.
// `session:{id}` → JSON, TTL = refresh lifetime. Rotation on every use (the old
// id dies), deletion = immediate revocation of the refresh path; access JWTs
// simply age out (≤15 min).

export interface SessionData {
  userId: string;
  tenantId: string;
  issuedAt: number;
}

const key = (id: string): string => `session:${id}`;

export async function createSession(
  userId: string,
  tenantId: string,
): Promise<{ sessionId: string }> {
  const sessionId = randomBytes(32).toString('base64url');
  const data: SessionData = { userId, tenantId, issuedAt: Date.now() };
  await sharedRedis().set(
    key(sessionId),
    JSON.stringify(data),
    'EX',
    config.AUTH_REFRESH_TOKEN_TTL_SECONDS,
  );
  return { sessionId };
}

export async function getSession(id: string): Promise<SessionData | null> {
  const raw = await sharedRedis().get(key(id));
  return raw ? (JSON.parse(raw) as SessionData) : null;
}

/** Single-use rotation: old id is deleted atomically before the new one is minted. */
export async function rotateSession(
  oldId: string,
): Promise<{ sessionId: string; data: SessionData } | null> {
  const raw = await sharedRedis().getdel(key(oldId));
  if (!raw) return null;
  const old = JSON.parse(raw) as SessionData;
  const { sessionId } = await createSession(old.userId, old.tenantId);
  return { sessionId, data: old };
}

export async function revokeSession(id: string): Promise<void> {
  await sharedRedis().del(key(id));
}
