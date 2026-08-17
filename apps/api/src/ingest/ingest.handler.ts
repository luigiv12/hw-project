import { Inject, Logger } from '@nestjs/common';
import { CommandHandler, type ICommandHandler } from '@nestjs/cqrs';
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  ComplianceStatus,
  ErrorCode,
  type IngestResult,
} from '@emissions/contracts';
import { DB, type Database } from '../db/db.module';
import { ingestionBatches, measurements, outbox, sites } from '../db/schema';
import { AppException } from '../common/app.exception';
import { hashIngestRequest } from '../common/canonical-hash';
import { compareDecimalStrings } from '../common/decimal';
import { complianceFor } from '../common/compliance';
import { MetricsService } from '../observability/metrics.service';
import { IngestMeasurementsCommand } from './ingest.command';

/**
 * The identity a reading de-duplicates on — the producer's `readingId` when it
 * supplied one, otherwise the (device, timestamp) fallback.
 *
 * Mirrors the two partial unique indexes on `measurements`; the prefix keeps the
 * two namespaces from ever colliding.
 */
function identityOf(r: {
  readingId: string | null;
  deviceId: string;
  readingTs: Date;
}): string {
  return r.readingId
    ? `rid:${r.readingId}|${r.readingTs.getTime()}`
    : `dev:${r.deviceId}|${r.readingTs.getTime()}`;
}

@CommandHandler(IngestMeasurementsCommand)
export class IngestMeasurementsHandler implements ICommandHandler<
  IngestMeasurementsCommand,
  IngestResult
