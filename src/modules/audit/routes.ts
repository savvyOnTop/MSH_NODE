import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { auditQuerySchema, type AuditQuery } from './schema.js';
import { listAuditRows } from './repository.js';

// Mounted behind devPrincipal + tenantScope — every query here already runs
// inside the tenant transaction. TODO(M2): requirePermission('audit.read').
export function auditRoutes(): Router {
  const router = Router();

  router.get('/', validate({ query: auditQuerySchema }), async (req, res) => {
    const q = req.validatedQuery as AuditQuery;
    const entries = await listAuditRows(q);
    res.json({ entries });
  });

  return router;
}
