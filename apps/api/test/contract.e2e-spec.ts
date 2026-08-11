import { randomUUID } from 'node:crypto';
import { ComplianceStatus, ErrorCode, MAX_BATCH_SIZE } from '@emissions/contracts';
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
       * The boundary case. The brief's wording is "Limit Exceeded", which
       * requires strictly greater — a site at exactly its permitted total has
       * not breached. Comparison is exact decimal, not float, because this is
       * the value a regulator sees.
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

    it('uses the exact field names and strings the brief specifies', async () => {
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
