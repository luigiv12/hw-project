-- Emissions platform — initial schema.
--
-- Hand-written rather than generated: `measurements` is a RANGE-partitioned
-- table, which drizzle-kit cannot express. The Drizzle schema in src/db/schema.ts
-- mirrors this for query typing.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- sites
-- ---------------------------------------------------------------------------

CREATE TABLE "sites" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                        text NOT NULL,
  "emission_limit_kg"           numeric(14, 3) NOT NULL,
  "total_emissions_to_date_kg"  numeric(18, 4) NOT NULL DEFAULT 0,
  "measurement_count"           bigint NOT NULL DEFAULT 0,
  "version"                     integer NOT NULL DEFAULT 0,
  "metadata"                    jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),

  -- A negative limit is meaningless and a zero limit would put a site
  -- permanently in breach; reject both at the boundary.
  CONSTRAINT "sites_emission_limit_positive" CHECK ("emission_limit_kg" > 0),
  -- Emissions are cumulative and never decrease.
  CONSTRAINT "sites_total_non_negative" CHECK ("total_emissions_to_date_kg" >= 0)
);

-- ---------------------------------------------------------------------------
-- measurements — RANGE partitioned by month on reading_ts
-- ---------------------------------------------------------------------------
--
-- Partitioning targets the 100M+ row case from the brief. Time-range partitions
-- suit this workload because every access path is time-scoped: ingest writes to
-- the current month, dashboards read recent windows, and regulatory reporting
-- reads whole months. Old partitions can be detached and archived in constant
-- time rather than deleted row by row.
--
-- Postgres requires every UNIQUE/PRIMARY KEY on a partitioned table to include
-- the partition key, which is why reading_ts appears in both constraints below.

CREATE TABLE "measurements" (
  "id"          uuid NOT NULL DEFAULT gen_random_uuid(),
  "site_id"     uuid NOT NULL,
  "batch_id"    uuid NOT NULL,
  "device_id"   text NOT NULL,
  "reading_ts"  timestamptz NOT NULL,
  "ch4_kg"      numeric(14, 4) NOT NULL,
  "source"      text NOT NULL DEFAULT 'sensor',
  "created_at"  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT "measurements_pkey" PRIMARY KEY ("id", "reading_ts"),
  CONSTRAINT "measurements_ch4_non_negative" CHECK ("ch4_kg" >= 0),
  CONSTRAINT "measurements_source_valid"
    CHECK ("source" IN ('sensor', 'satellite', 'manual'))
) PARTITION BY RANGE ("reading_ts");

-- The natural key. This is what makes ingestion idempotent at the *reading*
-- level: the same physical reading cannot be stored twice no matter which batch
-- or idempotency key carries it. Ingest relies on this via ON CONFLICT DO
-- NOTHING and advances the site total only by rows actually inserted.
--
-- Declared on the parent, so Postgres creates and enforces it on every current
-- and future partition.
CREATE UNIQUE INDEX "measurements_site_device_ts_key"
  ON "measurements" ("site_id", "device_id", "reading_ts");

CREATE INDEX "measurements_site_ts_idx"
  ON "measurements" ("site_id", "reading_ts" DESC);

CREATE INDEX "measurements_batch_idx" ON "measurements" ("batch_id");

-- Foreign keys are declared on the parent and inherited by partitions.
ALTER TABLE "measurements"
  ADD CONSTRAINT "measurements_site_id_fkey"
  FOREIGN KEY ("site_id") REFERENCES "sites" ("id") ON DELETE CASCADE;

-- Creates the monthly partition covering `target`, if absent. Idempotent, so it
-- is safe to call on every ingest and from a scheduled job.
CREATE OR REPLACE FUNCTION create_month_partition(target date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  start_at  date := date_trunc('month', target)::date;
  end_at    date := (date_trunc('month', target) + interval '1 month')::date;
  part_name text := format('measurements_%s', to_char(start_at, 'YYYY_MM'));
BEGIN
  IF to_regclass(format('public.%I', part_name)) IS NOT NULL THEN
    RETURN;
  END IF;

  EXECUTE format(
    'CREATE TABLE %I PARTITION OF measurements FOR VALUES FROM (%L) TO (%L)',
    part_name, start_at, end_at
  );
END;
$$;

-- Safety net. Readings arriving outside any explicit partition — a sensor with a
-- wrong clock, a late backfill — land here instead of failing the insert. Losing
-- a measurement would be worse than storing it in a suboptimal place.
CREATE TABLE "measurements_default" PARTITION OF "measurements" DEFAULT;

-- Cover the window around first deployment so ordinary traffic never touches
-- the default partition.
SELECT create_month_partition((date_trunc('month', now()) + (n || ' month')::interval)::date)
FROM generate_series(-6, 6) AS n;

-- ---------------------------------------------------------------------------
-- ingestion_batches — request-level idempotency
-- ---------------------------------------------------------------------------

CREATE TABLE "ingestion_batches" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "site_id"             uuid NOT NULL REFERENCES "sites" ("id") ON DELETE CASCADE,
  "idempotency_key"     text NOT NULL,
  "request_hash"        text NOT NULL,
  "status"              text NOT NULL,
  "response_snapshot"   jsonb,
  "readings_submitted"  integer NOT NULL DEFAULT 0,
  "readings_accepted"   integer NOT NULL DEFAULT 0,
  "accepted_ch4_kg"     numeric(18, 4) NOT NULL DEFAULT 0,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "completed_at"        timestamptz,

  CONSTRAINT "ingestion_batches_status_valid"
    CHECK ("status" IN ('in_progress', 'completed', 'failed'))
);

-- The concurrency primitive behind the whole idempotency scheme. Under N
-- simultaneous retries of the same key, Postgres admits exactly one inserter;
-- the rest take the replay path.
CREATE UNIQUE INDEX "ingestion_batches_site_key_uniq"
  ON "ingestion_batches" ("site_id", "idempotency_key");

-- ---------------------------------------------------------------------------
-- outbox — transactional outbox for downstream alerting
-- ---------------------------------------------------------------------------

CREATE TABLE "outbox" (
  "id"              bigserial PRIMARY KEY,
  "aggregate_type"  text NOT NULL,
  "aggregate_id"    uuid NOT NULL,
  "event_type"      text NOT NULL,
  "payload"         jsonb NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "published_at"    timestamptz,
  "attempts"        integer NOT NULL DEFAULT 0,
  "last_error"      text
);

-- Partial index: the table accumulates history indefinitely, but the poller's
-- claim query only ever scans unpublished rows, so it stays fast as the table
-- grows.
CREATE INDEX "outbox_unpublished_idx"
  ON "outbox" ("id") WHERE "published_at" IS NULL;
