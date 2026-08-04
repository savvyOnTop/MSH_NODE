import { createApp } from './app.js';
import { config } from './infra/config/index.js';
import { logger } from './infra/logger/index.js';
import { disconnectDb } from './infra/db/index.js';
import { closeSharedRedis } from './infra/redis/index.js';

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info(
    {
      port: config.PORT,
      env: config.NODE_ENV,
      docs: `${config.PUBLIC_BASE_URL}/docs`,
    },
    'cathaid-api listening',
  );
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'shutting down');
  server.close(() => {
    void (async () => {
      await disconnectDb();
      await closeSharedRedis();
      process.exit(0);
    })();
  });
  // Hard exit if graceful close hangs (e.g. open SSE/WS connections).
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
