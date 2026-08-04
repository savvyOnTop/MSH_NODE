import { z } from 'zod';

export const devTokenSchema = z.object({
  tenantId: z.uuid(),
  email: z.email(),
  name: z.string().min(1).max(200).optional(),
  isPlatformAdmin: z.boolean().optional(),
});
export type DevTokenInput = z.infer<typeof devTokenSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(16).max(128),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const loginQuerySchema = z.object({
  tenantId: z.uuid(),
  /** optional client redirect after auth (mobile deep link etc.) */
  redirectUri: z.string().max(2000).optional(),
});

export const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  iss: z.string().optional(),
  session_state: z.string().optional(),
});
