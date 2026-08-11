import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { join } from 'node:path';

/**
 * Applies pending migrations, then exits.
 *
 * Run as a one-shot step — the `migrate` compose service locally, a release
 * command in deployment — never at application boot. Booting N API instances
 * that each migrate on startup is a race, and Drizzle's migration lock would
 * turn it into a startup stall rather than a correctness bug, which is only
 * marginally better.
 */
async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is required to run migrations');
  }

  const pool = new Pool({ connectionString, max: 1 });

  try {
    const db = drizzle(pool);
    const migrationsFolder = join(__dirname, '..', '..', 'drizzle');

    console.log(`[migrate] applying migrations from ${migrationsFolder}`);
    await migrate(db, { migrationsFolder });
    console.log('[migrate] up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
