import { Router } from 'express';
import { pingDb } from '../infra/db/index.js';
import { sharedRedis } from '../infra/redis/index.js';

export function healthRoutes(): Router {
  const router = Router();

  router.get('/health', async (_req, res, next) => {
    try {
      await pingDb(); // SELECT 1 through the pool (Phase 0 exit test)
      const redisPong = await sharedRedis().ping();
      res.json({
        status: 'ok',
        db: 'up',
        redis: redisPong === 'PONG' ? 'up' : 'degraded',
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
