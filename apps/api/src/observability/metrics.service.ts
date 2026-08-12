import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Prometheus metrics (bonus #6).
 *
 * The spec asks specifically to "track how many requests were identified and
 * rejected as duplicates". That is `emissions_ingest_duplicate_total`, split by
 * the mechanism that caught it — the two layers fail for different reasons and
 * conflating them would hide which one is doing the work:
 *
 *   reason="idempotent_replay"  Layer 1. A retried request; the stored response
 *                               was replayed. Expected, benign, and the number
 *                               to watch when clients report timeouts.
 *
 *   reason="key_reused"         Layer 1. Same key, different payload. A client
 *                               bug — this one deserves an alert.
 *
 *   reason="duplicate_reading"  Layer 2, counted per reading. Readings already
 *                               present, arriving under a new key. A steady
 *                               non-zero rate means a device is replaying its
 *                               buffer, which is worth knowing about.
 */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  private readonly ingestBatches = new Counter({
    name: 'emissions_ingest_batches_total',
    help: 'Ingest batches processed',
    labelNames: ['api_version', 'outcome'] as const,
    registers: [this.registry],
  });

  private readonly duplicates = new Counter({
    name: 'emissions_ingest_duplicate_total',
    help: 'Requests or readings rejected as duplicates, by detecting layer',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  private readonly measurementsInserted = new Counter({
    name: 'emissions_measurements_inserted_total',
    help: 'Measurement rows genuinely persisted',
    registers: [this.registry],
  });

  private readonly limitExceeded = new Counter({
    name: 'emissions_site_limit_exceeded_total',
    help: 'Transitions of a site into limit-exceeded state',
    registers: [this.registry],
  });

  private readonly outboxPublished = new Counter({
    name: 'emissions_outbox_published_total',
    help: 'Outbox events delivered downstream',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });

  private readonly outboxFailed = new Counter({
    name: 'emissions_outbox_failed_total',
    help: 'Outbox delivery attempts that failed',
    labelNames: ['event_type'] as const,
    registers: [this.registry],
  });

  /**
   * Unpublished outbox rows. The single most useful number for spotting that
   * the dispatcher has stalled: a backlog that climbs monotonically means events
   * are being written and never delivered.
   */
  private readonly outboxPending = new Gauge({
    name: 'emissions_outbox_pending',
    help: 'Outbox events awaiting delivery',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'emissions_' });
  }

  recordIngest(apiVersion: string, outcome: 'accepted' | 'replayed'): void {
    this.ingestBatches.inc({ api_version: apiVersion, outcome });
  }

  recordDuplicate(
    reason:
      | 'idempotent_replay'
      | 'key_reused'
      | 'duplicate_reading'
      | 'value_conflict'
      | 're_identified',
    count = 1,
  ): void {
    this.duplicates.inc({ reason }, count);
  }

  recordMeasurementsInserted(count: number): void {
    if (count > 0) this.measurementsInserted.inc(count);
  }

  recordLimitExceeded(): void {
    this.limitExceeded.inc();
  }

  recordOutboxPublished(eventType: string): void {
    this.outboxPublished.inc({ event_type: eventType });
  }

  recordOutboxFailed(eventType: string): void {
    this.outboxFailed.inc({ event_type: eventType });
  }

  setOutboxPending(n: number): void {
    this.outboxPending.set(n);
  }

  render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
