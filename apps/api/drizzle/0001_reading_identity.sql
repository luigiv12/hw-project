-- Producer-assigned reading identity.
--
-- 0000 keyed de-duplication on (site_id, device_id, reading_ts), which assumes a
-- device emits at most one reading per instant. Where that assumption fails —
-- a sensor sampling faster than its timestamp resolution, or one recovering from
-- a clock correction — a second legitimate reading was silently discarded.
--
-- Silently discarding a measurement misstates a regulatory total exactly as
-- badly as counting one twice, and is harder to detect. This migration lets the
-- producer state identity explicitly, because only the producer knows whether
-- two readings describe the same physical event.

ALTER TABLE "measurements" ADD COLUMN "reading_id" text;

-- The natural key now applies ONLY when the producer did not supply an identity.
-- Without this the fallback index would still block two distinct readings that
-- share a device and timestamp, defeating the new column.
DROP INDEX "measurements_site_device_ts_key";

CREATE UNIQUE INDEX "measurements_site_device_ts_key"
  ON "measurements" ("site_id", "device_id", "reading_ts")
  WHERE "reading_id" IS NULL;

-- Authoritative when present. Partial and complementary to the index above, so
-- exactly one of the two governs any given row.
CREATE UNIQUE INDEX "measurements_site_reading_id_key"
  ON "measurements" ("site_id", "reading_id", "reading_ts")
  WHERE "reading_id" IS NOT NULL;
