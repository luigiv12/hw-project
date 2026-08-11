import { randomUUID } from 'node:crypto';
import {
  ComplianceStatus,
  DEFAULT_PAGE_SIZE,
  ErrorCode,
  MAX_BATCH_SIZE,
  MAX_PAGE_SIZE,
} from '@emissions/contracts';
import { eq, sql } from 'drizzle-orm';
import { measurements } from '../src/db/schema';
import { Harness, reading } from './harness';

describe('platform contract', () => {
  const h = new Harness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  describe('response envelope', () => {
    it('wraps successes as { data, meta }', async () => {
      const res = await h.http.get('/sites').expect(200);

      expect(res.body).toHaveProperty('data');
      expect(res.body.meta).toMatchObject({
        requestId: expect.any(String),
        timestamp: expect.any(String),
      });
      expect(res.body).not.toHaveProperty('error');
    });

    it('wraps failures as { error, meta } with a machine-readable code', async () => {
      const res = await h.http
        .get(`/sites/${randomUUID()}/metrics`)
        .expect(404);

      expect(res.body.error).toMatchObject({
        code: ErrorCode.SITE_NOT_FOUND,
        message: expect.any(String),
        details: [],
      });
      expect(res.body).not.toHaveProperty('data');
    });

    it('reports validation failures per field', async () => {
      const res = await h.http
        .post('/v2/sites')
        .send({ emissionLimitKg: '-5' })
        .expect(400);

      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      const paths = res.body.error.details.map((d: { path: string }) => d.path);
      expect(paths).toEqual(expect.arrayContaining(['name', 'emissionLimitKg']));
    });

    it('propagates an inbound request id for log correlation', async () => {
      const res = await h.http
        .get('/sites')
        .set('X-Request-Id', 'trace-me-123')
        .expect(200);

      expect(res.body.meta.requestId).toBe('trace-me-123');
      expect(res.headers['x-request-id']).toBe('trace-me-123');
    });

    it('does not leak internals on an unhandled failure', async () => {
      // A malformed uuid is rejected by the param pipe, not by our own code —
      // framework errors must still arrive in the platform envelope.
      const res = await h.http.get('/sites/not-a-uuid/metrics');

      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body).toHaveProperty('error.code');
      expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts:\d+|postgresql:\/\//);
    });
  });

  describe('compliance status', () => {
    it('reports a site exactly at its limit as within it', async () => {
      const site = await h.createSite('100.000');
      await h.ingest(site.id, [reading({ ch4Kg: '100.0000' })]);

      /**
       * The boundary case. "Limit Exceeded" requires strictly greater — a
       * site at exactly its permitted total has not breached. Comparison is
       * exact decimal, not float, because this is the value a regulator sees.
       */
      const res = await h.http.get(`/sites/${site.id}/metrics`).expect(200);
      expect(res.body.data.complianceStatus).toBe(ComplianceStatus.WITHIN_LIMIT);
      expect(res.body.data.utilizationPct).toBe(100);
    });

    it('reports a site one ten-thousandth over as exceeded', async () => {
      const site = await h.createSite('100.000');
      await h.ingest(site.id, [reading({ ch4Kg: '100.0001' })]);

      const res = await h.http.get(`/sites/${site.id}/metrics`).expect(200);
      expect(res.body.data.complianceStatus).toBe(ComplianceStatus.LIMIT_EXCEEDED);
    });

    it('names the site id consistently with the sites endpoint', async () => {
      const site = await h.createSite('50.000');
      const res = await h.http.get(`/sites/${site.id}/metrics`).expect(200);

      // `id`, not `siteId` — the same field name GET /sites returns for the same
      // entity.
      expect(res.body.data).toHaveProperty('id', site.id);
      expect([
        ComplianceStatus.WITHIN_LIMIT,
        ComplianceStatus.LIMIT_EXCEEDED,
      ]).toContain(res.body.data.complianceStatus);
    });
  });

  describe('batch limits', () => {
    it(`accepts a full batch of ${MAX_BATCH_SIZE}`, async () => {
      const site = await h.createSite();
      const readings = Array.from({ length: MAX_BATCH_SIZE }, (_, i) =>
        reading({
          deviceId: 'FULL',
          readingTs: new Date(Date.UTC(2026, 6, 1, 0, i)).toISOString(),
          ch4Kg: '1.0000',
        }),
      );

      const res = await h.ingest(site.id, readings);
      expect(res.status).toBe(200);
      await h.expectReconciled(site.id, '100', MAX_BATCH_SIZE);
    });

    it(`rejects ${MAX_BATCH_SIZE + 1}`, async () => {
      const site = await h.createSite();
      const readings = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) =>
        reading({
          deviceId: 'OVER',
          readingTs: new Date(Date.UTC(2026, 6, 2, 0, i)).toISOString(),
        }),
      );

      const res = await h.ingest(site.id, readings);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);

      // Rejected wholesale — no partial application.
      await h.expectReconciled(site.id, '0', 0);
    });

    it('rejects an empty batch', async () => {
      const site = await h.createSite();
      const res = await h.ingest(site.id, []);
      expect(res.status).toBe(400);
    });
  });

  describe('api root', () => {
    it('describes the API surface', async () => {
      const res = await h.http.get('/').expect(200);

      expect(res.body.data).toMatchObject({
        name: expect.any(String),
        versions: { current: 'v2', supported: ['v1', 'v2'] },
      });
      expect(Object.keys(res.body.data.endpoints).length).toBeGreaterThan(0);
    });

    it('carries a request id, like every other route', async () => {
      const res = await h.http.get('/').set('X-Request-Id', 'root-trace').expect(200);

      expect(res.body.meta.requestId).toBe('root-trace');
      expect(res.headers['x-request-id']).toBe('root-trace');
    });
  });

  describe('unmatched routes', () => {
    it('reports NOT_FOUND, not SITE_NOT_FOUND', async () => {
      const res = await h.http.get('/no-such-route').expect(404);

      // A missing route is not a missing site; the codes address different
      // problems and a client should be able to tell them apart.
      expect(res.body.error.code).toBe(ErrorCode.NOT_FOUND);
    });

    it('still carries a request id', async () => {
      const res = await h.http.get('/no-such-route').expect(404);
      expect(res.body.meta.requestId).not.toBe('unknown');
    });
  });

  describe('pagination', () => {
    /** Enough to page through several times at a small limit. */
    async function seedSites(n: number): Promise<string[]> {
      const created: string[] = [];
      for (let i = 0; i < n; i++) created.push((await h.createSite()).id);
      return created;
    }

    it('returns page details in meta, and items in data', async () => {
      const res = await h.http.get('/sites?limit=2').expect(200);

      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeLessThanOrEqual(2);
      expect(res.body.meta.page).toMatchObject({ limit: 2 });
      expect(res.body.meta.page).toHaveProperty('nextCursor');
    });

    it('walks every row exactly once across pages', async () => {
      await seedSites(7);

      const seen: string[] = [];
      let cursor: string | null = null;

      for (let guard = 0; guard < 50; guard++) {
        const url: string = cursor
          ? `/sites?limit=3&cursor=${encodeURIComponent(cursor)}`
          : '/sites?limit=3';

        const res = await h.http.get(url).expect(200);
        seen.push(...res.body.data.map((s: { id: string }) => s.id));

        cursor = res.body.meta.page.nextCursor;
        if (!cursor) break;
      }

      // No repeats and no gaps: a full walk must equal a single large page.
      const all = await h.http.get(`/sites?limit=${MAX_PAGE_SIZE}`).expect(200);
      const expected = all.body.data.map((s: { id: string }) => s.id);

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(expected);
    });

    it('reports no next cursor on the final page', async () => {
      const res = await h.http.get(`/sites?limit=${MAX_PAGE_SIZE}`).expect(200);
      expect(res.body.meta.page.nextCursor).toBeNull();
    });

    it('does not skip rows when one is inserted mid-walk', async () => {
      await seedSites(4);

      const first = await h.http.get('/sites?limit=2').expect(200);
      const firstIds = first.body.data.map((s: { id: string }) => s.id);

      // A cursor addresses a position in the sort order, not an offset, so rows
      // arriving between pages cannot shift the ones already returned.
      await h.createSite();

      const second = await h.http
        .get(`/sites?limit=2&cursor=${encodeURIComponent(first.body.meta.page.nextCursor)}`)
        .expect(200);

      const secondIds = second.body.data.map((s: { id: string }) => s.id);
      expect(secondIds.some((id: string) => firstIds.includes(id))).toBe(false);
    });

    it('applies a default limit when none is given', async () => {
      const res = await h.http.get('/sites').expect(200);
      expect(res.body.meta.page.limit).toBe(DEFAULT_PAGE_SIZE);
    });

    it('refuses a limit above the maximum', async () => {
      const res = await h.http.get(`/sites?limit=${MAX_PAGE_SIZE + 1}`).expect(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('refuses a non-numeric or non-positive limit', async () => {
      expect((await h.http.get('/sites?limit=abc')).status).toBe(400);
      expect((await h.http.get('/sites?limit=0')).status).toBe(400);
      expect((await h.http.get('/sites?limit=-1')).status).toBe(400);
    });

    it('rejects a malformed cursor rather than silently starting over', async () => {
      const res = await h.http.get('/sites?cursor=not-a-real-cursor').expect(400);

      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(res.body.error.details[0].path).toBe('cursor');
    });

    it.each([
      ['id is not a uuid', ['Some Site', 'not-a-uuid']],
      ['wrong arity', ['only-one']],
      ['wrong types', [1, 2]],
      ['not an array', { name: 'x', id: 'y' }],
    ])('rejects a decodable cursor with %s as bad input, not a server error', async (_label, payload) => {
      const cursor = Buffer.from(JSON.stringify(payload), 'utf8').toString(
        'base64url',
      );

      const res = await h.http.get(`/sites?cursor=${cursor}`);

      // A cursor is client-supplied. Anything that reaches the database from it
      // must be validated first, or bad input surfaces as a 500.
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  describe('reading window', () => {
    it('is null for a site with no readings', async () => {
      const site = await h.createSite();
      const res = await h.http.get(`/sites/${site.id}/metrics`).expect(200);

      expect(res.body.data.firstReadingAt).toBeNull();
      expect(res.body.data.lastReadingAt).toBeNull();
    });

    it('reports the span of the readings held', async () => {
      const site = await h.createSite();

      await h.ingest(site.id, [
        reading({ deviceId: 'W1', readingTs: '2026-06-01T00:00:00.000Z' }),
        reading({ deviceId: 'W1', readingTs: '2026-06-15T00:00:00.000Z' }),
      ]);

      const res = await h.http.get(`/sites/${site.id}/metrics`).expect(200);
      expect(res.body.data.firstReadingAt).toBe('2026-06-01T00:00:00.000Z');
      expect(res.body.data.lastReadingAt).toBe('2026-06-15T00:00:00.000Z');
    });

    it('widens backwards when older readings arrive later', async () => {
      const site = await h.createSite();

      await h.ingest(site.id, [
        reading({ deviceId: 'W2', readingTs: '2026-06-10T00:00:00.000Z' }),
      ]);
      // A backfill must move the start of the span, not be ignored for being
      // older than what is already recorded.
      await h.ingest(site.id, [
        reading({ deviceId: 'W2', readingTs: '2026-05-01T00:00:00.000Z' }),
      ]);

      const res = await h.http.get(`/sites/${site.id}/metrics`).expect(200);
      expect(res.body.data.firstReadingAt).toBe('2026-05-01T00:00:00.000Z');
      expect(res.body.data.lastReadingAt).toBe('2026-06-10T00:00:00.000Z');
    });

    it('does not move when a batch is de-duplicated', async () => {
      const site = await h.createSite();
      const batch = [
        reading({ deviceId: 'W3', readingTs: '2026-06-05T00:00:00.000Z' }),
      ];

      await h.ingest(site.id, batch);
      const before = (await h.http.get(`/sites/${site.id}/metrics`)).body.data;

      // Nothing was stored, so the span it summarises has not changed.
      await h.ingest(site.id, batch);
      const after = (await h.http.get(`/sites/${site.id}/metrics`)).body.data;

      expect(after.firstReadingAt).toBe(before.firstReadingAt);
      expect(after.lastReadingAt).toBe(before.lastReadingAt);
    });

    it('matches what the measurements actually say', async () => {
      const site = await h.createSite();

      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          h.ingest(site.id, [
            reading({
              deviceId: `W4-${i}`,
              readingTs: new Date(Date.UTC(2026, 5, i + 1)).toISOString(),
            }),
          ]),
        ),
      );

      const res = await h.http.get(`/sites/${site.id}/metrics`).expect(200);

      const [actual] = await h.db
        .select({
          first: sql<Date>`min(${measurements.readingTs})`,
          last: sql<Date>`max(${measurements.readingTs})`,
        })
        .from(measurements)
        .where(eq(measurements.siteId, site.id));

      // The denormalised value and the rows it summarises, after concurrent
      // writes.
      expect(res.body.data.firstReadingAt).toBe(
        new Date(actual.first).toISOString(),
      );
      expect(res.body.data.lastReadingAt).toBe(
        new Date(actual.last).toISOString(),
      );
    });
  });

  describe('site listing order', () => {
    it('is stable across repeated reads', async () => {
      const reads = await Promise.all(
        Array.from({ length: 5 }, () => h.http.get('/sites').expect(200)),
      );

      const orders = reads.map((r) =>
        r.body.data.map((s: { id: string }) => s.id).join(','),
      );

      expect(new Set(orders).size).toBe(1);
    });

    it('does not reorder when a site is updated', async () => {
      // Ingest rewrites the site row. Listing order must be a property of the
      // query, not of when a row was last written.
      const before = (await h.http.get('/sites').expect(200)).body.data.map(
        (s: { id: string }) => s.id,
      );

      const site = await h.createSite();
      await h.ingest(site.id, [reading({ deviceId: 'ORDER-STABILITY' })]);

      const after = (await h.http.get('/sites').expect(200)).body.data
        .map((s: { id: string }) => s.id)
        .filter((id: string) => id !== site.id);

      expect(after).toEqual(before);
    });
  });

  describe('unknown site', () => {
    it('rejects ingest for a site that does not exist', async () => {
      const res = await h.ingest(randomUUID(), [reading()]);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe(ErrorCode.SITE_NOT_FOUND);
    });
  });
});
