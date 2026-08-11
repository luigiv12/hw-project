import { Pool } from 'pg';

/**
 * Reconciles the denormalised site summary against the raw measurements.
 *
 * `sites.total_emissions_to_date_kg` is a counter maintained by the ingest
 * transaction; it is never recomputed from `measurements` at read time, because
 * summing partitions on every dashboard poll does not survive contact with 100M
 * rows. The cost of that choice is that the counter can, in principle, drift
 * from the rows it summarises.
 *
 * Drift is the precise signature of the failure this system exists to prevent:
 *   stored > computed  → something was counted twice (a retry was applied twice,
 *                        or a lost update reordered two concurrent writers)
 *   stored < computed  → an update was lost, or rows were written outside the
 *                        transaction that maintains the counter
 *
 * Exits non-zero on any mismatch so it can be used as a check in CI or after a
 * load test, not only read by a human.
 */

type Row = {
  id: string;
  name: string;
  stored_total: string;
  computed_total: string;
  stored_count: string;
  computed_count: string;
  total_delta: string;
  count_delta: string;
};

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString, max: 1 });

  try {
    const { rows } = await pool.query<Row>(`
      SELECT
        s.id,
        s.name,
        s.total_emissions_to_date_kg::text            AS stored_total,
        COALESCE(m.total, 0)::text                    AS computed_total,
        s.measurement_count::text                     AS stored_count,
        COALESCE(m.cnt, 0)::text                      AS computed_count,
        (s.total_emissions_to_date_kg - COALESCE(m.total, 0))::text AS total_delta,
        (s.measurement_count - COALESCE(m.cnt, 0))::text            AS count_delta
      FROM sites s
      LEFT JOIN (
        SELECT site_id, SUM(ch4_kg) AS total, COUNT(*) AS cnt
        FROM measurements
        GROUP BY site_id
      ) m ON m.site_id = s.id
      ORDER BY s.name
    `);

    let drifted = 0;

    console.log(
      '\n  site                                stored kg    computed kg    rows(stored/actual)  status',
    );
    console.log('  ' + '-'.repeat(88));

    for (const r of rows) {
      // Exact decimal comparison — these are numeric columns and a tolerance
      // would defeat the purpose of the check.
      const totalOk = Number(r.total_delta) === 0;
      const countOk = Number(r.count_delta) === 0;
      const ok = totalOk && countOk;
      if (!ok) drifted++;

      console.log(
        `  ${r.name.padEnd(34)}${r.stored_total.padStart(11)}${r.computed_total.padStart(15)}` +
          `${`${r.stored_count}/${r.computed_count}`.padStart(21)}  ${ok ? 'ok' : 'DRIFT'}`,
      );

      if (!totalOk) {
        console.log(
          `      total drift ${r.total_delta} kg — ${
            Number(r.total_delta) > 0
              ? 'stored exceeds actual: emissions were DOUBLE COUNTED'
              : 'stored trails actual: an update was LOST'
          }`,
        );
      }
      if (!countOk) {
        console.log(`      count drift ${r.count_delta} rows`);
      }
    }

    // Measurements whose site no longer exists would be invisible above.
    const { rows: orphans } = await pool.query<{ n: string }>(`
      SELECT COUNT(*)::text AS n
      FROM measurements m
      LEFT JOIN sites s ON s.id = m.site_id
      WHERE s.id IS NULL
    `);

    const orphanCount = Number(orphans[0]?.n ?? 0);
    if (orphanCount > 0) {
      drifted++;
      console.log(`\n  ${orphanCount} measurement(s) reference a missing site`);
    }

    if (drifted === 0) {
      console.log(
        `\n  ${rows.length} site(s) reconciled — summaries match measurements exactly\n`,
      );
    } else {
      console.log(`\n  ${drifted} site(s) FAILED reconciliation\n`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error('[verify] failed:', err);
  process.exit(1);
});
