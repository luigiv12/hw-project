import { randomUUID } from 'node:crypto';
import { Harness, result } from './harness';

describe('API versioning', () => {
  const h = new Harness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  describe('ingest requires an explicit version', () => {
    it('404s an unversioned ingest rather than guessing', async () => {
      const site = await h.createSite();

      /**
       * The two wire formats are not distinguishable by inspection and differ by
       * a factor of 1000 — v1 reports grams and epoch seconds, v2 kilograms and
       * ISO-8601. A misresolved version would not fail; it would succeed and
       * write a total three orders of magnitude wrong into a compliance record.
       * Refusing is the only safe answer.
       */
      const res = await h.http
        .post('/ingest')
        .set('Idempotency-Key', randomUUID())
        .send({ siteId: site.id, readings: [] });

      expect(res.status).toBe(404);
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

      const res = await h.http
        .post('/v1/ingest')
        .send({
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
