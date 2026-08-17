import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'drizzle-orm';
import { DB, type Database } from './db.module';

/**
 * How far ahead to keep partitions provisioned.
 *
 * Three months of runway means a job that fails, or a deployment that sits idle,
 * has weeks of slack before readings start landing in the DEFAULT partition —
 * while keeping the partition count low, which matters because query planning
 * over `measurements` scales with it.
 */
export const MONTHS_AHEAD = 3;

/**
 * Advisory lock key, arbitrary but fixed.
 *
 * Any replica may run this job; only one should run it at a time.
 */
const LOCK_KEY = 4_820_115_003n;

/**
 * Keeps monthly partitions of `measurements` provisioned ahead of time
 * (bonus #3).
 *
 * Migration 0000 creates the `create_month_partition` helper and provisions a
 * window around first deployment. Nothing kept that window moving, so the
 * provisioned months eventually run out — and the consequence is worse than it
 * looks. Once a reading for an uncovered month lands in `measurements_default`,
 * that month's partition can no longer be created at all:
 *
 *   ERROR: updated partition constraint for default partition
 *          "measurements_default" would be violated by some row
 *
 * So the DEFAULT partition does not defer this problem, it *closes the ordinary
 * fix* — recovering means moving rows out of DEFAULT under load rather than
 * running one DDL statement. It prevents data loss, which is its job, and that
 * is all it does.
 *
 * Deliberately not on the ingest path. `CREATE TABLE … PARTITION OF` takes a lock
 * on the parent, so doing it per request would serialise writers against each
 * other for no benefit — the work is identical whoever triggers it.
 */
@Injectable()
export class PartitionMaintenanceService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartitionMaintenanceService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Run once at startup as well as on the schedule, so a fresh deployment is
   * covered immediately rather than at the next firing.
   */
  async onApplicationBootstrap(): Promise<void> {
    await this.ensurePartitions();
  }

  /**
   * Daily rather than monthly. A monthly schedule has exactly twelve chances a
   * year to run, and a missed one is only noticed when writes reach DEFAULT;
   * daily makes the job idempotent busywork that self-heals after any outage.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async scheduled(): Promise<void> {
    await this.ensurePartitions();
  }

  /**
   * Creates any missing partition from the current month through
   * `MONTHS_AHEAD`.
   *
   * Safe to call concurrently. `create_month_partition` checks `to_regclass`
   * before creating, but that check and the create are not atomic, so two
   * replicas starting together can both pass it and one then fails on
   * `duplicate_table`. An advisory lock closes that window; `try_` rather than a
   * blocking acquire because a replica that cannot get the lock has nothing to
   * wait for — whoever holds it is doing the identical work.
   */
  async ensurePartitions(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ locked: boolean }>(
        sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as locked`,
      );

      if (!rows[0]?.locked) {
        this.logger.debug(
          'partition maintenance is already running elsewhere, skipping this pass',
        );
        return 0;
      }

      /**
       * Month arithmetic stays in SQL rather than moving to JavaScript, so
       * "the current month" is the database's opinion. Computing it here would
       * make coverage depend on the API process's timezone agreeing with the
       * session's, which is a difference that only shows up on one day a month.
       */
      await tx.execute(sql`
        select create_month_partition(
          (date_trunc('month', now()) + (n || ' month')::interval)::date
        )
        from generate_series(0, ${MONTHS_AHEAD}) as n
      `);

      const { rows: coverage } = await tx.execute<{ through: string }>(sql`
        select to_char(
          date_trunc('month', now()) + (${MONTHS_AHEAD} || ' month')::interval,
          'YYYY_MM'
        ) as through
      `);

      /**
       * Reports coverage rather than what was created. `create_month_partition`
       * is idempotent and does not say whether it did anything, and the fact an
       * operator needs is how far ahead the table is provisioned.
       */
      const months = MONTHS_AHEAD + 1;
      this.logger.log(
        `partition coverage ensured through ${coverage[0]?.through} (${months} months checked)`,
      );

      return months;
    });
  }
}
