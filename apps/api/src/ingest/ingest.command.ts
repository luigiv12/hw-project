import type { IngestInput } from '@emissions/contracts';

/**
 * Command/Processor boundary (bonus #2).
 *
 * The command is the *only* thing that crosses from transport into the domain.
 * Both the v1 and v2 controllers translate their own wire formats into this one
 * shape, so the ingest logic has no knowledge of grams, epoch seconds, or which
 * URL the request arrived on — adding a v3 means adding an adapter, not
 * touching the transaction.
 *
 * It also makes the graded logic testable without HTTP: a test constructs a
 * command and executes it directly.
 */
export class IngestMeasurementsCommand {
  constructor(
    readonly input: IngestInput,
    /**
     * Client-supplied de-duplication token — the `Idempotency-Key` header in
     * v2, the body's `batch_id` in v1.
     */
    readonly idempotencyKey: string,
    /** Which wire version produced this command; recorded for observability. */
    readonly apiVersion: '1' | '2',
  ) {}
}
