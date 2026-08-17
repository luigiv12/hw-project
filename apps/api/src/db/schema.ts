import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Drizzle schema — the typed read model over the database.
 *
 * `measurements` is RANGE partitioned by month, which Drizzle's DDL generator
 * cannot express. Its real definition lives in the hand-written SQL migration;
 * the declaration here exists so queries against it are type-checked. The two
 * must be kept in step by hand — see ARCHITECTURE.md for why that trade is worth
 * making rather than abandoning either the ORM or the partitioning.
 */

// ---------------------------------------------------------------------------

export const sites = pgTable('sites', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),

  /**
   * Regulatory quantities are `numeric`, never float. Postgres `numeric` is
   * exact decimal; a double would make the compliance comparison depend on
   * binary rounding, which is not a defensible basis for a limit breach.
   */
  emissionLimitKg: numeric('emission_limit_kg', {
    precision: 14,
    scale: 3,
  }).notNull(),

  /**
   * Running total maintained by the ingest transaction. Denormalised on purpose:
   * the dashboard reads it constantly and summing 100M partitioned rows per page
   * load is not viable. Correctness is protected by updating it in the same
   * transaction as the measurements, under a row lock.
   */
  totalEmissionsToDateKg: numeric('total_emissions_to_date_kg', {
    precision: 18,
    scale: 4,
  })
    .notNull()
    .default('0'),

  measurementCount: bigint('measurement_count', { mode: 'number' })
    .notNull()
    .default(0),

  /**
   * The span of readings held for this site, maintained by the ingest
   * transaction alongside the counters above.
   *
   * Denormalised for the same reason the total is: deriving them with
   * MIN/MAX over `measurements` puts no bound on the partition key, so Postgres
   * can prune nothing and the query grows with all of history rather than with
   * the window being asked about.
   *
   * Null until a site has readings — a site with none has no first or last, and
   * any sentinel value would be a lie.
   */
  firstReadingAt: timestamp('first_reading_at', { withTimezone: true }),
  lastReadingAt: timestamp('last_reading_at', { withTimezone: true }),

  /**
   * Incremented on every summary change. Not used for optimistic locking — the
   * ingest path takes a pessimistic row lock — but it gives readers a cheap
   * change token and makes lost updates visible in tests if the lock ever
   * regresses.
   */
  version: integer('version').notNull().default(0),

  metadata: jsonb('metadata')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// ---------------------------------------------------------------------------

