import 'dotenv/config';
import { z } from 'zod';

// The ONLY place (besides the secrets adapter) that reads process.env.
// Module code imports the typed `config` object instead.

const boolFromString = z
  .string()
  .transform((v) => v === 'true' || v === '1')
  .pipe(z.boolean());

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  DATABASE_URL: z.string().min(1),
  DIRECT_DATABASE_URL: z.string().min(1).optional(),
  REDIS_URL: z.string().min(1).default('redis://localhost:6379'),

  AUTH_JWT_SECRET: z.string().min(8),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2_592_000),
  AUTH_DEV_MODE: boolFromString.default(false),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET_MEDIA: z.string().default('cathaid-media'),
  S3_BUCKET_CHAT: z.string().default('cathaid-chat'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  EPIC_SANDBOX_TOKEN_URL: z.string().optional(),
  EPIC_SANDBOX_FHIR_BASE: z.string().optional(),
  EHR_EPIC_CLIENT_ID: z.string().optional(),
  EHR_JWT_PRIVATE_KEY_REF: z.string().optional(),
  EHR_JWKS_KID: z.string().optional(),
  EHR_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(4000),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-6'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM_NUMBER: z.string().optional(),
  AI_VOICE_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  PHI_VENDORS_BAA_CONFIRMED: boolFromString.default(false),

  CHAT_SEND_WINDOW_ACTIVE_DAYS: z.coerce.number().int().positive().default(7),
  CHAT_SEND_WINDOW_TERMINAL_DAYS: z.coerce.number().int().positive().default(2),
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    // Fail fast — a misconfigured HIPAA service must not boot.

    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.AUTH_DEV_MODE) {
    console.error(
      'AUTH_DEV_MODE must be false in production. Refusing to start.',
    );
    process.exit(1);
  }
  return cfg;
}

export const config: Config = loadConfig();
