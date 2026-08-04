import {
  currentMeta,
  currentTenantId,
  getTenantDb,
  Prisma,
} from '../../infra/db/index.js';
import type { AuditQuery } from './schema.js';

// Sole write path to audit_log (append-only: app_runtime has INSERT+SELECT only;
// storage-level WORM comes with production infra). No UPDATE/DELETE methods — ever.

export interface AuditRecordInput {
  action: string;
  resourceType: string;
  resourceId?: string;
  /** PHI-minimized digest: field NAMES / ids, never clinical values. */
  summary?: Record<string, unknown>;
  /** Defaults to the actor riding the tenant context (set by tenant-scope middleware). */
  actorUserId?: string;
}

export async function insertAuditRow(input: AuditRecordInput): Promise<void> {
  const meta = currentMeta();
  await getTenantDb().auditLog.create({
    data: {
      tenantId: currentTenantId(),
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      actorUserId: input.actorUserId ?? meta.actorUserId ?? null,
      summary: (input.summary ?? Prisma.JsonNull) as never,
      ip: meta.ip ?? null,
      correlationId: meta.correlationId ?? null,
    },
  });
}

export async function listAuditRows(q: AuditQuery) {
  return getTenantDb().auditLog.findMany({
    where: {
      ...(q.resourceType ? { resourceType: q.resourceType } : {}),
      ...(q.action ? { action: q.action } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: q.from } : {}),
              ...(q.to ? { lte: q.to } : {}),
            },
          }
        : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: q.limit,
    select: {
      id: true,
      action: true,
      resourceType: true,
      resourceId: true,
      actorUserId: true,
      summary: true,
      correlationId: true,
      createdAt: true,
    },
  });
}