export const measurements = pgTable(
  'measurements',
  {
    id: uuid('id').notNull().defaultRandom(),
    siteId: uuid('site_id').notNull(),

    /**
     * The batch this reading arrived in, and the key the ingest transaction sums
     * over to compute how much the site total should move.
     *
     * Deliberately **not** a foreign key. Batch records identify a delivery
     * attempt and are expected to be expired on a retention policy; measurements
     * are permanent regulatory records. A foreign key would tie those lifetimes
     * together — either blocking the expiry or, with a cascade, deleting
     * measurements when idempotency keys are pruned. The looser reference is the
     * safer of the two failure modes.
     */
    batchId: uuid('batch_id').notNull(),

    /**
     * Producer-assigned identity, when the device supplies one. Authoritative
     * for de-duplication where present — only the producer can know whether two
     * readings are the same physical event.
     */
    readingId: text('reading_id'),

    /** Physical sensor identifier. */
    deviceId: text('device_id').notNull(),

    /**
     * Partition key. Also part of the primary key and of both dedup indexes.
     *
     * The column is microsecond-capable, but values arrive through a JavaScript
     * `Date` and are therefore millisecond-resolution in practice. See the note
     * on `readingTs` in @emissions/contracts — a producer that samples faster
     * than 1 kHz must supply `readingId` rather than rely on the timestamp to
     * distinguish its readings.
     */
    readingTs: timestamp('reading_ts', { withTimezone: true }).notNull(),

    ch4Kg: numeric('ch4_kg', { precision: 14, scale: 4 }).notNull(),
    source: text('source').notNull().default('sensor'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /**
     * Postgres requires every unique constraint on a partitioned table to
     * contain the partition key, so `reading_ts` appears in both.
     */
    primaryKey({ columns: [t.id, t.readingTs] }),

    /**
     * The second line of defence against double-counting, in two parts.
     *
     * Idempotency keys stop a *retried request* from being applied twice. These
     * stop the same physical reading from being counted twice however it
     * arrives — including under two different idempotency keys, which the batch
     * layer cannot detect. Ingest inserts with ON CONFLICT DO NOTHING and moves
     * the site total by the rows actually inserted.
     *
     * The two indexes are partial and mutually exclusive, so exactly one applies
     * to any given row. Both are rooted at (site, device) and differ only in what
     * identifies a reading within that:
     *
     *   reading_id present → identity is what the producer said it is, and two
     *   readings sharing a device and timestamp are stored as distinct
     *   measurements, which is correct because the producer says they are.
     *
     *   reading_id absent  → fall back to (site, device, timestamp). Right for a
     *   sensor emitting at most one reading per instant; unable to represent two
     *   genuine readings at the same instant. That limitation is why readingId
     *   exists.
     *
     * Neither can omit `reading_ts`, so neither can enforce identity *across*
     * timestamps — see the cross-timestamp lookup in the ingest handler, which
     * closes that gap and relies on the (site, device, reading_id) prefix below.
     */
    uniqueIndex('measurements_site_device_ts_key')
      .on(t.siteId, t.deviceId, t.readingTs)
      .where(sql`${t.readingId} is null`),

    uniqueIndex('measurements_site_device_reading_id_ts_key')
      .on(t.siteId, t.deviceId, t.readingId, t.readingTs)
      .where(sql`${t.readingId} is not null`),

    index('measurements_site_ts_idx').on(t.siteId, t.readingTs),
    index('measurements_batch_idx').on(t.batchId),
  ],
);

// ---------------------------------------------------------------------------

export const BATCH_STATUS = ['in_progress', 'completed', 'failed'] as const;
export type BatchStatus = (typeof BATCH_STATUS)[number];

export const ingestionBatches = pgTable(
  'ingestion_batches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    siteId: uuid('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),

    /** Supplied by the client via the Idempotency-Key header, or v1 `batch_id`. */
    idempotencyKey: text('idempotency_key').notNull(),

    /**
     * SHA-256 of the canonicalised request body. A retry must carry an identical
     * payload; the same key with a different body is a client bug and is
     * rejected rather than silently treated as a duplicate.
     */
    requestHash: text('request_hash').notNull(),

    status: text('status', { enum: BATCH_STATUS }).notNull(),

    /**
     * The exact response produced the first time. Replayed verbatim on retry so
     * a duplicate request is indistinguishable from the original to the client.
     */
    responseSnapshot: jsonb('response_snapshot').$type<unknown>(),

    readingsSubmitted: integer('readings_submitted').notNull().default(0),
    readingsAccepted: integer('readings_accepted').notNull().default(0),
    acceptedCh4Kg: numeric('accepted_ch4_kg', { precision: 18, scale: 4 })
      .notNull()
      .default('0'),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    /**
     * The concurrency primitive for the whole idempotency scheme. Ten parallel
     * retries all attempt this insert; Postgres lets exactly one win, and the
     * losers are routed to the replay path.
     */
    uniqueIndex('ingestion_batches_site_key_uniq').on(
      t.siteId,
      t.idempotencyKey,
    ),
  ],
);

// ---------------------------------------------------------------------------

export const outbox = pgTable(
  'outbox',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    aggregateType: text('aggregate_type').notNull(),
    aggregateId: uuid('aggregate_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),

    /**
     * When a dispatcher last took this row for delivery.
     *
     * Delivery happens outside the claiming transaction, so a row lock cannot
     * cover it. This is the claim made durable: rows stamped within the lease
     * window are skipped by other dispatchers, and a lapsed stamp means the
     * claimer died and the row is retryable.
     */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),

    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    /**
     * Partial index over unpublished rows only. The table grows without bound
     * but the poller's working set stays small, so its claim query does not
     * degrade as history accumulates.
     */
    index('outbox_unpublished_idx')
      .on(t.id)
      .where(sql`${t.publishedAt} is null`),
  ],
);

export type SiteRow = typeof sites.$inferSelect;
export type MeasurementRow = typeof measurements.$inferSelect;
export type IngestionBatchRow = typeof ingestionBatches.$inferSelect;
export type OutboxRow = typeof outbox.$inferSelect;
