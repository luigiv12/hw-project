import { defineConfig } from 'drizzle-kit';
import { config } from 'dotenv';
import { join } from 'node:path';

/**
 * drizzle-kit invokes this config directly rather than through a runner, so
 * nothing else populates the environment for it. The repo-root .env is loaded
 * here so every drizzle-kit command works the same way the db:* scripts do.
 * A real environment variable already set wins — dotenv does not overwrite.
 */
config({ path: join(__dirname, '..', '..', '.env'), quiet: true });

/**
 * drizzle-kit config.
 *
 * `generate` is useful for diffing the schema, but 0000_init.sql is maintained
 * by hand because the measurements table is partitioned and the generator
 * cannot express `PARTITION BY`. Regenerating over it would silently drop the
 * partitioning — inspect any generated output before keeping it.
 */
export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      (() => {
        throw new Error(
          'DATABASE_URL is not set. Copy .env.example to .env, or pass it inline:\n' +
            '  DATABASE_URL="postgresql://…" pnpm db:studio',
        );
      })(),
  },
  verbose: true,
  strict: true,
});
