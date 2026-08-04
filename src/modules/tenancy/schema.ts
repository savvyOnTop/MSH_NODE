import { z } from 'zod';

export const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  region: z.string().min(1).max(50).default('us-east-1'),
});
export type CreateTenantInput = z.infer<typeof createTenantSchema>;

export const createFacilitySchema = z.object({
  name: z.string().min(1).max(200),
  timezone: z.string().min(1).max(64).default('America/New_York'),
  address: z.record(z.string(), z.unknown()).optional(),
  /** e.g. { "kind": "virtual" } for pseudo-locations (Floor, Field/FDNY, ...) */
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type CreateFacilityInput = z.infer<typeof createFacilitySchema>;

export const listFacilitiesSchema = z.object({
  status: z.enum(['active', 'inactive']).optional(),
});
export type ListFacilitiesQuery = z.infer<typeof listFacilitiesSchema>;

export const tenantIdParamSchema = z.object({ id: z.uuid() });

export const upsertIdpConfigSchema = z.object({
  issuerUrl: z.url(),
  clientId: z.string().min(1).max(200),
  /** Secrets-adapter reference (e.g. "env:KEYCLOAK_DEV_CLIENT_SECRET") — NEVER a raw secret */
  clientSecretRef: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => !v.includes(' '), 'reference, not a secret'),
  scopes: z.string().min(1).max(500).default('openid profile email'),
  enabled: z.boolean().default(true),
});
export type UpsertIdpConfigInput = z.infer<typeof upsertIdpConfigSchema>;
