import * as oidc from 'openid-client';
import { config } from '../../infra/config/index.js';
import { getTenantDb, runInTenant } from '../../infra/db/index.js';
import { sharedRedis } from '../../infra/redis/index.js';
import { secrets } from '../../infra/secrets/index.js';
import { errors } from '../../middleware/error.js';
import { issueTokens, provisionUser, type TokenPair } from './service.js';

// Multi-tenant OIDC (backendMLD Phase 2, openid-client v6, PKCE).
// login?tenantId → tenant's IdP (idp_config read INSIDE runInTenant — the claimed
// tenant is known pre-auth, so RLS stays intact) → callback → JIT provision →
// our own token pair. The IdP's tokens are used once and dropped; sessions are ours.

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string): string => `oidc:state:${state}`;

interface PendingLogin {
  tenantId: string;
  codeVerifier: string;
  redirectUri?: string;
}

interface IdpRow {
  issuerUrl: string;
  clientId: string;
  clientSecretRef: string;
  scopes: string;
}

/** Discovery results cached per tenant (metadata rarely changes). */
const discoveryCache = new Map<
  string,
  { cfg: oidc.Configuration; expires: number }
>();
const DISCOVERY_TTL_MS = 10 * 60 * 1000;

async function idpConfigForTenant(tenantId: string): Promise<IdpRow> {
  const row = await runInTenant(tenantId, () =>
    getTenantDb().idpConfig.findFirst({
      where: { enabled: true, protocol: 'oidc' },
      select: {
        issuerUrl: true,
        clientId: true,
        clientSecretRef: true,
        scopes: true,
      },
    }),
  );
  if (!row) throw errors.badRequest('idp_not_configured');
  return row;
}

async function discover(
  tenantId: string,
  idp: IdpRow,
): Promise<oidc.Configuration> {
  const cached = discoveryCache.get(tenantId);
  if (cached && cached.expires > Date.now()) return cached.cfg;

  const clientSecret = await secrets.get(idp.clientSecretRef);
  const cfg = await oidc.discovery(
    new URL(idp.issuerUrl),
    idp.clientId,
    clientSecret,
    undefined,
    // Dev IdP (local Keycloak) speaks plain HTTP; production issuers must be HTTPS.
    config.AUTH_DEV_MODE ? { execute: [oidc.allowInsecureRequests] } : {},
  );
  discoveryCache.set(tenantId, { cfg, expires: Date.now() + DISCOVERY_TTL_MS });
  return cfg;
}

const callbackUrl = (): string =>
  `${config.PUBLIC_BASE_URL}/api/v1/auth/callback`;

/** Build the IdP authorization redirect; PKCE verifier + tenant ride Redis keyed by state. */
export async function beginLogin(
  tenantId: string,
  redirectUri?: string,
): Promise<string> {
  const idp = await idpConfigForTenant(tenantId);
  const cfg = await discover(tenantId, idp);

  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const state = oidc.randomState();

  const pending: PendingLogin = {
    tenantId,
    codeVerifier,
    ...(redirectUri ? { redirectUri } : {}),
  };
  await sharedRedis().set(
    stateKey(state),
    JSON.stringify(pending),
    'EX',
    STATE_TTL_SECONDS,
  );

  const url = oidc.buildAuthorizationUrl(cfg, {
    redirect_uri: callbackUrl(),
    scope: idp.scopes,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return url.href;
}

export interface CallbackResult extends TokenPair {
  userId: string;
  redirectUri?: string;
}

/** Exchange the code, JIT-provision the user, mint OUR tokens. */
export async function completeLogin(currentUrl: URL): Promise<CallbackResult> {
  const state = currentUrl.searchParams.get('state');
  if (!state) throw errors.unauthorized('missing_state');

  const raw = await sharedRedis().getdel(stateKey(state));
  if (!raw) throw errors.unauthorized('unknown_or_expired_state');
  const pending = JSON.parse(raw) as PendingLogin;

  const idp = await idpConfigForTenant(pending.tenantId);
  const cfg = await discover(pending.tenantId, idp);

  const tokens = await oidc.authorizationCodeGrant(cfg, currentUrl, {
    pkceCodeVerifier: pending.codeVerifier,
    expectedState: state,
  });
  const claims = tokens.claims();
  if (!claims?.sub) throw errors.unauthorized('idp_claims_missing');

  const email =
    typeof claims['email'] === 'string' ? claims['email'] : undefined;
  const name =
    typeof claims['name'] === 'string'
      ? claims['name']
      : typeof claims['preferred_username'] === 'string'
        ? claims['preferred_username']
        : undefined;
  if (!email) throw errors.unauthorized('idp_email_missing');

  const user = await runInTenant(pending.tenantId, () =>
    provisionUser({ idpSubject: claims.sub, email, name: name ?? email }),
  );
  if (user.status !== 'active') throw errors.forbidden('user_suspended');

  const pair = await issueTokens(user.id, pending.tenantId);
  return {
    ...pair,
    userId: user.id,
    ...(pending.redirectUri ? { redirectUri: pending.redirectUri } : {}),
  };
}
