import { z } from 'zod';

/**
 * Environment contract.
 *
 * Validated once at boot so a misconfigured deployment fails immediately and
 * loudly, rather than surfacing later as an undefined connection string halfway
 * through an ingest transaction.
 */
export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().int().positive().default(3000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  /**
   * Comma-separated allowlist. Explicit origins rather than `*` — the API
   * accepts writes, and a wildcard on a write surface is a habit worth not
   * forming even on a demo.
   */
  CORS_ORIGINS: z.string().default('http://localhost:3001'),

  /** Poll interval for the transactional outbox dispatcher. */
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(1000),

  /**
   * Where the outbox delivers. Unset means log-only, which is the default for
   * local development and the demo deployment — the guarantee under test is
   * that delivery is *attempted exactly according to the outbox*, not that some
   * particular downstream exists.
   */
  ALERTING_WEBHOOK_URL: z.string().url().optional(),

  RATE_LIMIT_TTL_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),
});

export type Env = z.infer<typeof envSchema>;

/** Passed to ConfigModule as its `validate` hook. */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}

export function corsOrigins(env: Env): string[] {
  return env.CORS_ORIGINS.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}
