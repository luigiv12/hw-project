/**
 * Canonical error codes for the platform.
 *
 * The frontend switches on these codes, never on message strings — messages are
 * for humans and may be reworded at any time without it counting as a breaking
 * change. Adding a code is backwards-compatible; changing or removing one is not.
 */
export const ErrorCode = {
  /** Request body or params failed schema validation. Details carry field paths. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** No route matches. Distinct from a missing resource. */
  NOT_FOUND: 'NOT_FOUND',
  /** No site exists with the given id. */
  SITE_NOT_FOUND: 'SITE_NOT_FOUND',
  /** Batch exceeded the per-request reading limit. */
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  /**
   * The same Idempotency-Key arrived with a *different* payload. This is a
   * client bug — silently accepting it would let a retry overwrite a distinct
   * batch — so it is surfaced rather than absorbed.
   */
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED',
  /**
   * A batch with this key is mid-flight on another connection. The client should
   * retry after a short delay; the in-flight request will produce the response.
   */
  BATCH_IN_PROGRESS: 'BATCH_IN_PROGRESS',
  /** Credentials are missing or wrong on an endpoint that requires them. */
  UNAUTHORIZED: 'UNAUTHORIZED',
  /** Too many requests from this client. */
  RATE_LIMITED: 'RATE_LIMITED',
  /** Unhandled server-side failure. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** HTTP status paired with each code, so the mapping lives in one place. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.SITE_NOT_FOUND]: 404,
  [ErrorCode.BATCH_TOO_LARGE]: 400,
  [ErrorCode.IDEMPOTENCY_KEY_REUSED]: 409,
  [ErrorCode.BATCH_IN_PROGRESS]: 409,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.INTERNAL_ERROR]: 500,
};
