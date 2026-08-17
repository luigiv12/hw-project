import { randomUUID } from 'node:crypto';
import { ErrorCode } from '@emissions/contracts';
import { Harness, reading, result } from './harness';

describe('API versioning', () => {
  const h = new Harness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  describe('the unversioned ingest path', () => {
    it("serves the current format, so the brief's URL works as written", async () => {
      const site = await h.createSite();
      const key = randomUUID();
      const batch = [reading({ deviceId: 'UNVERSIONED', ch4Kg: '5.0000' })];

      const res = await h.http
        .post('/ingest')
        .set('Idempotency-Key', key)
        .send({ siteId: site.id, readings: batch });

      expect(res.status).toBe(200);
      expect(res.body.data.readingsAccepted).toBe(1);
      await h.expectReconciled(site.id, '5', 1);
    });

    it('is the same route as /v2/ingest, not a parallel one', async () => {
      const site = await h.createSite();
      const key = randomUUID();
      const batch = [reading({ deviceId: 'SHARED', ch4Kg: '7.0000' })];

      await h.http
        .post('/ingest')
        .set('Idempotency-Key', key)
        .send({ siteId: site.id, readings: batch });

      /**
       * Idempotency is keyed on (site, key) and knows nothing about the URL, so
       * a retry that switches to the explicit path must still be recognised.
       * Two routes that each accepted the batch would double the total.
       */
      const retry = await h.http
        .post('/v2/ingest')
        .set('Idempotency-Key', key)
        .send({ siteId: site.id, readings: batch });

      expect(retry.headers['x-idempotent-replay']).toBe('true');
      await h.expectReconciled(site.id, '7', 1);
    });

    it('rejects a v1-shaped payload instead of misreading its units', async () => {
      const site = await h.createSite();

      /**
       * The field names of the two formats are disjoint, so a legacy payload
       * arriving here fails validation rather than having its grams counted as
       * kilograms.
       */
      const res = await h.http
        .post('/ingest')
        .set('Idempotency-Key', randomUUID())
        .send({
          site_id: site.id,
          batch_id: randomUUID(),
          readings: [{ device_id: 'L1', ts: 1755460000, ch4_g: 2000 }],
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
      await h.expectReconciled(site.id, '0', 0);
    });

    it('404s an unknown version', async () => {
      const res = await h.http.post('/v3/ingest').send({});
      expect(res.status).toBe(404);
    });
  });

  describe('sites and metrics answer on every version', () => {
    it.each(['/sites', '/v1/sites', '/v2/sites'])(
      'GET %s succeeds',
      async (path) => {
        const res = await h.http.get(path);
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.data)).toBe(true);
      },
    );

    it('404s an unknown version for sites too', async () => {
      expect((await h.http.get('/v3/sites')).status).toBe(404);
    });
  });

  describe('v1 legacy sensors', () => {
    it('converts grams to kilograms exactly and epoch seconds to an instant', async () => {
      const site = await h.createSite();

      const res = await h.http.post('/v1/ingest').send({
        site_id: site.id,
        batch_id: randomUUID(),
        readings: [
          { device_id: 'LEGACY-1', ts: 1786320000, ch4_g: 8200 },
          // 8.2 g. Naive float division gives 0.008199999999999999; the
          // conversion shifts the decimal as a string instead.
          { device_id: 'LEGACY-1', ts: 1786323600, ch4_g: 8.2 },
        ],
      });

      expect(res.status).toBe(200);
      expect(result(res.body).readingsAccepted).toBe(2);

      // 8.2 + 0.0082
      await h.expectReconciled(site.id, '8.2082', 2);
    });

    it('uses body batch_id as the idempotency key', async () => {
      const site = await h.createSite();
      const batchId = randomUUID();
      const body = {
        site_id: site.id,
        batch_id: batchId,
        readings: [{ device_id: 'LEGACY-2', ts: 1786330000, ch4_g: 5000 }],
      };

      await h.http.post('/v1/ingest').send(body).expect(200);
      const retry = await h.http.post('/v1/ingest').send(body).expect(200);

      // v1 firmware carries its de-duplication token in the body; the adapter is
      // the only place that knows this.
      expect(retry.headers['x-idempotent-replay']).toBe('true');
      await h.expectReconciled(site.id, '5', 1);
    });

    it('advertises its successor', async () => {
      const site = await h.createSite();

      const res = await h.http.post('/v1/ingest').send({
        site_id: site.id,
        batch_id: randomUUID(),
        readings: [{ device_id: 'LEGACY-3', ts: 1786340000, ch4_g: 1000 }],
      });

      expect(res.headers['deprecation']).toBe('true');
      expect(res.headers['link']).toContain('successor-version');
    });

    it('shares de-duplication state with v2 — the same reading counts once', async () => {
      const site = await h.createSite();

      // 5000 g == 5 kg, same device, same instant, arriving on both versions.
      await h.http
        .post('/v1/ingest')
        .send({
          site_id: site.id,
          batch_id: randomUUID(),
          readings: [{ device_id: 'X-VER', ts: 1786350000, ch4_g: 5000 }],
        })
        .expect(200);

      const viaV2 = await h.ingest(site.id, [
        {
          deviceId: 'X-VER',
          readingTs: new Date(1786350000 * 1000).toISOString(),
          ch4Kg: '5.0000',
          source: 'sensor',
        },
      ]);

      // Versioning is a transport concern; identity is not versioned.
      expect(result(viaV2.body).readingsAccepted).toBe(0);
      await h.expectReconciled(site.id, '5', 1);
    });
  });
});
