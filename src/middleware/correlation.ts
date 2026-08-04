import type { NextFunction, Request, Response } from 'express';
import { pinoHttp } from 'pino-http';
import { uuidv7 } from 'uuidv7';
import { logger } from '../infra/logger/index.js';

declare module 'express-serve-static-core' {
  interface Request {
    correlationId: string;
  }
}

// correlation → everything else: every request gets an id, echoed back and
// attached to the request-scoped child logger (req.log).
export function correlation(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const id =
    (req.headers['x-correlation-id'] as string | undefined) ?? uuidv7();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}

export const httpLogger = pinoHttp({
  logger,
  genReqId: (req) => (req as Request).correlationId,
  customProps: (req) => ({ correlationId: (req as Request).correlationId }),
  autoLogging: {
    ignore: (req) => req.url === '/api/v1/health',
  },
});
