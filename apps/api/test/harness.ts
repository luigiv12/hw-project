import { Test } from '@nestjs/testing';
import { VersioningType, type INestApplication } from '@nestjs/common';
import { eq, inArray, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { IngestResult, Site } from '@emissions/contracts';
import { AppModule } from '../src/app.module';
import { DB, type Database } from '../src/db/db.module';
import { measurements, sites } from '../src/db/schema';

/**
 * Shared harness for the integration tests.
 *
 * Tests run against the real Postgres from docker-compose rather than a mock.
 * Everything under test here — ON CONFLICT semantics, SELECT FOR UPDATE, exact
 * numeric arithmetic, partition routing — is behaviour of the database. A mock
 * would assert that the code calls the functions the code calls, which is
 * precisely the thing that cannot fail interestingly.
 */
export class Harness {
  app!: INestApplication;
  db!: Database;

  /** Sites created by this run, removed in stop(). */
  private readonly created: string[] = [];

  async start(): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    this.app = moduleRef.createNestApplication();
    // Mirror main.ts: versioned routes must resolve identically under test.
    this.app.enableVersioning({ type: VersioningType.URI });
    await this.app.init();

    this.db = this.app.get<Database>(DB);
  }

  /**
   * Removes everything this run created, then shuts down.
   *
   * Tests share the development database, so without this a `pnpm test` would
   * leave the dashboard full of `test-site-*` rows — the seeded demo would stop
   * being the demo. Measurements, batches and outbox rows cascade from the site.
   *
   * Runs even if assertions failed, so a red test does not also poison the data.
   */
  async stop(): Promise<void> {
    try {
      if (this.created.length > 0) {
        await this.db.delete(sites).where(inArray(sites.id, this.created));
      }
    } finally {
      await this.app?.close();
    }
  }

  get http() {
    return request(this.app.getHttpServer());
  }

  /**
   * Creates an isolated site for one test.
   *
   * Every test owns its own site rather than sharing seeded data, so absolute
   * assertions ("the total is exactly 200") stay valid no matter what else has
   * run, and a failing test cannot poison its neighbours.
   */
  async createSite(emissionLimitKg = '1000000.000'): Promise<Site> {
    const res = await this.http
      .post('/v2/sites')
      .send({
        name: `test-site-${randomUUID().slice(0, 8)}`,
        emissionLimitKg,
        metadata: { createdBy: 'integration-test' },
      })
      .expect(201);

    const site = res.body.data as Site;
    this.created.push(site.id);
    return site;
  }

  /** POST /v2/ingest, returning the parsed body and the replay header. */
  async ingest(
    siteId: string,
    readings: Reading[],
    idempotencyKey: string = randomUUID(),
  ): Promise<{ status: number; body: any; replayed: boolean }> {
    const res = await this.http
      .post('/v2/ingest')
      .set('Idempotency-Key', idempotencyKey)
      .send({ siteId, readings });

    return {
      status: res.status,
      body: res.body,
      replayed: res.headers['x-idempotent-replay'] === 'true',
    };
  }

  /** The denormalised summary, straight from the site row. */
  async storedTotal(siteId: string): Promise<{ kg: string; count: number }> {
    const [row] = await this.db.select().from(sites).where(eq(sites.id, siteId));
    return { kg: row.totalEmissionsToDateKg, count: row.measurementCount };
  }

  /**
   * The summary recomputed from the measurement rows.
   *
   * The whole integrity claim of this system is that this and `storedTotal`
   * never disagree. Tests assert both, because a bug that corrupts them together
   * — double-inserting rows *and* double-counting the summary — would be
   * invisible to a check of either one alone.
   */
  async computedTotal(siteId: string): Promise<{ kg: string; count: number }> {
    const [row] = await this.db
      .select({
        kg: sql<string>`coalesce(sum(${measurements.ch4Kg}), 0)::text`,
        count: sql<number>`count(*)::int`,
      })
      .from(measurements)
      .where(eq(measurements.siteId, siteId));

    return { kg: row?.kg ?? '0', count: row?.count ?? 0 };
  }

  /** Asserts the summary and the raw rows agree, and match what was expected. */
  async expectReconciled(siteId: string, expectedKg: string, expectedCount: number) {
    const stored = await this.storedTotal(siteId);
    const computed = await this.computedTotal(siteId);

    expect(decimal(stored.kg)).toBe(decimal(expectedKg));
    expect(decimal(computed.kg)).toBe(decimal(expectedKg));
    expect(stored.count).toBe(expectedCount);
    expect(computed.count).toBe(expectedCount);
  }
}

export type Reading = {
  readingId?: string;
  deviceId: string;
  readingTs: string;
  ch4Kg: string;
  source?: 'sensor' | 'satellite' | 'manual';
};

/** Numeric columns render trailing zeros ("200.0000"); compare by value. */
export function decimal(v: string): string {
  return String(Number(v));
}

export function reading(over: Partial<Reading> = {}): Reading {
  return {
    deviceId: 'TEST-DEVICE-01',
    readingTs: '2026-08-09T12:00:00.000Z',
    ch4Kg: '10.0000',
    source: 'sensor',
    ...over,
  };
}

export const result = (body: any): IngestResult => body.data as IngestResult;
