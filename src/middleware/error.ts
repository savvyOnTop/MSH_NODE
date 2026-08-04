import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

// Single error shape for the whole API (backendMLD Phase 0):
// { code, message, details? } — never stack traces, never PHI.

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number = 400,
    message?: string,
    public readonly details?: unknown,
  ) {
    super(message ?? code);
    this.name = 'ApiError';
  }
}

export const errors = {
  badRequest: (code = 'bad_request', details?: unknown) =>
    new ApiError(code, 400, undefined, details),
  unauthorized: (code = 'unauthorized') => new ApiError(code, 401),
  forbidden: (code = 'forbidden') => new ApiError(code, 403),
  notFound: (code = 'not_found') => new ApiError(code, 404),
  conflict: (code = 'conflict') => new ApiError(code, 409),
  internal: (code = 'internal_error') => new ApiError(code, 500),
};

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    code: 'not_found',
    message: `No route: ${req.method} ${req.path}`,
  });
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      code: 'validation_error',
      message: 'Request validation failed',
      details: err.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
    return;
  }
  // Unknown error: log full (scrubbed) internally, return opaque shape to the client.
  req.log?.error({ err }, 'unhandled error');
  res
    .status(500)
    .json({ code: 'internal_error', message: 'Internal server error' });
}
