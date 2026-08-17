-- Scope producer-assigned reading identity per device.
--
-- 0001 keyed identified readings on (site_id, reading_id, reading_ts). Two
-- problems with that, and only the second is fixable with an index.
--
-- 1. Per-site scope. A producer assigning ids emits a device-local counter
--    (1, 2, 3…), so device B's reading "1" collided with device A's "1". Per-site
--    uniqueness is only correct if every id is globally unique across the site —
--    a UUID or ULID — which the contract never required.
--
-- 2. Scoped per timestamp. `reading_ts` is the partition key, and Postgres
--    requires the partition key in every unique constraint on a partitioned
--    table, so ('r-1', 10:00) and ('r-1', 11:00) are distinct entries. The same
--    reading re-sent under a corrected clock was stored and counted twice —
--    which is precisely the case the contract tells producers to send a
--    readingId for.
--
-- This migration fixes (1) by adding device_id to the key. It CANNOT fix (2):
-- no index on this table can omit reading_ts. Enforcement for (2) lives in the
-- ingest transaction, which looks the identity up across all timestamps before
-- inserting; the (site_id, device_id, reading_id) prefix of the index below is
-- what makes that lookup indexable rather than a scan of the site's history.
--
-- Not dropped with IF EXISTS on purpose. The index name is the one thing here
-- that is easy to get wrong, and a silent no-op would leave the old constraint
-- enforced while appearing to succeed.

DROP INDEX "measurements_site_reading_id_key";

CREATE UNIQUE INDEX "measurements_site_device_reading_id_ts_key"
  ON "measurements" ("site_id", "device_id", "reading_id", "reading_ts")
  WHERE "reading_id" IS NOT NULL;

-- Strictly weaker than the index it replaces — more columns means fewer
-- collisions — so it cannot fail against existing rows. Declared on the parent,
-- so Postgres builds and enforces it on every current and future partition.
