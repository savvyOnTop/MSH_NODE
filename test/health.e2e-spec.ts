import request from 'supertest';
import { createApp } from '../src/app.js';
import { disconnectDb } from '../src/infra/db/index.js';
import { closeSharedRedis } from '../src/infra/redis/index.js';

// M0 exit test: health does a real SELECT 1 + redis ping; correlation id round-trips;
// unknown routes return the single error shape.
describe('GET /api/v1/health (M0 exit)', () => {
  const app = createApp();

  afterAll(async () => {
    await disconnectDb();
    await closeSharedRedis();
  });

  it('returns 200 with db+redis up and generates a correlation id', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up', redis: 'up' });
    expect(res.headers['x-correlation-id']).toBeTruthy();
  });

  it('echoes a provided x-correlation-id', async () => {
    const res = await request(app)
      .get('/api/v1/health')
      .set('x-correlation-id', 'corr-e2e-1');
    expect(res.headers['x-correlation-id']).toBe('corr-e2e-1');
  });

  it('unknown route returns the {code,message} error shape', async () => {
    // Unknown paths under /api/v1 answer 401 (auth runs before routing — no
    // route enumeration for anonymous callers); outside it, plain 404 shape.
    const inApi = await request(app).get('/api/v1/definitely-not-a-route');
    expect(inApi.status).toBe(401);

    const res = await request(app).get('/definitely-not-a-route');
    expect(res.status).toBe(404);
    const body = res.body as { code: string; message: string; stack?: unknown };
    expect(body.code).toBe('not_found');
    expect(typeof body.message).toBe('string');
    expect(body.stack).toBeUndefined();
  });
});
