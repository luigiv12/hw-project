import { z } from 'zod';

/**
 * Shared wire contract for the platform.
 *
 * ## Naming rule
 *
 * `id` names the entity a response is *about*. `<entity>Id` names a reference to
 * a different entity. So `GET /sites` and `GET /sites/:id/metrics` both return
 * `id` for the site, because both responses are about a site — a consumer must
 * never have to write `res.id ?? res.siteId` depending on which endpoint it
 * called.
 *
 * `IngestResult` carries both `batchId` and `siteId` rather than an `id`,
 * because it is an operation result rather than a resource representation:
 * neither entity is "the" subject, so both are named explicitly.
 *
 * ## Units
 *
 * Every mass is kilograms of CH4 and every field carrying one says so (`...Kg`).
 * The v1 sensor contract reports grams; that conversion happens once, in the
 * anti-corruption layer in legacy.ts, and never leaks past it.
 *
 * ## Numbers
 *
 * Regulatory quantities cross the wire as decimal strings, not JSON numbers.
 * They are `numeric` in Postgres and comparisons that decide compliance are
 * exact. Serialising through a float64 would reintroduce exactly the rounding
 * the database column exists to avoid.
 */

/** Maximum readings accepted in one ingest request. */
export const MAX_BATCH_SIZE = 100;

/** Spec uses these exact strings for compliance status — do not reword. */
export const ComplianceStatus = {
  WITHIN_LIMIT: 'Within Limit',
  LIMIT_EXCEEDED: 'Limit Exceeded',
} as const;

export type ComplianceStatus =
  (typeof ComplianceStatus)[keyof typeof ComplianceStatus];

export const complianceStatusSchema = z.enum([
  ComplianceStatus.WITHIN_LIMIT,
  ComplianceStatus.LIMIT_EXCEEDED,
]);

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

