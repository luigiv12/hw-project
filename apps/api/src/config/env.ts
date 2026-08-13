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

  /**
   * Number of reverse proxies in front of this process.
   *
   * Rate limiting buckets by client IP, and behind a proxy every request
   * arrives from the proxy's address — so without this the whole internet
   * shares one bucket and the limit is effectively global.
   *
   * Defaults to 0 rather than 1 because the failure modes are asymmetric.
   * Trusting a hop that does not exist lets any caller set `X-Forwarded-For`
   * and be metered as whatever address they like, which is worse than the
   * over-strict bucketing of not trusting one that does. Set it to the actual
   * hop count: 1 behind Railway, Fly, or a single nginx.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().nonnegative().default(0),

  /**
   * Bearer token required to scrape `/metrics`. Unset leaves the endpoint open.
   *
   * Open is the right default for local development and for a demo deployment
   * whose README invites a reviewer to curl it. It is the wrong default for an
   * operational deployment, where the exposition reveals ingest volumes, site
   * counts, error rates, and — through the default process collectors — runtime
   * and version detail worth not publishing.
   */
  METRICS_TOKEN: z.string().min(1).optional(),

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
