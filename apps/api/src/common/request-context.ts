import { AsyncLocalStorage } from 'node:async_hooks';

export type RequestContext = {
  requestId: string;
};

/**
 * Per-request context, propagated without threading a parameter through every
 * layer.
 *
 * Used for the request id that appears in every log line and every response
 * envelope, so a user reporting "my ingest failed" can be traced to exact log
 * lines from the id they were shown.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequestId(): string {
  return requestContext.getStore()?.requestId ?? 'unknown';
}
