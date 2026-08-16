import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { ingestionBatches, measurements, sites } from './schema';

/**
 * Seeds a demo dataset.
 *
 * Deliberately includes one site already over its limit, so "Limit Exceeded" is
 * visible on the dashboard and in GET /metrics without a reviewer having to
 * ingest anything first.
 *
 * Destructive by default: truncates and rebuilds. Intended for local development
 * and the one-time seeding of the demo deployment, not for a live dataset.
 *
 * Pass `--if-empty` to make it a no-op when any site already exists. That is how
 * compose invokes it, so bringing the stack up a second time does not discard
 * data someone ingested against the first.
 */

type SeedSite = {
  id: string;
  name: string;
  emissionLimitKg: string;
  metadata: Record<string, unknown>;
  /** kg of CH4 emitted per reading; drives whether the site breaches. */
  perReadingKg: number;
  devices: string[];
  /**
   * Asserted after generation. The seed exists to produce a specific demo
   * picture — a spread of utilisations with exactly one breach — and rate
   * tuning drifting out from under that would quietly remove the thing a
   * reviewer is meant to see. Cheaper to fail the seed than to ship a
   * dashboard where nothing is ever red.
   */
  expectBreach: boolean;
};

const SEED_SITES: SeedSite[] = [
  {
    id: '0a5b1c2d-0000-4000-8000-000000000001',
    name: 'Fox Creek Well Pad 12',
    emissionLimitKg: '5000.000',
    metadata: {
      operator: 'Northridge Energy',
      basin: 'Duvernay',
      province: 'AB',
    },
    // 85% of limit — close enough to matter, so the utilisation bar earns its place.
    perReadingKg: 11.79,
    devices: ['FC12-METH-01', 'FC12-METH-02'],
    expectBreach: false,
  },
  {
    id: '0a5b1c2d-0000-4000-8000-000000000002',
    name: 'Peace River Compressor Station',
    emissionLimitKg: '12000.000',
    metadata: {
      operator: 'Northridge Energy',
      basin: 'Montney',
      province: 'AB',
    },
    // 45% of limit.
    perReadingKg: 10.01,
    devices: ['PRC-METH-01', 'PRC-METH-02', 'PRC-SAT-01'],
    expectBreach: false,
  },
  {
    // Seeded over its limit on purpose — this is the "Limit Exceeded" case a
    // reviewer should see immediately on opening the dashboard.
    id: '0a5b1c2d-0000-4000-8000-000000000003',
    name: 'Cardium Battery 7',
    emissionLimitKg: '2000.000',
    metadata: {
      operator: 'Slate Resources',
      basin: 'Cardium',
      province: 'AB',
      note: 'flare efficiency degraded',
    },
    // 130% of limit — the breach a reviewer should see on first load.
    perReadingKg: 14.45,
    devices: ['CB7-METH-01'],
    expectBreach: true,
  },
  {
    id: '0a5b1c2d-0000-4000-8000-000000000004',
    name: 'Grande Prairie Gathering Line 3',
    emissionLimitKg: '8000.000',
    metadata: { operator: 'Slate Resources', basin: 'Montney', province: 'AB' },
    // 15% of limit.
    perReadingKg: 3.33,
    devices: ['GP3-METH-01', 'GP3-METH-02'],
    expectBreach: false,
  },
];

