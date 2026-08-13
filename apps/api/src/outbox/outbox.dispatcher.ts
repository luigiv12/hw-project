import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, isNull, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { outbox } from '../db/schema';
import { MetricsService } from '../observability/metrics.service';
import { AlertingClient, type OutboxEvent } from './alerting.client';

/** Rows claimed per pass. Bounded so one pass cannot hold locks unboundedly. */
export const BATCH_SIZE = 50;

/** Attempts before a row is set aside for manual attention rather than retried forever. */
export const MAX_ATTEMPTS = 10;

/**
 * How long a claim holds a row before another dispatcher may take it.
 *
 * Two jobs. It bounds how long a row is stranded when a dispatcher dies
 * mid-delivery, and — because a failed delivery leaves the stamp in place — it
 * is also the retry backoff. At 30s a downstream blip shorter than the lease
 * costs one attempt rather than exhausting all ten in ten seconds of polling.
 *
 * Must exceed the worst-case delivery time. A lease that expires while delivery
 * is still in flight lets a second dispatcher take the row and deliver it again.
 */
const LEASE_MS = 30_000;

/**
 * Transactional outbox dispatcher (bonus #4).
 *
 * Ingest writes the event in the same transaction as the measurements, so an
 * event exists if and only if the data does. This dispatcher's only job is to
 * get those events out — which decouples "the alerting service was notified"
 * from "the ingest request succeeded". A downstream outage delays alerts; it
 * cannot fail an ingest or lose an event.
 */
@Injectable()
export class OutboxDispatcher
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private readonly pollMs: number;

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly alerting: AlertingClient,
    private readonly metrics: MetricsService,
    config: ConfigService,
  ) {
    this.pollMs = config.get<number>('OUTBOX_POLL_MS') ?? 1000;
  }

  onApplicationBootstrap(): void {
    this.scheduleNext();
    this.logger.log(`outbox dispatcher started (poll ${this.pollMs}ms)`);
  }

  onApplicationShutdown(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Self-rescheduling rather than setInterval.
   *
   * setInterval fires on a fixed cadence regardless of whether the previous pass
   * finished, so a slow downstream would stack overlapping passes and multiply
   * load exactly when the system is already struggling. Scheduling the next pass
   * only after the current one completes makes overlap impossible.
   */
  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch((err: unknown) => this.logger.error('outbox pass failed', err))
        .finally(() => this.scheduleNext());
    }, this.pollMs);
  }

  /** Exposed for tests, which drive a pass directly rather than waiting on the timer. */
  async runOnce(): Promise<number> {
    const claimed = await this.claim();

    for (const event of claimed) {
      try {
        await this.alerting.deliver(event);
        await this.db
          .update(outbox)
          .set({ publishedAt: new Date() })
          .where(eq(outbox.id, event.id));

        this.metrics.recordOutboxPublished(event.eventType);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        /**
         * The row stays unpublished and keeps its claim stamp, so it becomes
         * eligible again once the lease lapses — which makes the lease the retry
         * backoff. Attempts are recorded so a permanently failing event is set
         * aside at MAX_ATTEMPTS rather than retried forever.
         */
        const [row] = await this.db
          .update(outbox)
          .set({
            attempts: sql`${outbox.attempts} + 1`,
            lastError: message.slice(0, 500),
          })
          .where(eq(outbox.id, event.id))
          .returning({ attempts: outbox.attempts });

        this.metrics.recordOutboxFailed(event.eventType);

        if (row && row.attempts >= MAX_ATTEMPTS) {
          this.logger.error(
            `outbox#${event.id} (${event.eventType}) has failed ${row.attempts} times and will no longer be retried automatically; ` +
              `it is excluded from future claims so the queue behind it keeps moving. ` +
              `Re-queue it by resetting attempts to 0 once the cause is fixed. Last error: ${message}`,
          );
        } else {
          this.logger.warn(
            `outbox#${event.id} delivery failed, will retry: ${message}`,
          );
        }
      }
    }

    await this.refreshPendingGauge();
    return claimed.length;
  }

  /**
   * Claims a batch of undelivered events by stamping them, in one statement.
   *
   * `FOR UPDATE SKIP LOCKED` selects the rows and excludes any another
   * dispatcher is taking at this instant. That lock lasts only as long as this
   * statement's transaction, and delivery happens over the network afterwards —
   * so the lock alone cannot keep a second dispatcher away for the part that
   * matters. The `UPDATE ... SET claimed_at` wrapped around it is what does:
   * the claim survives the transaction as data, and the predicate below skips
   * rows whose lease is still live.
   *
   * Excluded from selection:
   *
   *   published_at IS NULL   not already delivered
   *   attempts < MAX         not dead-lettered — a permanently failing row must
   *                          not keep occupying a slot in every pass, or the
   *                          queue behind it stops moving
   *   lease lapsed           not currently held by a live dispatcher
   *
   * Ordered by id so events for a given aggregate are delivered in the order
   * they were produced.
   */
  private async claim(): Promise<OutboxEvent[]> {
    const leaseCutoff = new Date(Date.now() - LEASE_MS);

    const { rows } = await this.db.execute<{
      id: string | number;
      event_type: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: Record<string, unknown>;
    }>(sql`
      update ${outbox} set claimed_at = now()
      where id in (
        select id from ${outbox}
        where published_at is null
          and attempts < ${MAX_ATTEMPTS}
          and (claimed_at is null or claimed_at < ${leaseCutoff})
        order by id
        limit ${BATCH_SIZE}
        for update skip locked
      )
      returning id, event_type, aggregate_type, aggregate_id, payload
    `);

    return rows.map((r) => ({
      id: Number(r.id),
      eventType: r.event_type,
      aggregateType: r.aggregate_type,
      aggregateId: r.aggregate_id,
      payload: r.payload,
    }));
  }

  /**
   * Pending and dead-lettered are counted separately.
   *
   * Dead-lettered rows are unpublished and never drain, so folding them into
   * one gauge would show a backlog that no amount of healthy throughput clears —
   * the alert that matters ("events are not moving") would be indistinguishable
   * from history that has already been triaged.
   */
  private async refreshPendingGauge(): Promise<void> {
    const [row] = await this.db
      .select({
        pending: sql<number>`count(*) filter (where ${outbox.attempts} < ${MAX_ATTEMPTS})::int`,
        deadLettered: sql<number>`count(*) filter (where ${outbox.attempts} >= ${MAX_ATTEMPTS})::int`,
      })
      .from(outbox)
      .where(isNull(outbox.publishedAt));

    this.metrics.setOutboxPending(row?.pending ?? 0);
    this.metrics.setOutboxDeadLettered(row?.deadLettered ?? 0);
  }
}