> {
  private readonly logger = new Logger(IngestMeasurementsHandler.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly metrics: MetricsService,
  ) {}

  /**
   * Ingests a batch exactly once.
   *
   * Everything below happens in ONE transaction: the measurements, the site
   * summary, the batch record, and the outbox event either all become visible
   * together or none of them do. There is no window in which a reader can see
   * measurements that the summary does not account for.
   *
   * Two independent defences against double-counting:
   *
   *   Layer 1 — the batch record. A unique (site_id, idempotency_key) means a
   *   retried *request* cannot be applied twice.
   *
   *   Layer 2 — the natural key on measurements. A unique
   *   (site_id, device_id, reading_ts) means a repeated *reading* cannot be
   *   stored twice, even when it arrives under a different idempotency key —
   *   which Layer 1 cannot detect. The summary advances by the rows actually
   *   inserted, never by the rows submitted.
   */
  async execute(command: IngestMeasurementsCommand): Promise<IngestResult> {
    const { input, idempotencyKey } = command;
    const requestHash = hashIngestRequest(input);

    return this.db.transaction(async (tx) => {
      /**
       * Step 1 — pessimistic lock on the site row.
       *
       * Taken FIRST, before touching the batch table, and held for the whole
       * transaction. This is what makes concurrent sources updating the same
       * site safe, and the ordering matters:
       *
       *   - Concurrent *distinct* batches serialise here, so each one's delta is
       *     applied to a total the previous one already committed. No lost
       *     updates.
       *
       *   - Concurrent *duplicates* also queue here. By the time the second one
       *     proceeds, the first has committed, so it observes a completed batch
       *     and replays the stored response instead of racing to insert one.
       *
       * Pessimistic rather than optimistic: this is a single hot counter row and
       * every writer touches it. Optimistic locking would make all ten writers
       * collide, roll back, and retry — converting guaranteed contention into
       * guaranteed wasted work.
       */
      const [site] = await tx
        .select()
        .from(sites)
        .where(eq(sites.id, input.siteId))
        .for('update');

      if (!site) {
        throw new AppException(
          ErrorCode.SITE_NOT_FOUND,
          `No site exists with id ${input.siteId}`,
        );
      }

      /**
       * Step 2 — claim the idempotency key.
       *
       * ON CONFLICT DO NOTHING makes this a claim rather than a check: there is
       * no read-then-write gap for a competing transaction to slip through.
       * Either a row comes back and this request owns the batch, or nothing
       * comes back and it is a duplicate.
       */
      const [claimed] = await tx
        .insert(ingestionBatches)
        .values({
          siteId: input.siteId,
          idempotencyKey,
          requestHash,
          status: 'in_progress',
          readingsSubmitted: input.readings.length,
        })
        .onConflictDoNothing()
        .returning();

      if (!claimed) {
        return this.handleDuplicate(
          tx,
          input.siteId,
          idempotencyKey,
          requestHash,
          command.apiVersion,
        );
      }

      /**
       * Step 3a — readings whose identity scheme disagrees with what is stored.
       *
       * A `(device, instant)` may hold identified readings or one unidentified
       * reading, never both. The two partial unique indexes cover disjoint sets
       * of rows, so neither adjudicates such a pair and the database would store
       * both — the same measurement counted twice.
       *
       * Checked in both directions, because which reading arrives first is an
       * accident of ordering rather than a fact about the data. A device
       * upgraded to emit `readingId` and replaying its buffer produces one
       * direction; a device that stops emitting them, or a mixed fleet sharing a
       * device name, produces the other.
       *
       * Withheld rather than guessed at: a reading held back is reported and can
       * be re-sent unambiguously, where a duplicated regulatory total has nothing
       * downstream to contradict it.
       */
      const mixedIdentity = await this.findIdentitySchemeConflicts(tx, input);
      const withheld = new Set(
        mixedIdentity.map(
          (c) => `${c.deviceId}|${new Date(c.readingTs).getTime()}`,
        ),
      );

      const toInsert = input.readings.filter(
        (r) =>
          !withheld.has(`${r.deviceId}|${new Date(r.readingTs).getTime()}`),
      );

      /**
       * Step 3b — insert the readings.
       *
       * ON CONFLICT DO NOTHING against the natural key. `returning` yields only
       * the rows that were genuinely new; anything already present under an
       * earlier batch is silently skipped.
       */
      const inserted = toInsert.length
        ? await tx
            .insert(measurements)
            .values(
              toInsert.map((r) => ({
                siteId: input.siteId,
                batchId: claimed.id,
                readingId: r.readingId ?? null,
                deviceId: r.deviceId,
                readingTs: new Date(r.readingTs),
                ch4Kg: r.ch4Kg,
                source: r.source,
              })),
            )
            .onConflictDoNothing()
            .returning({
              deviceId: measurements.deviceId,
              readingTs: measurements.readingTs,
              readingId: measurements.readingId,
            })
        : [];

      const readingsAccepted = inserted.length;

      /**
       * Distinguish a de-duplicated retry from a genuinely lost measurement.
       *
       * A retry resends identical values, so a collision whose stored mass
       * differs is not a retry — it is two distinct measurements competing for
       * one identity, and one of them was not stored. Surfacing it is the point:
       * a silently dropped reading understates a regulatory total, and unlike a
       * double-count nothing downstream will ever contradict it.
       */
      const valueConflicts = await this.findValueConflicts(
        tx,
        { ...input, readings: toInsert },
        new Set(inserted.map((r) => identityOf(r))),
      );

      // Merged for the response; each entry carries its own `reason`, so a
      // consumer can tell which fix applies without parsing the message.
      const conflicts = [...mixedIdentity, ...valueConflicts];

      /**
       * Step 4 — the delta, computed by Postgres from the rows that landed.
       *
       * Summed in the database over this batch_id rather than in JavaScript over
       * the request payload. Two reasons, both load-bearing: rows rejected by
       * Layer 2 are excluded automatically, and `numeric` addition is exact
       * where float64 addition is not. This single expression is what makes
       * "the summary moves by what was accepted, not what was sent" true.
       */
      const [delta] = await tx
        .select({
          kg: sql<string>`coalesce(sum(${measurements.ch4Kg}), 0)::text`,
          /**
           * The reading span of this batch, taken here while its rows are
           * already being aggregated. Folded into the site's span below so the
           * read path never needs an unbounded MIN/MAX over history.
           */
          firstTs: sql<Date | null>`min(${measurements.readingTs})`,
          lastTs: sql<Date | null>`max(${measurements.readingTs})`,
        })
        .from(measurements)
        .where(eq(measurements.batchId, claimed.id));

      const acceptedCh4Kg = delta?.kg ?? '0';

      // Step 5 — advance the summary under the lock taken in step 1.
      const [updatedSite] = await tx
        .update(sites)
        .set({
          totalEmissionsToDateKg: sql`${sites.totalEmissionsToDateKg} + ${acceptedCh4Kg}::numeric`,
          measurementCount: sql`${sites.measurementCount} + ${readingsAccepted}`,

          /**
           * Widened, never overwritten — a backfill of older readings must move
           * the start of the span backwards, and LEAST/GREATEST ignore NULLs so
           * the first batch for a site sets both.
           */
          firstReadingAt: sql`least(${sites.firstReadingAt}, ${delta?.firstTs ?? null})`,
          lastReadingAt: sql`greatest(${sites.lastReadingAt}, ${delta?.lastTs ?? null})`,

          version: sql`${sites.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(sites.id, input.siteId))
        .returning();

      const complianceStatus = complianceFor(
        updatedSite.totalEmissionsToDateKg,
        updatedSite.emissionLimitKg,
      );

      const result: IngestResult = {
        batchId: claimed.id,
        siteId: input.siteId,
        readingsSubmitted: input.readings.length,
        readingsAccepted,
        acceptedCh4Kg,
        totalEmissionsToDateKg: updatedSite.totalEmissionsToDateKg,
        complianceStatus,
        idempotentReplay: false,
        conflicts,
      };

      /**
       * Step 6 — outbox events, written in this same transaction (bonus #4).
       *
       * This is the entire point of the outbox pattern: the event cannot exist
       * without the data, and the data cannot exist without the event. Calling
       * an alerting service over HTTP here would break that — the call could
       * succeed and the transaction still roll back, alerting on an emission
       * that was never recorded.
       */
      await tx.insert(outbox).values({
        aggregateType: 'site',
        aggregateId: input.siteId,
        eventType: 'measurements.ingested',
        payload: {
          batchId: claimed.id,
          siteId: input.siteId,
          readingsAccepted,
          acceptedCh4Kg,
          totalEmissionsToDateKg: updatedSite.totalEmissionsToDateKg,
          apiVersion: command.apiVersion,
        },
      });

      /**
       * Emitted only on the transition into breach, not on every ingest while
       * over the limit — an alerting service should be told that a site crossed
       * its limit once, not once per batch forever after.
       */
      const wasWithinLimit =
        compareDecimalStrings(
          site.totalEmissionsToDateKg,
          site.emissionLimitKg,
        ) <= 0;

      if (
        wasWithinLimit &&
        complianceStatus === ComplianceStatus.LIMIT_EXCEEDED
      ) {
        await tx.insert(outbox).values({
          aggregateType: 'site',
          aggregateId: input.siteId,
          eventType: 'site.limit_exceeded',
          payload: {
            siteId: input.siteId,
            siteName: updatedSite.name,
            emissionLimitKg: updatedSite.emissionLimitKg,
            totalEmissionsToDateKg: updatedSite.totalEmissionsToDateKg,
            crossedByBatchId: claimed.id,
          },
        });

        this.metrics.recordLimitExceeded();
        this.logger.warn(
          `site ${input.siteId} (${updatedSite.name}) crossed its emission limit: ` +
            `${updatedSite.totalEmissionsToDateKg} / ${updatedSite.emissionLimitKg} kg`,
        );
      }

      /**
       * Step 7 — store the response verbatim.
       *
       * A retry replays these exact bytes, so a duplicate is indistinguishable
       * from the original to the client. Recomputing the response on replay
       * would let a later ingest's totals leak into the answer for an earlier
       * batch.
       */
      await tx
        .update(ingestionBatches)
        .set({
          status: 'completed',
          responseSnapshot: result,
          readingsAccepted,
          acceptedCh4Kg,
          completedAt: new Date(),
        })
        .where(eq(ingestionBatches.id, claimed.id));

      /**
       * Readings that were de-duplicated, and only those.
       *
       * Withheld conflicts are also absent from `readingsAccepted`, but they are
       * not duplicates — they are readings the server declined to store because
       * it could not tell which measurement was meant. They are counted under
       * their own reasons below, so subtracting them here is what keeps
       * `duplicate_reading` answering the question the brief actually asks:
       * how many were identified and rejected as duplicates.
       */
      const skipped =
        input.readings.length - readingsAccepted - conflicts.length;

      this.metrics.recordIngest(command.apiVersion, 'accepted');
      this.metrics.recordMeasurementsInserted(readingsAccepted);

      if (skipped > 0) {
        // Layer 2 catches — counted per reading, since a batch can be partially
        // duplicate.
        this.metrics.recordDuplicate('duplicate_reading', skipped);
        this.logger.log(
          `batch ${claimed.id}: ${skipped} of ${input.readings.length} readings already present, skipped`,
        );
      }

      if (mixedIdentity.length > 0) {
        this.metrics.recordDuplicate('mixed_identity', mixedIdentity.length);
        this.logger.warn(
          `batch ${claimed.id}: ${mixedIdentity.length} reading(s) disagreed with the ` +
            `identity scheme already stored at their device and instant, and were NOT stored. ` +
            `One instant holds identified readings or one unidentified reading, never both. ` +
            `Identify both if they are separate measurements, or neither if they are the same one. ` +
            mixedIdentity
              .map(
                (c) =>
                  `${c.deviceId}@${c.readingTs} submitted=${c.submittedCh4Kg} stored=${c.storedCh4Kg}`,
              )
              .join('; '),
        );
      }

      if (valueConflicts.length > 0) {
        this.metrics.recordDuplicate('value_conflict', valueConflicts.length);
        this.logger.warn(
          `batch ${claimed.id}: ${valueConflicts.length} reading(s) collided with a stored ` +
            `reading carrying a different mass and were NOT stored. ` +
            `The producer should send readingId. ` +
            valueConflicts
              .map(
                (c) =>
                  `${c.deviceId}@${c.readingTs} submitted=${c.submittedCh4Kg} stored=${c.storedCh4Kg}`,
              )
              .join('; '),
        );
      }

      return result;
    });
  }

  /**
   * Readings whose identity scheme disagrees with what is already stored at
   * their (site, device, instant) — identified arriving where an unidentified
   * reading sits, or the reverse.
   *
   * The one collision the partial indexes cannot adjudicate: each row satisfies
   * a different index, so both may exist and the same physical measurement would
   * be counted twice.
   *
   * Runs on every batch, including those carrying no `readingId` at all — which
   * is the common case, since no v1 sensor sends one. Skipping the query there
   * would be cheaper but would leave the reverse direction unchecked: a stored
   * identified reading is only visible to a batch that looks for it.
   */
  private async findIdentitySchemeConflicts(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: IngestMeasurementsCommand['input'],
  ): Promise<IngestResult['conflicts']> {
    /**
     * The instants this batch touches, deduplicated.
     *
     * Used below as a `reading_ts IN (…)` that is logically redundant — every
     * branch of the OR already pins a timestamp — but is what makes the query
     * indexable. An OR of (device, instant) pairs gives the planner nothing to
     * push into the index condition beyond `site_id`, so it probes on that alone
     * and filters the rest, reading every measurement the site recorded in the
     * partition. Harmless at demo scale, ruinous at the 100M rows this schema is
     * partitioned for. Stating the instants separately lets
     * `(site_id, reading_ts)` serve both columns; the OR then does the exact
     * pairing.
     */
    const instants = [
      ...new Map(
        input.readings.map((r) => {
          const ts = new Date(r.readingTs);
          return [ts.getTime(), ts] as const;
        }),
      ).values(),
    ];

    const stored = await tx
      .select({
        deviceId: measurements.deviceId,
        readingTs: measurements.readingTs,
        readingId: measurements.readingId,
        ch4Kg: measurements.ch4Kg,
      })
      .from(measurements)
      .where(
        and(
          eq(measurements.siteId, input.siteId),
          inArray(measurements.readingTs, instants),
          or(
            ...input.readings.map((r) =>
              and(
                eq(measurements.deviceId, r.deviceId),
                eq(measurements.readingTs, new Date(r.readingTs)),
              ),
            ),
          ),
        ),
      );

    if (stored.length === 0) return [];

    const instantOf = (deviceId: string, ts: Date | string) =>
      `${deviceId}|${new Date(ts).getTime()}`;

    // An instant is "identified" if anything stored there carries an id.
    const storedScheme = new Map<
      string,
      { identified: boolean; ch4Kg: string }
    >();
    for (const s of stored) {
      const key = instantOf(s.deviceId, s.readingTs);
      const seen = storedScheme.get(key);
      if (!seen || (!seen.identified && s.readingId !== null)) {
        storedScheme.set(key, {
          identified: s.readingId !== null,
          ch4Kg: s.ch4Kg,
        });
      }
    }

    return input.readings.flatMap((r) => {
      const existing = storedScheme.get(instantOf(r.deviceId, r.readingTs));
      if (!existing) return [];

      // Same scheme is ordinary de-duplication, handled by the unique indexes.
      if (existing.identified === Boolean(r.readingId)) return [];

      return [
        {
          reason: 'mixed_identity' as const,
          deviceId: r.deviceId,
          readingTs: new Date(r.readingTs).toISOString(),
          submittedCh4Kg: r.ch4Kg,
          storedCh4Kg: existing.ch4Kg,
        },
      ];
    });
  }

  /**
   * For readings that were not inserted, compares the submitted mass against
   * what is already stored under the same identity.
   *
   * Equal masses mean a de-duplicated retry: expected, benign, nothing to
   * report. Differing masses mean a measurement was lost, and that is what gets
   * returned to the caller.
   *
   * Runs inside the ingest transaction and reads at most one row per skipped
   * reading, bounded by the 100-reading batch limit.
   */
  private async findValueConflicts(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    input: IngestMeasurementsCommand['input'],
    insertedIdentities: Set<string>,
  ): Promise<IngestResult['conflicts']> {
    const skipped = input.readings.filter(
      (r) =>
        !insertedIdentities.has(
          identityOf({
            readingId: r.readingId ?? null,
            deviceId: r.deviceId,
            readingTs: new Date(r.readingTs),
          }),
        ),
    );

    if (skipped.length === 0) return [];

    const stored = await tx
      .select({
        readingId: measurements.readingId,
        deviceId: measurements.deviceId,
        readingTs: measurements.readingTs,
        ch4Kg: measurements.ch4Kg,
      })
      .from(measurements)
      .where(
        and(
          eq(measurements.siteId, input.siteId),
          or(
            ...skipped.map((r) =>
              r.readingId
                ? and(
                    eq(measurements.readingId, r.readingId),
                    eq(measurements.readingTs, new Date(r.readingTs)),
                  )
                : and(
                    isNull(measurements.readingId),
                    eq(measurements.deviceId, r.deviceId),
                    eq(measurements.readingTs, new Date(r.readingTs)),
                  ),
            ),
          ),
        ),
      );

    const storedByIdentity = new Map(
      stored.map((s) => [identityOf(s), s.ch4Kg]),
    );

    const conflicts: IngestResult['conflicts'] = [];

    for (const r of skipped) {
      const identity = identityOf({
        readingId: r.readingId ?? null,
        deviceId: r.deviceId,
        readingTs: new Date(r.readingTs),
      });
      const storedKg = storedByIdentity.get(identity);
      if (storedKg === undefined) continue;

      // Exact decimal comparison — "5.50" and "5.5" are the same mass and must
      // not be reported as a conflict.
      if (compareDecimalStrings(storedKg, r.ch4Kg) !== 0) {
        conflicts.push({
          reason: 'value_conflict',
          deviceId: r.deviceId,
          readingTs: new Date(r.readingTs).toISOString(),
          submittedCh4Kg: r.ch4Kg,
          storedCh4Kg: storedKg,
        });
      }
    }

    return conflicts;
  }

  /**
   * A batch already exists for this (site, key).
   *
   * Note this runs while still holding the site lock from step 1, so the
   * competing transaction has necessarily committed and the row read here is
   * final.
   */
  private async handleDuplicate(
    tx: Parameters<Parameters<Database['transaction']>[0]>[0],
    siteId: string,
    idempotencyKey: string,
    requestHash: string,
    apiVersion: string,
  ): Promise<IngestResult> {
    const [existing] = await tx
      .select()
      .from(ingestionBatches)
      .where(
        sql`${ingestionBatches.siteId} = ${siteId} and ${ingestionBatches.idempotencyKey} = ${idempotencyKey}`,
      );

    if (!existing) {
      // The insert conflicted, so a row must exist. Reaching here would mean the
      // unique index and this lookup disagree.
      throw new AppException(
        ErrorCode.INTERNAL_ERROR,
        'Idempotency key conflicted but no batch was found',
      );
    }

    /**
     * Same key, different payload. Deliberately an error rather than a replay:
     * treating it as a duplicate would silently discard a genuinely new batch of
     * readings, and treating it as new would let one key describe two different
     * things. Both are worse than telling the client it has a bug.
     */
    if (existing.requestHash !== requestHash) {
      this.metrics.recordDuplicate('key_reused');
      this.logger.warn(
        `idempotency key reused with a different payload — site=${siteId} key=${idempotencyKey}`,
      );
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_REUSED,
        'This Idempotency-Key was already used for a different batch. Use a new key for new readings.',
      );
    }

    /**
     * Unreachable while ingest is a single transaction: an in-progress batch has
     * not committed, so no other transaction can observe it, and a rolled-back
     * one leaves no row at all. Kept as a guard for the day the pipeline becomes
     * asynchronous, where a batch genuinely can be claimed and still pending.
     */
    if (existing.status !== 'completed' || !existing.responseSnapshot) {
      throw new AppException(
        ErrorCode.BATCH_IN_PROGRESS,
        'A batch with this Idempotency-Key is still being processed. Retry shortly.',
      );
    }

    this.metrics.recordDuplicate('idempotent_replay');
    this.metrics.recordIngest(apiVersion, 'replayed');
    this.logger.log(
      `idempotent replay — site=${siteId} key=${idempotencyKey} batch=${existing.id}`,
    );

    return {
      ...(existing.responseSnapshot as IngestResult),
      idempotentReplay: true,
    };
  }
}
