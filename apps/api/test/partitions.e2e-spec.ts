import { sql } from 'drizzle-orm';
import {
  MONTHS_AHEAD,
  PartitionMaintenanceService,
} from '../src/db/partition-maintenance.service';
import { Harness } from './harness';

/**
 * Partition maintenance (bonus #3).
 *
 * The migration provisions a window around first deployment; this keeps it
 * moving. Without it the window runs out and readings land in the DEFAULT
 * partition — after which that month can no longer be partitioned at all, so the
 * ordinary one-statement fix stops working.
 */
describe('partition maintenance', () => {
  const h = new Harness();
  let partitions: PartitionMaintenanceService;

  beforeAll(async () => {
    await h.start();
    partitions = h.app.get(PartitionMaintenanceService);
  });

  afterAll(() => h.stop());

  /** Month labels Postgres names its partitions with, `MONTHS_AHEAD` out. */
  async function expectedMonths(): Promise<string[]> {
    const { rows } = await h.db.execute<{ month: string }>(sql`
      select to_char(date_trunc('month', now()) + (n || ' month')::interval, 'YYYY_MM') as month
      from generate_series(0, ${MONTHS_AHEAD}) as n
    `);
    return rows.map((r) => r.month);
  }

  async function existing(): Promise<string[]> {
    const { rows } = await h.db.execute<{ relname: string }>(sql`
      select c.relname
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      where i.inhparent = 'measurements'::regclass
    `);
    return rows.map((r) => r.relname);
  }

  it('provisions the current month and MONTHS_AHEAD beyond it', async () => {
    // Ran already at bootstrap; this asserts the outcome rather than re-running.
    const present = await existing();

    for (const month of await expectedMonths()) {
      expect(present).toContain(`measurements_${month}`);
    }
  });

  it('is idempotent, so the daily schedule is harmless busywork', async () => {
    const before = await existing();

    await partitions.ensurePartitions();
    await partitions.ensurePartitions();

    expect((await existing()).sort()).toEqual(before.sort());
  });

  /**
   * The replica race. `create_month_partition` checks `to_regclass` and then
   * creates, which is not atomic — two processes starting together can both pass
   * the check, and the loser gets `duplicate_table`. The advisory lock is what
   * makes this safe, and this asserts it rather than trusting it.
   */
  it('survives concurrent passes from several replicas', async () => {
    const passes = await Promise.allSettled(
      Array.from({ length: 5 }, () => partitions.ensurePartitions()),
    );

    const rejected = passes.filter((p) => p.status === 'rejected');
    expect(rejected).toHaveLength(0);

    // One pass did the work; the others found the lock held and skipped.
    const worked = passes.filter(
      (p) => p.status === 'fulfilled' && p.value > 0,
    );
    expect(worked.length).toBeGreaterThanOrEqual(1);
  });

  /**
   * The DEFAULT partition should be empty in a healthy system. A non-empty one is
   * the visible symptom of maintenance having lapsed, and it is what `db:verify`
   * reports on.
   */
  it('keeps ordinary readings out of the DEFAULT partition', async () => {
    const site = await h.createSite();

    await h.ingest(site.id, [
      {
        deviceId: 'PARTITION-ROUTING',
        readingTs: new Date().toISOString(),
        ch4Kg: '1.0000',
        source: 'sensor',
      },
    ]);

    const { rows } = await h.db.execute<{ n: number }>(sql`
      select count(*)::int as n from measurements_default
      where site_id = ${site.id}
    `);

    expect(rows[0]?.n).toBe(0);
  });
});
