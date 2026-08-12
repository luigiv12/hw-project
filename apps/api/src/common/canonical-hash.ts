import { createHash } from 'node:crypto';
import type { IngestInput } from '@emissions/contracts';

/**
 * Fingerprints an ingest request so a retry can be recognised as the same
 * batch, and a *different* batch reusing the same key can be rejected.
 *
 * Canonicalised rather than hashed from the raw body, because a retry is not
 * guaranteed to be byte-identical — a client may reserialise, reorder JSON keys,
 * or resend readings in a different order. Hashing the raw body would classify
 * those as key reuse and reject a legitimate retry, which is exactly the failure
 * this system must not have.
 *
 * Readings are sorted before hashing, so the same set of readings in a different
 * order is the same batch. Object keys are written in a fixed order rather than
 * relying on JSON.stringify's insertion order.
 */
export function hashIngestRequest(input: IngestInput): string {
  const readings = [...input.readings]
    .map((r) => ({
      /**
       * A supplied `readingId` is the reading's identity, so it participates in
       * the fingerprint. Readings matching on device, instant and mass are still
       * separate measurements when their ids differ.
       */
      i: r.readingId ?? '',
      // Timestamps are normalised to epoch millis so that equivalent ISO-8601
      // spellings of the same instant — differing offsets, trailing 'Z' versus
      // '+00:00' — hash identically.
      d: r.deviceId,
      t: new Date(r.readingTs).getTime(),
      // Trailing zeros are insignificant in a decimal quantity: "5.50" and "5.5"
      // are the same mass and must not produce different fingerprints.
      c: normaliseDecimal(r.ch4Kg),
      s: r.source,
    }))
    .sort(
      (a, b) =>
        a.i.localeCompare(b.i) ||
        a.d.localeCompare(b.d) ||
        a.t - b.t ||
        a.c.localeCompare(b.c),
    );

  const canonical = JSON.stringify({ siteId: input.siteId, readings });

  return createHash('sha256').update(canonical).digest('hex');
}

/** "5.50" -> "5.5", "5.000" -> "5", "0.10" -> "0.1" */
export function normaliseDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}
