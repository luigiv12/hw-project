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
const BATCH_SIZE = 50;

/** Attempts before a row is left for manual attention rather than retried forever. */
const MAX_ATTEMPTS = 10;

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
         * The row stays unpublished, so the next pass retries it. Attempts are
         * recorded so a permanently failing event is visible rather than
         * silently spinning.
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
            `outbox#${event.id} (${event.eventType}) has failed ${row.attempts} times and needs attention: ${message}`,
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
   * Claims a batch of undelivered events.
   *
   * FOR UPDATE SKIP LOCKED is what makes this safe to run on every API instance
   * at once: each transaction locks the rows it takes and skips rows another
   * instance already holds, so N dispatchers share the work instead of
   * colliding on it or delivering the same event N times.
   *
   * Ordered by id so events for a given aggregate are delivered in the order
   * they were produced.
   */
  private async claim(): Promise<OutboxEvent[]> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outbox)
        .where(isNull(outbox.publishedAt))
        .orderBy(outbox.id)
        .limit(BATCH_SIZE)
        .for('update', { skipLocked: true });

      return rows.map((r) => ({
        id: r.id,
        eventType: r.eventType,
        aggregateType: r.aggregateType,
        aggregateId: r.aggregateId,
        payload: r.payload,
      }));
    });
  }

  private async refreshPendingGauge(): Promise<void> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(outbox)
      .where(isNull(outbox.publishedAt));

    this.metrics.setOutboxPending(row?.n ?? 0);
  }
}
