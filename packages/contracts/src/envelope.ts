import { z } from 'zod';
import { ErrorCode } from './errors.js';

/**
 * Every response from the platform — success or failure — carries this shape.
 *
 * The spec calls a unified response structure a "Platform Goal" for a
 * multi-team environment, so it is defined once here and applied globally by a
 * NestJS interceptor and exception filter rather than by each controller.
 */

/**
 * Pagination, carried in `meta` rather than in `data`.
 *
 * Keeping `data` a bare array means a client that does not paginate reads the
 * same field as one that does, and adding pagination to an endpoint never
 * changes the shape of its payload.
 *
 * Cursors are keyset, not offsets: an offset shifts when rows are inserted or
 * reordered between pages, silently skipping or repeating records. The cursor is
 * opaque — its encoding is an implementation detail and clients must treat it as
 * a token to hand back, never parse.
 */
export const pageMetaSchema = z.object({
  limit: z.number().int().positive(),
  /** Present only when more rows exist. Absent means this is the last page. */
  nextCursor: z.string().nullable(),
});

export type PageMeta = z.infer<typeof pageMetaSchema>;

export const metaSchema = z.object({
  /** Correlates a response with its server-side log lines. */
  requestId: z.string(),
  timestamp: z.iso.datetime(),
  /** Present on collection endpoints only. */
  page: pageMetaSchema.optional(),
});

export type ResponseMeta = z.infer<typeof metaSchema>;

/**
 * Query parameters every paginated collection accepts.
 *
 * `limit` is capped rather than trusted: an unbounded collection endpoint is one
 * request away from being a denial-of-service against itself.
 */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

export const paginationQuerySchema = z.object({
  limit: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

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