/** Readings per device per month, spread across the seeded months. */
const READINGS_PER_DEVICE_PER_MONTH = 60;
const MONTHS_OF_HISTORY = 3;

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is required to seed');

  /**
   * `--if-empty` makes seeding a first-boot step rather than a startup step.
   *
   * Compose runs this on every `docker compose up`, including a plain restart of
   * an already-populated stack. Unconditional truncation there would delete
   * whatever a reviewer had ingested — the demo would reset itself underneath
   * someone part-way through exercising it, which looks like the ingest endpoint
   * losing data.
   *
   * A bare `pnpm db:seed` stays destructive: typing it is an explicit request to
   * rebuild the demo dataset, and a reset command that silently declines to
   * reset is its own trap.
   */
  const onlyIfEmpty = process.argv.includes('--if-empty');

  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool, { schema: { sites, measurements } });

  try {
    if (onlyIfEmpty) {
      const [existing] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(sites);

      if ((existing?.n ?? 0) > 0) {
        console.log(
          `[seed] ${existing.n} site(s) already present — leaving the data alone. ` +
            'Run `pnpm db:seed` to rebuild the demo dataset.',
        );
        return;
      }
    }

    await db.transaction(async (tx) => {
      // measurements and ingestion_batches cascade from sites
      await tx.execute(
        sql`TRUNCATE TABLE ${sites}, ${measurements} RESTART IDENTITY CASCADE`,
      );
      await tx.execute(sql`TRUNCATE TABLE outbox RESTART IDENTITY`);

      for (const site of SEED_SITES) {
        const rows = buildReadings(site);

        const totalKg = rows.reduce((acc, r) => acc + r.ch4, 0);

        await tx.insert(sites).values({
          id: site.id,
          name: site.name,
          emissionLimitKg: site.emissionLimitKg,
          metadata: site.metadata,
          totalEmissionsToDateKg: totalKg.toFixed(4),
          measurementCount: rows.length,
          firstReadingAt: rows.reduce(
            (a, r) => (r.ts < a ? r.ts : a),
            rows[0].ts,
          ),
          lastReadingAt: rows.reduce(
            (a, r) => (r.ts > a ? r.ts : a),
            rows[0].ts,
          ),
          version: rows.length,
        });

        /**
         * The batch records the readings claim to belong to.
         *
         * Written before the measurements that reference them, so seeded data is
         * shaped exactly like ingested data: every `measurements.batch_id`
         * resolves, and a reviewer can replay a seeded idempotency key and see
         * the replay path behave as it would for a real client.
         */
        const byBatch = new Map<string, typeof rows>();
        for (const r of rows) {
          const group = byBatch.get(r.batchId) ?? [];
          group.push(r);
          byBatch.set(r.batchId, group);
        }

        for (const [batchId, group] of byBatch) {
          const acceptedKg = group.reduce((acc, r) => acc + r.ch4, 0);

          await tx.insert(ingestionBatches).values({
            id: batchId,
            siteId: site.id,
            idempotencyKey: `seed-${batchId}`,
            requestHash: hashOf(site.id, group),
            status: 'completed',
            readingsSubmitted: group.length,
            readingsAccepted: group.length,
            acceptedCh4Kg: acceptedKg.toFixed(4),
            completedAt: new Date(),
          });
        }

        // Chunked to keep parameter counts well under the protocol limit.
        for (let i = 0; i < rows.length; i += 500) {
          await tx.insert(measurements).values(
            rows.slice(i, i + 500).map((r) => ({
              siteId: site.id,
              batchId: r.batchId,
              deviceId: r.deviceId,
              readingTs: r.ts,
              ch4Kg: r.ch4.toFixed(4),
              source: r.source,
            })),
          );
        }

        const limitKg = Number(site.emissionLimitKg);
        const breached = totalKg > limitKg;
        const utilisation = ((totalKg / limitKg) * 100).toFixed(0);

        console.log(
          `[seed] ${site.name.padEnd(34)} ${rows.length
            .toString()
            .padStart(4)} readings  ${totalKg.toFixed(1).padStart(9)} kg  ` +
            `${utilisation.padStart(4)}% of limit  ${
              breached ? 'LIMIT EXCEEDED' : 'within limit'
            }`,
        );

        if (breached !== site.expectBreach) {
          throw new Error(
            `seed drift: "${site.name}" is at ${utilisation}% of its limit ` +
              `(${totalKg.toFixed(1)} / ${limitKg} kg) but expectBreach=${site.expectBreach}. ` +
              `Adjust perReadingKg or emissionLimitKg — the demo relies on this mix.`,
          );
        }
      }
    });

    console.log('[seed] done');
  } finally {
    await pool.end();
  }
}

/** Stands in for the request fingerprint a real ingest would have stored. */
function hashOf(
  siteId: string,
  group: { deviceId: string; ts: Date; ch4: number }[],
): string {
  const canonical = JSON.stringify({
    siteId,
    readings: group
      .map((r) => ({ d: r.deviceId, t: r.ts.getTime(), c: r.ch4 }))
      .sort((a, b) => a.d.localeCompare(b.d) || a.t - b.t),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function buildReadings(site: SeedSite) {
  const rows: {
    deviceId: string;
    ts: Date;
    ch4: number;
    source: string;
    batchId: string;
  }[] = [];

  const now = new Date();

  /**
   * A fixed count per device, counted back from now — not "whatever falls inside
   * the last three calendar months".
   *
   * Anchoring to month boundaries makes the volume a function of today's date:
   * the current month fills as it progresses, so every site's total, and its
   * percentage of limit, climbs through the month and resets on the 1st. That
   * makes the seeded picture — and the percentages this README quotes — depend
   * on when someone happens to run it, and it puts `expectBreach` on a collision
   * course with the calendar.
   */
  const READINGS_PER_DEVICE = READINGS_PER_DEVICE_PER_MONTH * MONTHS_OF_HISTORY;

  for (const deviceId of site.devices) {
    const batchId = crypto.randomUUID();

    for (let i = 0; i < READINGS_PER_DEVICE; i++) {
      // Every 12 hours going back, so the series spans ~90 days and lands across
      // three or four monthly partitions.
      const ts = new Date(now.getTime() - i * 12 * 60 * 60 * 1000);

      // Deterministic wobble so the data looks like instrument readings
      // rather than a constant, without pulling in a PRNG dependency.
      const wobble = 1 + Math.sin(i * 1.7 + deviceId.length) * 0.25;

      rows.push({
        deviceId,
        ts,
        ch4: Number((site.perReadingKg * wobble).toFixed(4)),
        source: deviceId.includes('SAT') ? 'satellite' : 'sensor',
        batchId,
      });
    }
  }

  return rows;
}

main().catch((err: unknown) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
