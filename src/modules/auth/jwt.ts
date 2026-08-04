import { SignJWT, jwtVerify } from 'jose';
import { config } from '../../infra/config/index.js';

// Access JWT (backendMLD Phase 2): short-lived, claims sub/tid/sid ONLY —
// permissions are resolved per-request from the DB, never baked into the token,
// so role revocation takes effect immediately. HS256 with the shared dev secret;
// RS256 + published JWKS is the production path (key swap, same interface).

const secret = new TextEncoder().encode(config.AUTH_JWT_SECRET);
const ISSUER = 'cathaid-api';

export interface AccessClaims {
  /** app_user.id */
  sub: string;
  /** tenant id */
  tid: string;
  /** refresh-session id (revocation anchor) */
  sid: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ tid: claims.tid, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${config.AUTH_ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

/** Throws on bad signature / expiry / wrong issuer / missing claims. */
export async function verifyAccessToken(token: string): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
  const { sub } = payload;
  const tid = payload['tid'];
  const sid = payload['sid'];
  if (
    typeof sub !== 'string' ||
    typeof tid !== 'string' ||
    typeof sid !== 'string'
  ) {
    throw new Error('access token missing required claims');
  }
  return { sub, tid, sid };
}
