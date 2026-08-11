import { defineConfig } from 'drizzle-kit';

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
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
