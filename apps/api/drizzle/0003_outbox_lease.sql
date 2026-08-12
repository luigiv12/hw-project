-- Outbox delivery lease.
--
-- `FOR UPDATE SKIP LOCKED` only excludes concurrent claimers for as long as the
-- claiming transaction is open. Delivery happens over the network, far outside
-- that transaction, so the lock cannot cover it — the claim has to leave a mark
-- in the row itself that outlives the transaction that took it.
--
-- `claimed_at` is that mark. A dispatcher takes a row by stamping it, and rows
-- stamped within the lease window are invisible to other dispatchers. A
-- dispatcher that crashes mid-delivery stamps nothing further, so the lease
-- lapses and the row returns to the queue rather than being stranded.

ALTER TABLE outbox ADD COLUMN claimed_at timestamptz;

-- The claim query filters on `published_at IS NULL` first and orders by id, so
-- the existing partial index still drives it; `claimed_at` and `attempts` narrow
-- within the already-small unpublished set.
COMMENT ON COLUMN outbox.claimed_at IS
  'When a dispatcher last took this row for delivery. Rows claimed within the lease window are skipped by other dispatchers; a lapsed lease means the claimer died and the row is retryable.';
