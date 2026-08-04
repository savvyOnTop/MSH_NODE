import { Router } from 'express';
import { config } from '../../infra/config/index.js';
import { errors } from '../../middleware/error.js';
import { validate } from '../../middleware/validate.js';
import {
  devTokenSchema,
  loginQuerySchema,
  refreshSchema,
  type DevTokenInput,
  type RefreshInput,
} from './schema.js';
import { beginLogin, completeLogin } from './oidc.js';
import { issueDevTokens, logout, refreshTokens } from './service.js';

// Public auth surface (mounted OUTSIDE requireAuth/tenantScope):
// dev-token (dev only) + refresh + logout here; OIDC login/callback in oidc.ts.
export function authRoutes(): Router {
  const router = Router();

  router.post(
    '/dev-token',
    validate({ body: devTokenSchema }),
    async (req, res) => {
      if (!config.AUTH_DEV_MODE) {
        throw errors.notFound(); // pretend it doesn't exist outside dev
      }
      const tokens = await issueDevTokens(req.body as DevTokenInput, {
        ...(req.correlationId ? { correlationId: req.correlationId } : {}),
      });
      res.json(tokens);
    },
  );

  // OIDC code flow (multi-tenant SSO)
  router.get(
    '/login',
    validate({ query: loginQuerySchema }),
    async (req, res) => {
      const q = req.validatedQuery as {
        tenantId: string;
        redirectUri?: string;
      };
      res.redirect(await beginLogin(q.tenantId, q.redirectUri));
    },
  );

  router.get('/callback', async (req, res) => {
    const result = await completeLogin(
      new URL(req.originalUrl, config.PUBLIC_BASE_URL),
    );
    if (result.redirectUri) {
      // Tokens in the fragment: never hit server logs / Referer headers.
      const fragment = new URLSearchParams({
        access_token: result.accessToken,
        refresh_token: result.refreshToken,
      });
      res.redirect(`${result.redirectUri}#${fragment.toString()}`);
      return;
    }
    res.json({
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      tokenType: result.tokenType,
      userId: result.userId,
    });
  });

  router.post(
    '/refresh',
    validate({ body: refreshSchema }),
    async (req, res) => {
      const tokens = await refreshTokens(
        (req.body as RefreshInput).refreshToken,
      );
      if (!tokens) throw errors.unauthorized('invalid_refresh_token');
      res.json(tokens);
    },
  );

  router.post(
    '/logout',
    validate({ body: refreshSchema }),
    async (req, res) => {
      await logout((req.body as RefreshInput).refreshToken);
      res.status(204).end();
    },
  );

  return router;
}
