-- Denormalised first and last reading timestamps on the site row.
--
-- These were derived at read time with MIN(reading_ts) / MAX(reading_ts) over
-- `measurements` filtered only by site. With no bound on the partition key,
-- Postgres could prune nothing and every dashboard poll planned a scan of every
-- partition for that site — the one query in the read path that does not survive
-- the row counts this schema is partitioned for.
--
-- Maintained by the ingest transaction, exactly like total_emissions_to_date_kg,
-- and reconciled by db:verify for the same reason: a denormalised value can drift
-- and must be checkable against the rows it summarises.

ALTER TABLE "sites"
  ADD COLUMN "first_reading_at" timestamptz,
  ADD COLUMN "last_reading_at"  timestamptz;

-- Backfill. This is the expensive full scan, run once, rather than on every read.
UPDATE "sites" s
SET "first_reading_at" = m.first_at,
    "last_reading_at"  = m.last_at
FROM (
  SELECT site_id, MIN(reading_ts) AS first_at, MAX(reading_ts) AS last_at
  FROM "measurements"
  GROUP BY site_id
) m
WHERE m.site_id = s.id;

-- Nullable on purpose: a site with no readings has no first or last, and 0 or
-- epoch would both be lies. The API surfaces them as null.
