import { z } from 'zod';

export const createUserSchema = z.object({
  email: z.email(),
  name: z.string().min(1).max(200),
  phoneE164: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'E.164 format required')
    .optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const listUsersSchema = z.object({
  status: z.enum(['active', 'suspended']).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersSchema>;

export const createRoleSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'UPPER_SNAKE_CASE'),
  name: z.string().min(1).max(200),
  workflowDefId: z.uuid().optional(),
  permissions: z.array(z.string().min(1)).min(1).max(100),
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const createMembershipSchema = z.object({
  userId: z.uuid(),
  roleId: z.uuid(),
  facilityId: z.uuid().optional(),
  workflowDefId: z.uuid().optional(),
});
export type CreateMembershipInput = z.infer<typeof createMembershipSchema>;

export const effectivePermissionsQuerySchema = z.object({
  facilityId: z.uuid().optional(),
  workflowDefId: z.uuid().optional(),
});
export type EffectivePermissionsQuery = z.infer<
  typeof effectivePermissionsQuerySchema
>;

export const userIdParamSchema = z.object({ id: z.uuid() });
