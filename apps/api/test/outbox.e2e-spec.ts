import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Harness, reading } from './harness';
import { outbox } from '../src/db/schema';
import { OutboxDispatcher } from '../src/outbox/outbox.dispatcher';

describe('transactional outbox', () => {
  const h = new Harness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  const eventsFor = (siteId: string) =>
    h.db.select().from(outbox).where(eq(outbox.aggregateId, siteId));

  it('writes the event in the same transaction as the measurements', async () => {
    const site = await h.createSite();
    await h.ingest(site.id, [reading({ ch4Kg: '15.0000' })]);

    const events = await eventsFor(site.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'measurements.ingested',
      aggregateType: 'site',
      publishedAt: null,
    });

    /**
     * The event carries the committed figures, not the submitted ones. A
     * consumer must be able to trust it without re-reading the database.
     */
    expect(events[0].payload).toMatchObject({
      siteId: site.id,
      readingsAccepted: 1,
      acceptedCh4Kg: '15.0000',
    });
  });

  it('emits no event when nothing was ingested', async () => {
    const site = await h.createSite();
    const key = randomUUID();
    const batch = [reading({ ch4Kg: '1.0000' })];

    await h.ingest(site.id, batch, key);
    await h.ingest(site.id, batch, key); // replayed

    // A replay performs no work, so it must not produce a second notification —
    // otherwise a retrying client would alert the downstream repeatedly.
    expect(await eventsFor(site.id)).toHaveLength(1);
  });

  it('emits limit_exceeded once, on the crossing, not on every later batch', async () => {
    const site = await h.createSite('10.000');

    await h.ingest(site.id, [
      reading({ deviceId: 'LIM', readingTs: '2026-08-09T01:00:00.000Z', ch4Kg: '6.0000' }),
    ]);
    expect(
      (await eventsFor(site.id)).filter((e) => e.eventType === 'site.limit_exceeded'),
    ).toHaveLength(0);

    // Crosses the limit.
    await h.ingest(site.id, [
      reading({ deviceId: 'LIM', readingTs: '2026-08-09T02:00:00.000Z', ch4Kg: '6.0000' }),
    ]);

    // Already over; must not alert again.
    await h.ingest(site.id, [
      reading({ deviceId: 'LIM', readingTs: '2026-08-09T03:00:00.000Z', ch4Kg: '6.0000' }),
    ]);

    const breaches = (await eventsFor(site.id)).filter(
      (e) => e.eventType === 'site.limit_exceeded',
    );

    // An alerting service should learn that a site crossed its limit once, not
    // once per batch forever after.
    expect(breaches).toHaveLength(1);
    expect(breaches[0].payload).toMatchObject({
      siteId: site.id,
      emissionLimitKg: '10.000',
    });
  });

  it('delivers pending events and marks them published', async () => {
    const site = await h.createSite();
    await h.ingest(site.id, [reading({ ch4Kg: '3.0000' })]);

    const before = await h.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.aggregateId, site.id), isNull(outbox.publishedAt)));
    expect(before.length).toBeGreaterThan(0);

    // Driven explicitly rather than by the timer, so the assertion is not racing
    // a background poll.
    const dispatcher = h.app.get(OutboxDispatcher);
    await dispatcher.runOnce();

    const after = await h.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.aggregateId, site.id), isNull(outbox.publishedAt)));
    expect(after).toHaveLength(0);
  });

  it('does not redeliver an already published event', async () => {
    const site = await h.createSite();
    await h.ingest(site.id, [reading({ ch4Kg: '2.0000' })]);

    const dispatcher = h.app.get(OutboxDispatcher);
    await dispatcher.runOnce();

    const [event] = await eventsFor(site.id);
    const firstPublishedAt = event.publishedAt;
    expect(firstPublishedAt).not.toBeNull();

    await dispatcher.runOnce();

    const [again] = await eventsFor(site.id);
    // Delivery is at-least-once by design, but a second pass over an already
    // published row must be a no-op rather than a redelivery.
    expect(again.publishedAt).toEqual(firstPublishedAt);
    expect(again.attempts).toBe(0);
  });

  it('produces one event per accepted batch under concurrent load', async () => {
    const site = await h.createSite();

    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        h.ingest(site.id, [
          reading({
            deviceId: `OBX-${i}`,
            readingTs: '2026-08-09T04:00:00.000Z',
            ch4Kg: '1.0000',
          }),
        ]),
      ),
    );

    const ingested = (await eventsFor(site.id)).filter(
      (e) => e.eventType === 'measurements.ingested',
    );

    // Five batches did work, so five notifications — the outbox neither loses
    // nor duplicates events when writers contend.
    expect(ingested).toHaveLength(5);
    await h.expectReconciled(site.id, '5', 5);
  });
});
