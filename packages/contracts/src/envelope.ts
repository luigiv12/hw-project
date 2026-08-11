import { z } from 'zod';
import { ErrorCode } from './errors.js';

/**
 * Every response from the platform — success or failure — carries this shape.
 *
 * The spec calls a unified response structure a "Platform Goal" for a
 * multi-team environment, so it is defined once here and applied globally by a
 * NestJS interceptor and exception filter rather than by each controller.
 */

export const metaSchema = z.object({
  /** Correlates a response with its server-side log lines. */
  requestId: z.string(),
  timestamp: z.iso.datetime(),
});

export type ResponseMeta = z.infer<typeof metaSchema>;

export const apiErrorSchema = z.object({
  code: z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]),
  message: z.string(),
  /** Field-level validation failures; empty for non-validation errors. */
  details: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .default([]),
});

export type ApiError = z.infer<typeof apiErrorSchema>;

export const successEnvelope = <T extends z.ZodType>(data: T) =>
  z.object({ data, meta: metaSchema });

export const errorEnvelope = z.object({
  error: apiErrorSchema,
  meta: metaSchema,
});

export type SuccessEnvelope<T> = { data: T; meta: ResponseMeta };
export type ErrorEnvelope = z.infer<typeof errorEnvelope>;
export type Envelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

/** Narrows an envelope to its error branch. */
export function isErrorEnvelope<T>(e: Envelope<T>): e is ErrorEnvelope {
  return 'error' in e;
}
