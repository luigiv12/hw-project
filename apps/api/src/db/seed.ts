import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { measurements, sites } from './schema';

/**
 * Seeds a demo dataset.
 *
 * Deliberately includes one site already over its limit, so "Limit Exceeded" is
 * visible on the dashboard and in GET /metrics without a reviewer having to
 * ingest anything first.
 *
 * Destructive: truncates and rebuilds. Intended for local development and the
 * one-time seeding of the demo deployment, not for a live dataset.
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
    metadata: { operator: 'Northridge Energy', basin: 'Duvernay', province: 'AB' },
    // ~85% of limit — close enough to matter, so the utilisation bar earns its place.
    perReadingKg: 15.18,
    devices: ['FC12-METH-01', 'FC12-METH-02'],
    expectBreach: false,
  },
  {
    id: '0a5b1c2d-0000-4000-8000-000000000002',
    name: 'Peace River Compressor Station',
    emissionLimitKg: '12000.000',
    metadata: { operator: 'Northridge Energy', basin: 'Montney', province: 'AB' },
    // ~45% of limit.
    perReadingKg: 12.86,
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
    // ~130% of limit — the breach a reviewer should see on first load.
    perReadingKg: 18.57,
    devices: ['CB7-METH-01'],
    expectBreach: true,
  },
  {
    id: '0a5b1c2d-0000-4000-8000-000000000004',
    name: 'Grande Prairie Gathering Line 3',
    emissionLimitKg: '8000.000',
    metadata: { operator: 'Slate Resources', basin: 'Montney', province: 'AB' },
    // ~15% of limit.
    perReadingKg: 4.29,
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

  const pool = new Pool({ connectionString, max: 1 });
  const db = drizzle(pool, { schema: { sites, measurements } });

  try {
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
          version: rows.length,
        });

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

function buildReadings(site: SeedSite) {
  const rows: {
    deviceId: string;
    ts: Date;
    ch4: number;
    source: string;
    batchId: string;
  }[] = [];

  const now = new Date();

  for (let monthsAgo = MONTHS_OF_HISTORY - 1; monthsAgo >= 0; monthsAgo--) {
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1),
    );

    for (const deviceId of site.devices) {
      const batchId = crypto.randomUUID();

      for (let i = 0; i < READINGS_PER_DEVICE_PER_MONTH; i++) {
        const ts = new Date(monthStart);
        ts.setUTCHours(ts.getUTCHours() + i * 12);

        // Skip anything that would land in the future — a reading with a
        // timestamp ahead of now would be nonsense in a compliance record.
        if (ts > now) continue;

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
  }

  return rows;
}

main().catch((err: unknown) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
