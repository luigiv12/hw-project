import { z } from 'zod';
import { MAX_BATCH_SIZE, type IngestInput } from './schemas.js';

/**
 * v1 — the wire format older field sensors already speak.
 *
 * These devices are deployed in the field and will not be reflashed on our
 * schedule, so v1 is frozen: snake_case keys, numeric readings, a `batch_id`
 * in the body instead of an `Idempotency-Key` header, and no `source` field.
 *
 * It is kept as a separate schema rather than bolted onto v2 with optional
 * fields. An anti-corruption layer (`fromLegacyIngest`) translates it into the
 * internal command at the edge, so exactly one shape reaches the domain and v1
 * quirks cannot leak inward.
 */
export const legacyIngestSchemaV1 = z.object({
  site_id: z.uuid(),
  /** Older firmware puts the idempotency token in the body. */
  batch_id: z.uuid(),
  readings: z
    .array(
      z.object({
        device_id: z.string().trim().min(1).max(100),
        /** Unix epoch seconds — v1 predates the move to ISO-8601. */
        ts: z.number().int().positive(),
        /** Grams, not kilograms. The unit change came with v2. */
        ch4_g: z.number().nonnegative(),
      }),
    )
    .min(1)
    .max(MAX_BATCH_SIZE),
});

export type LegacyIngestV1 = z.infer<typeof legacyIngestSchemaV1>;

/**
 * Anti-corruption layer: v1 wire format → internal command.
 *
 * Grams convert to kilograms via string manipulation rather than division, so a
 * reading never picks up a floating-point representation error on the way in.
 */
export function fromLegacyIngest(body: LegacyIngestV1): {
  input: IngestInput;
  idempotencyKey: string;
} {
  return {
    idempotencyKey: body.batch_id,
    input: {
      siteId: body.site_id,
      readings: body.readings.map((r) => ({
        deviceId: r.device_id,
        readingTs: new Date(r.ts * 1000).toISOString(),
        ch4Kg: gramsToKilogramsExact(r.ch4_g),
        source: 'sensor' as const,
      })),
    },
  };
}

/**
 * Shift a decimal three places left without going through binary floating point.
 * `8.2 / 1000` evaluates to 0.008199999999999999; this returns "0.0082".
 *
 * The artifact only bites for fractional gram values — every integer gram count
 * divides cleanly — which is exactly what makes it a bad bug to leave in place:
 * it survives casual testing and then shows up in a regulatory total.
 */
export function gramsToKilogramsExact(grams: number): string {
  const [intPart, fracPart = ''] = String(grams).split('.');
  const digits = (intPart + fracPart).replace(/^0+(?=\d)/, '');
  const pointFromRight = fracPart.length + 3;
  const padded = digits.padStart(pointFromRight + 1, '0');
  const cut = padded.length - pointFromRight;
  const result = `${padded.slice(0, cut)}.${padded.slice(cut)}`.replace(
    /\.?0+$/,
    '',
  );
  return result === '' || result === '-' ? '0' : result;
}
