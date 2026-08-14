import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { Harness, reading } from './harness';
import { outbox } from '../src/db/schema';
import { AlertingClient } from '../src/outbox/alerting.client';
import {
  BATCH_SIZE as OUTBOX_BATCH_SIZE,
  MAX_ATTEMPTS,
  OutboxDispatcher,
} from '../src/outbox/outbox.dispatcher';

describe('transactional outbox', () => {
  const h = new Harness();

  beforeAll(() => h.start());
  afterAll(() => h.stop());

  const eventsFor = (siteId: string) =>
    h.db.select().from(outbox).where(eq(outbox.aggregateId, siteId));

  /**
   * Runs the dispatcher until it has nothing left to claim.
   *
   * A single pass claims a bounded batch, so with a backlog larger than that
   * bound one pass does not reach a specific event. Tests that assert on a
   * particular event's delivery must drain rather than assume one pass suffices.
   * Capped so a permanently failing delivery cannot spin forever.
   */
  async function drain(dispatcher: OutboxDispatcher): Promise<void> {
    for (let pass = 0; pass < 50; pass++) {
      if ((await dispatcher.runOnce()) === 0) return;
    }
    throw new Error('outbox did not drain within 50 passes');
  }

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
      reading({
        deviceId: 'LIM',
        readingTs: '2026-08-09T01:00:00.000Z',
        ch4Kg: '6.0000',
      }),
    ]);
    expect(
      (await eventsFor(site.id)).filter(
        (e) => e.eventType === 'site.limit_exceeded',
      ),
    ).toHaveLength(0);

    // Crosses the limit.
    await h.ingest(site.id, [
      reading({
        deviceId: 'LIM',
        readingTs: '2026-08-09T02:00:00.000Z',
        ch4Kg: '6.0000',
      }),
    ]);

    // Already over; must not alert again.
    await h.ingest(site.id, [
      reading({
        deviceId: 'LIM',
        readingTs: '2026-08-09T03:00:00.000Z',
        ch4Kg: '6.0000',
      }),
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
    await drain(h.app.get(OutboxDispatcher));

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
    await drain(dispatcher);

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

  describe('claiming', () => {
    it('does not deliver the same event twice when two dispatchers overlap', async () => {
      const site = await h.createSite();
      await h.ingest(site.id, [reading({ ch4Kg: '4.0000' })]);

      const [event] = await eventsFor(site.id);
      const dispatcher = h.app.get(OutboxDispatcher);
      const alerting = h.app.get(AlertingClient);

      /**
       * Delivery must still be in flight when the second pass claims, because
       * that is the window the row lock does not cover — it is released when the
       * claiming statement commits, long before the network call returns.
       */
      const delivered: number[] = [];
      const spy = jest
        .spyOn(alerting, 'deliver')
        .mockImplementation(async (e) => {
          delivered.push(e.id);
          await new Promise((resolve) => setTimeout(resolve, 100));
        });

      try {
        await Promise.all([dispatcher.runOnce(), dispatcher.runOnce()]);
      } finally {
        spy.mockRestore();
      }

      expect(delivered.filter((id) => id === event.id)).toHaveLength(1);
    });

    it('stops claiming an event that has exhausted its attempts', async () => {
      const site = await h.createSite();

      const [poison] = await h.db
        .insert(outbox)
        .values({
          aggregateType: 'site',
          aggregateId: site.id,
          eventType: 'test.exhausted',
          payload: {},
          attempts: MAX_ATTEMPTS,
        })
        .returning({ id: outbox.id });

      const dispatcher = h.app.get(OutboxDispatcher);
      const alerting = h.app.get(AlertingClient);

      const delivered: number[] = [];
      const spy = jest
        .spyOn(alerting, 'deliver')
        .mockImplementation(async (e) => {
          delivered.push(e.id);
        });

      try {
        await drain(dispatcher);
      } finally {
        spy.mockRestore();
      }

      /**
       * Skipped rather than retried. A row that will never succeed must not keep
       * taking a slot in `order by id limit N`, or a handful of them stalls the
       * queue behind them permanently.
       */
      expect(delivered).not.toContain(poison.id);

      const [row] = await h.db
        .select()
        .from(outbox)
        .where(eq(outbox.id, poison.id));
      expect(row.publishedAt).toBeNull();
    });

    it('drains events queued behind a full batch of exhausted ones', async () => {
      const site = await h.createSite();
      const dispatcher = h.app.get(OutboxDispatcher);
      const alerting = h.app.get(AlertingClient);

      // Start from an empty queue so rows left by earlier tests do not decide
      // which rows a bounded claim reaches.
      await drain(dispatcher);

      /**
       * A full batch of them, not one.
       *
       * A claim takes `BATCH_SIZE` rows in id order, so a single failing row
       * still leaves 49 slots and blocks nothing. Head-of-line blocking needs
       * enough permanently-failing rows to fill the batch — then every pass
       * claims the same doomed set and nothing behind it is ever reached.
       *
       * End-to-end rather than isolating: the lease alone would carry this
       * assertion, since stamped rows are skipped for the lease window whatever
       * their attempt count. The dead-letter predicate is what holds once the
       * lease lapses, and the test above is the one that pins it.
       */
      await h.db.insert(outbox).values(
        Array.from({ length: OUTBOX_BATCH_SIZE }, () => ({
          aggregateType: 'site',
          aggregateId: site.id,
          eventType: 'test.exhausted',
          payload: {},
          attempts: MAX_ATTEMPTS,
        })),
      );

      // Queued after them, so it sits behind them in id order.
      await h.ingest(site.id, [reading({ ch4Kg: '7.0000' })]);

      const spy = jest
        .spyOn(alerting, 'deliver')
        .mockImplementation(async (e) => {
          if (e.eventType === 'test.exhausted') {
            throw new Error('downstream rejects this event permanently');
          }
        });

      try {
        await drain(dispatcher);
      } finally {
        spy.mockRestore();
      }

      const stuck = await h.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.aggregateId, site.id),
            eq(outbox.eventType, 'measurements.ingested'),
            isNull(outbox.publishedAt),
          ),
        );

      expect(stuck).toHaveLength(0);
    });
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
