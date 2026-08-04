import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';

// Zod at the edge (backendMLD Phase 0). Parsed values REPLACE the raw ones so
// handlers only ever see validated, typed data. ZodError falls through to the
// error handler → 400 {code:'validation_error', details:[{path,message}]}.

export interface ValidateSpec {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

export function validate(spec: ValidateSpec): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    try {
      if (spec.body) req.body = spec.body.parse(req.body);
      if (spec.query) {
        // Express 5: req.query is a getter — stash parsed copy for handlers.
        req.validatedQuery = spec.query.parse(req.query);
      }
      if (spec.params) req.params = spec.params.parse(req.params) as never;
      next();
    } catch (err) {
      next(err);
    }
  };
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Output of validate({query}) — Express 5 makes req.query read-only. */
    validatedQuery?: unknown;
  }
}
