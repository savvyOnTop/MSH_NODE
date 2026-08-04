import { z } from 'zod';

export const auditQuerySchema = z.object({
  resourceType: z.string().min(1).max(100).optional(),
  action: z.string().min(1).max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

export const auditEntrySchema = z.object({
  id: z.uuid(),
  action: z.string(),
  resourceType: z.string(),
  resourceId: z.uuid().nullable(),
  actorUserId: z.uuid().nullable(),
  summary: z.unknown().nullable(),
  correlationId: z.string().nullable(),
  createdAt: z.date(),
});
