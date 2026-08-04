import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../logger/index.js';

// Factory — BullMQ needs its own connections (maxRetriesPerRequest: null),
// so callers create purpose-scoped instances instead of sharing one client.
export function createRedis(
  purpose: string,
  options: { forBullMq?: boolean } = {},
): Redis {
  const client = new Redis(config.REDIS_URL, {
    ...(options.forBullMq ? { maxRetriesPerRequest: null } : {}),
    lazyConnect: false,
  });
  client.on('error', (err) => logger.error({ err, purpose }, 'redis error'));
  return client;
}

let shared: Redis | undefined;

/** Shared client for simple KV/session use. Not for BullMQ, not for subscribers. */
export function sharedRedis(): Redis {
  shared ??= createRedis('shared');
  return shared;
}

export async function closeSharedRedis(): Promise<void> {
  if (shared) {
    await shared.quit();
    shared = undefined;
  }
}