export const createSiteSchema = z.object({
  name: z.string().trim().min(1).max(200),
  /**
   * Kilograms of CH4 permitted over the reporting period. Emission limits are a
   * regulatory quantity, so this is carried as a string end-to-end and stored as
   * numeric in Postgres — a float64 cannot represent every decimal exactly, and
   * "close enough" is not a property you want in a compliance boundary check.
   */
  emissionLimitKg: z
    .string()
    /**
     * Bounded to what the column can hold. `numeric(14, 3)` has eleven digits
     * left of the point, and a value beyond it fails inside Postgres — which
     * surfaces as a 500 for input the API should have rejected as a 400.
     */
    .regex(
      /^\d{1,11}(\.\d{1,3})?$/,
      'expected a decimal with up to 11 integer digits and 3dp',
    )
    /**
     * Zero is rejected here as well as by a CHECK constraint. A site with a zero
     * limit is permanently in breach and makes utilisation infinite; the
     * constraint is the backstop, this is the error the caller can act on.
     */
    .refine((v) => Number(v) > 0, 'must be greater than zero'),
  /** Free-form operator metadata: operator, basin, equipment tag, and so on. */
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type CreateSiteInput = z.infer<typeof createSiteSchema>;

export const siteSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  emissionLimitKg: z.string(),
  totalEmissionsToDateKg: z.string(),
  measurementCount: z.number().int().nonnegative(),

  /**
   * Served rather than derived by the client.
   *
   * The rule is an exact decimal comparison — strictly greater than the limit,
   * with a site exactly at its limit still within it. A consumer re-deriving it
   * from the two strings above would be doing that comparison in float64, which
   * is the rounding this contract carries decimals as strings to avoid. One
   * definition, evaluated where the exact arithmetic is.
   */
  complianceStatus: complianceStatusSchema,

  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Site = z.infer<typeof siteSchema>;

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

export const readingSchema = z.object({
  /**
   * Producer-assigned identity for this measurement. **Supply this whenever the
   * device can.**
   *
   * Only the producer knows whether two readings describe the same physical
   * event. When present, this is what de-duplication keys on, and two readings
   * sharing a device and timestamp are stored as the distinct measurements they
   * are.
   *
   * **Scoped per device, and independent of the timestamp.** It needs to be
   * unique among the readings that device produces, not across the whole site —
   * so a device-local counter is fine and does not have to be a UUID. And a
   * reading is identified by this id alone: re-sending the same id under a
   * different timestamp is a duplicate, not a second reading, which is what
   * makes it safe for a device to correct its clock and replay its buffer.
   *
   * When absent, the server falls back to treating (site, device, timestamp) as
   * the identity — a guess that is right for a sensor emitting at most one
   * reading per instant, and wrong for one that does not. A device sampling
   * faster than its timestamp resolution, or one recovering from a clock
   * correction, should send this.
   */
  readingId: z.string().trim().min(1).max(128).optional(),

  /** Identifies the physical sensor. */
  deviceId: z.string().trim().min(1).max(100),

  /**
   * The instant the reading was taken, ISO-8601 with an explicit offset.
   *
   * The offset is required rather than assumed: a bare local timestamp from a
   * device in Alberta silently read as UTC would displace the reading by six
   * hours, and nothing downstream would flag it.
   *
   * **Resolution is milliseconds.** The column is `timestamptz` and holds
   * microseconds, but the ingest path converts through a JavaScript `Date`,
   * which has no sub-millisecond resolution — sub-millisecond digits are
   * discarded before they reach the database.
   *
   * This matters only for a producer sampling faster than 1 kHz, which is far
   * beyond methane telemetry (typically seconds to minutes). Such a producer
   * MUST send `readingId`, or two genuinely distinct readings will collapse to
   * one identity and the second will be rejected as a duplicate.
   */
  readingTs: z.iso.datetime({ offset: true }),
  ch4Kg: z
    .string()
    // `numeric(14, 4)` leaves ten digits left of the point. Beyond that Postgres
    // raises a numeric overflow, which would reach the caller as a 500.
    .regex(
      /^\d{1,10}(\.\d{1,4})?$/,
      'expected a non-negative decimal with up to 10 integer digits and 4dp',
    ),
  source: z.enum(['sensor', 'satellite', 'manual']).default('sensor'),
});

export type Reading = z.infer<typeof readingSchema>;

/**
 * The identity a reading de-duplicates on: the producer's `readingId` when
 * supplied, otherwise (device, instant). Both are scoped to the device, matching
 * the two partial unique indexes on `measurements`; the prefix keeps the
 * namespaces from colliding.
 *
 * Note what the identified branch omits: the instant. Two readings sharing a
 * device and `readingId` are the same measurement however their timestamps
 * differ, which is what makes a re-send under a corrected clock a duplicate
 * rather than a second reading.
 */
function readingIdentity(r: Reading): string {
  return r.readingId
    ? `rid:${r.deviceId}|${r.readingId}`
    : `dev:${r.deviceId}|${new Date(r.readingTs).getTime()}`;
}

export const ingestSchema = z
  .object({
    siteId: z.uuid(),
    readings: z
      .array(readingSchema)
      .min(1)
      .max(
        MAX_BATCH_SIZE,
        `a batch may carry at most ${MAX_BATCH_SIZE} readings`,
      ),
  })
  .superRefine((batch, ctx) => {
    /**
     * A batch carries at most one reading per identity.
     *
     * Storage keeps one row per identity, so a batch containing two is asking
     * for something that cannot be represented. Only the producer can resolve
     * it — either the readings are one measurement, or they are two and need
     * distinct `readingId`s.
     */
    const seen = new Map<string, number>();

    batch.readings.forEach((reading, index) => {
      const identity = readingIdentity(reading);
      const first = seen.get(identity);

      if (first === undefined) {
        seen.set(identity, index);
        return;
      }

      ctx.addIssue({
        code: 'custom',
        path: ['readings', index],
        message:
          `duplicate reading identity within the batch (also at index ${first}). ` +
          'Two readings from one device at the same instant must each carry a ' +
          'distinct readingId, or one of them will be discarded.',
      });
    });

    /**
     * One instant, one identity scheme.
     *
     * A `(device, instant)` carrying both an identified and an unidentified
     * reading asserts two incompatible things about one measurement: that its
     * identity is the supplied id, and that it has no identity of its own beyond
     * the instant. Storage cannot represent both, and the server cannot tell
     * which the producer meant.
     *
     * Rejected rather than guessed at because sub-second duplicate readings do
     * not occur in this domain — sampling is seconds to minutes — so the far
     * likelier reading of such a batch is one measurement described twice.
     */
    const identified = new Map<string, number>();
    const anonymous = new Map<string, number>();

    batch.readings.forEach((reading, index) => {
      const instant = `${reading.deviceId}|${new Date(reading.readingTs).getTime()}`;
      const bucket = reading.readingId ? identified : anonymous;
      if (!bucket.has(instant)) bucket.set(instant, index);
    });

    for (const [instant, index] of identified) {
      const other = anonymous.get(instant);
      if (other === undefined) continue;

      ctx.addIssue({
        code: 'custom',
        path: ['readings', Math.max(index, other)],
        message:
          `this batch carries both an identified and an unidentified reading for ` +
          `the same device and instant (indexes ${Math.min(index, other)} and ` +
          `${Math.max(index, other)}). Give both a distinct readingId if they are ` +
          `separate measurements, or neither if they are the same one.`,
      });
    }
  });

export type IngestInput = z.infer<typeof ingestSchema>;

export const ingestResultSchema = z.object({
  batchId: z.uuid(),
  siteId: z.uuid(),
  /** Readings in the request. */
  readingsSubmitted: z.number().int().nonnegative(),
  /**
   * Readings that were genuinely new. The gap between submitted and accepted is
   * the natural-key dedup at work, and the site total moves by the accepted
   * amount only — never by the submitted amount.
   */
  readingsAccepted: z.number().int().nonnegative(),
  acceptedCh4Kg: z.string(),
  totalEmissionsToDateKg: z.string(),
  complianceStatus: complianceStatusSchema,
  /** True when this response was replayed from a previously completed batch. */
  idempotentReplay: z.boolean(),

  /**
   * Readings that collided with a stored reading carrying a **different** mass.
   *
   * A genuine retry resends identical values, so a differing value is never a
   * retry — it means two distinct measurements are competing for one identity,
   * and one of them was not stored. Reported rather than silently dropped:
   * losing a measurement misstates a regulatory total just as surely as
   * counting one twice, and a silent loss is the harder of the two to notice.
   *
   * The fix on the client side is to send `readingId`.
   */
  conflicts: z
    .array(
      z.object({
        /**
         * Why this reading was withheld. The two cases need different fixes, so
         * a consumer must be able to tell them apart without parsing prose.
         *
         * `value_conflict` — two readings competing for one identity with
         * different masses. Neither supplied a `readingId`, so there is no
         * identity claim to honour. Fix: send `readingId`.
         *
         * `mixed_identity` — an identified and an unidentified reading at the
         * same (device, instant). The producer is asserting two incompatible
         * things about one measurement. Fix: identify both, or neither.
         */
        reason: z.enum(['value_conflict', 'mixed_identity']),
        deviceId: z.string(),
        readingTs: z.string(),
        submittedCh4Kg: z.string(),
        storedCh4Kg: z.string(),
      }),
    )
    .default([]),
});

export type IngestResult = z.infer<typeof ingestResultSchema>;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export const siteMetricsSchema = z.object({
  /**
   * Named `id`, not `siteId`. See the naming rule at the top of this file: this
   * response is *about* a site, so its identifier is `id` — the same field name
   * GET /sites returns for the same entity.
   */
  id: z.uuid(),
  name: z.string(),
  emissionLimitKg: z.string(),
  totalEmissionsToDateKg: z.string(),
  measurementCount: z.number().int().nonnegative(),
  complianceStatus: complianceStatusSchema,
  /** Percentage of the limit consumed. Exceeds 100 when out of compliance. */
  utilizationPct: z.number(),
  last24hCh4Kg: z.string(),
  firstReadingAt: z.iso.datetime().nullable(),
  lastReadingAt: z.iso.datetime().nullable(),
});

export type SiteMetrics = z.infer<typeof siteMetricsSchema>;
