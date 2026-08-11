import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type OutboxEvent = {
  id: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
};

/**
 * Stand-in for the downstream Alerting Service.
 *
 * Posts to `ALERTING_WEBHOOK_URL` when one is configured, and otherwise logs the
 * delivery. The substitution is deliberate: what the outbox pattern guarantees
 * is that a committed measurement *will* be delivered at least once, and that
 * property is a function of the dispatcher and the transaction, not of who is
 * listening. A real consumer changes nothing about the guarantee under test.
 *
 * Deliveries are at-least-once, so the consumer must be idempotent. `id` is the
 * de-duplication token — the same reasoning as the Idempotency-Key on ingest,
 * one layer further out.
 */
@Injectable()
export class AlertingClient {
  private readonly logger = new Logger(AlertingClient.name);
  private readonly webhookUrl?: string;

  constructor(config: ConfigService) {
    this.webhookUrl = config.get<string>('ALERTING_WEBHOOK_URL');
  }

  async deliver(event: OutboxEvent): Promise<void> {
    if (!this.webhookUrl) {
      this.logger.log(
        `alert ${event.eventType} [outbox#${event.id}] ${JSON.stringify(event.payload)}`,
      );
      return;
    }

    /**
     * Bounded so a hung downstream cannot stall the dispatcher indefinitely. On
     * timeout the row simply stays unpublished and is retried next pass — the
     * failure mode is delayed delivery, never lost delivery.
     */
    const res = await fetch(this.webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Lets the consumer de-duplicate a redelivery.
        'X-Event-Id': String(event.id),
      },
      body: JSON.stringify({
        id: event.id,
        type: event.eventType,
        aggregate: { type: event.aggregateType, id: event.aggregateId },
        payload: event.payload,
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      throw new Error(
        `alerting webhook responded ${res.status} ${res.statusText}`,
      );
    }
  }
}
