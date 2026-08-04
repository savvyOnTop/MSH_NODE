import { pino, type Logger } from 'pino';
import { config } from '../config/index.js';
import { scrubPhi } from './phi-scrubber.js';

export const logger: Logger = pino({
  level: config.LOG_LEVEL,
  formatters: {
    // Scrub every merged log object — the last line of defense against PHI in logs.
    log(object) {
      return scrubPhi(object) as Record<string, unknown>;
    },
  },
  ...(config.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

export type { Logger };
export { scrubPhi } from './phi-scrubber.js';
