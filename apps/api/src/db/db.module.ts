import {
  Global,
  Module,
  type OnApplicationShutdown,
  Inject,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_POOL = Symbol('PG_POOL');

export type Database = NodePgDatabase<typeof schema>;

/**
 * Provides the connection pool and the Drizzle handle application-wide.
 *
 * Global because nearly every feature module needs database access, and
 * re-importing a database module into each one is ceremony that buys nothing.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Pool =>
        new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),

          /**
           * The ingest path holds a row lock for the duration of its
           * transaction, so under concurrent load connections are the binding
           * resource. Sized to absorb bursts of concurrent writers without
           * letting a stampede exhaust Postgres.
           */
          max: 20,
          idleTimeoutMillis: 30_000,

          /**
           * Fail fast when the pool is saturated rather than queueing forever.
           * A caller that waits indefinitely for a connection looks identical to
           * a hung server from the outside.
           */
          connectionTimeoutMillis: 10_000,
        }),
    },
    {
      provide: DB,
      inject: [PG_POOL],
      useFactory: (pool: Pool): Database => drizzle(pool, { schema }),
    },
  ],
  exports: [DB, PG_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Drain the pool on shutdown so in-flight transactions are not severed. */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
