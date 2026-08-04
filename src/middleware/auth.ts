import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken } from '../modules/auth/jwt.js';
import { errors } from './error.js';
import type { Principal } from './tenant-scope.js';

// Auth middleware (chain position: correlation → AUTH → tenant-scope → authz).
// Verifies our access JWT and sets req.principal; everything tenant-scoped
// hangs off this. 401 on missing/garbage/expired token — never a silent pass.

export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const header = req.header('authorization');
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) {
    next(errors.unauthorized('missing_token'));
    return;
  }
  verifyAccessToken(token)
    .then((claims) => {
      const principal: Principal & { sessionId: string } = {
        userId: claims.sub,
        tenantId: claims.tid,
        sessionId: claims.sid,
      };
      req.principal = principal;
      next();
    })
    .catch(() => {
      next(errors.unauthorized('invalid_token'));
    });
}
