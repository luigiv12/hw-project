import { randomUUID } from 'node:crypto';
import { Harness, decimal, reading, result } from './harness';

/**
 * The evidence for this system's central claim.
 *
 * Everything else in this suite checks a rule in isolation; these two check that
 * the rules survive ten writers arriving at once. They are written to be read —
 * a reviewer should be able to see what is being fired and what must come out
 * without tracing helpers.
 */
describe('concurrency', () => {
  const h = new Harness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  it('applies a batch exactly once when 10 identical requests arrive simultaneously', async () => {
    const site = await h.createSite();
    const key = randomUUID();

    const batch = [
      reading({ deviceId: 'BURST-01', readingTs: '2026-08-09T10:00:00.000Z', ch4Kg: '100.0000' }),
      reading({ deviceId: 'BURST-01', readingTs: '2026-08-09T11:00:00.000Z', ch4Kg: '100.0000' }),
    ];

    // Fired together, not in sequence — the point is that they contend.
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => h.ingest(site.id, batch, key)),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);

    // Exactly one request did the work; the other nine replayed its response.
    const applied = responses.filter((r) => !result(r.body).idempotentReplay);
    const replayed = responses.filter((r) => result(r.body).idempotentReplay);
    expect(applied).toHaveLength(1);
    expect(replayed).toHaveLength(9);

    // Every replay is byte-identical to the original, not merely similar.
    const original = { ...result(applied[0].body), idempotentReplay: true };
    for (const r of replayed) {
      expect(result(r.body)).toEqual(original);
    }

    // 200 kg, once — not 2000.
    await h.expectReconciled(site.id, '200', 2);
  });

  it('loses no updates when 10 distinct batches hit one site simultaneously', async () => {
    const site = await h.createSite();

    /**
     * Distinct idempotency keys AND distinct readings, so neither de-duplication
     * layer can suppress anything — all ten must be applied. A short total means
     * a lost update; that is the failure this test exists to catch.
     */
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.ingest(
          site.id,
          [
            reading({
              deviceId: `RACE-${i}`,
              readingTs: '2026-08-09T09:00:00.000Z',
              ch4Kg: '10.0000',
            }),
          ],
          randomUUID(),
        ),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(responses.every((r) => result(r.body).readingsAccepted === 1)).toBe(true);

    await h.expectReconciled(site.id, '100', 10);
  });

  it('counts a reading once when the same batch arrives under two different keys concurrently', async () => {
    const site = await h.createSite();

    // Identical readings, different keys: layer 1 cannot help, so this is
    // entirely layer 2's job, under contention.
    const batch = [
      reading({ deviceId: 'OVERLAP-01', readingTs: '2026-08-09T08:00:00.000Z', ch4Kg: '25.0000' }),
    ];

    const [a, b] = await Promise.all([
      h.ingest(site.id, batch, randomUUID()),
      h.ingest(site.id, batch, randomUUID()),
    ]);

    // One stored it, the other found it already present. Neither replayed —
    // both keys were genuinely new.
    const accepted = [a, b].map((r) => result(r.body).readingsAccepted).sort();
    expect(accepted).toEqual([0, 1]);
    expect(result(a.body).idempotentReplay).toBe(false);
    expect(result(b.body).idempotentReplay).toBe(false);

    await h.expectReconciled(site.id, '25', 1);
  });

  /**
   * Headroom. Correctness under concurrency should hold well above the load the
   * earlier cases exercise, not merely at it.
   */
  it('stays exact with 50 concurrent distinct batches on one site', async () => {
    const site = await h.createSite();

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        h.ingest(
          site.id,
          Array.from({ length: 10 }, (_, k) =>
            reading({
              deviceId: `LOAD-${i}`,
              readingTs: new Date(Date.UTC(2026, 4, 1, 0, k)).toISOString(),
              ch4Kg: '1.0000',
            }),
          ),
          randomUUID(),
        ),
      ),
    );

    expect(responses.every((r) => r.status === 200)).toBe(true);
    await h.expectReconciled(site.id, '500', 500);
  });

  it('applies one batch when 50 identical requests arrive at once', async () => {
    const site = await h.createSite();
    const key = randomUUID();
    const batch = [reading({ deviceId: 'LOAD-SAME', ch4Kg: '100.0000' })];

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => h.ingest(site.id, batch, key)),
    );

    expect(responses.filter((r) => !result(r.body).idempotentReplay)).toHaveLength(1);
    await h.expectReconciled(site.id, '100', 1);
  });

  it('keeps the site summary in step with its measurements under mixed load', async () => {
    const site = await h.createSite();

    /**
     * A deliberately messy burst: new batches, exact retries, and overlapping
     * readings interleaved. The assertion is not a specific total but the
     * invariant — whatever lands, the summary and the rows agree.
     */
    const sharedKey = randomUUID();
    const shared = [
      reading({ deviceId: 'MIX-SHARED', readingTs: '2026-08-09T07:00:00.000Z', ch4Kg: '5.0000' }),
    ];

    await Promise.all([
      ...Array.from({ length: 4 }, () => h.ingest(site.id, shared, sharedKey)),
      ...Array.from({ length: 6 }, (_, i) =>
        h.ingest(site.id, [
          reading({
            deviceId: `MIX-${i}`,
            readingTs: '2026-08-09T07:30:00.000Z',
            ch4Kg: '3.0000',
          }),
        ]),
      ),
      ...Array.from({ length: 3 }, () =>
        h.ingest(site.id, shared, randomUUID()),
      ),
    ]);

    // 5 (shared, once) + 18 (six distinct at 3kg) = 23
    await h.expectReconciled(site.id, '23', 7);

    const stored = await h.storedTotal(site.id);
    const computed = await h.computedTotal(site.id);
    expect(decimal(stored.kg)).toBe(decimal(computed.kg));
  });
});
