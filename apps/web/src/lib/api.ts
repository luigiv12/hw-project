import type {
  ApiError,
  IngestInput,
  IngestResult,
  Site,
  SiteMetrics,
} from '@emissions/contracts';

/**
 * Typed client for the emissions API.
 *
 * Every response is unwrapped from the platform envelope in one place, so
 * components deal in domain objects and never in `{ data, meta }`. Failures
 * become `ApiRequestError`, which preserves the machine-readable `code` — the UI
 * branches on codes, never on message text.
 */

/**
 * Where the API lives — which differs depending on who is asking.
 *
 * Server Components run inside the container and must use the compose service
 * name (`http://api:3000`). The browser runs on the host and must use the
 * published port (`http://localhost:3000`); `api` means nothing to it.
 *
 * Using one value for both is the classic containerised-Next.js failure: pick
 * the internal name and every client fetch fails in the browser, pick localhost
 * and server rendering fails because localhost is the web container itself.
 *
 * NEXT_PUBLIC_* is inlined into the client bundle at build time, so it must be
 * the browser-reachable URL.
 */
export const API_BASE =
  typeof window === 'undefined'
    ? (process.env.API_URL_INTERNAL ??
      process.env.NEXT_PUBLIC_API_URL ??
      'http://localhost:3000')
    : (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000');

export class ApiRequestError extends Error {
  constructor(
    readonly apiError: ApiError,
    readonly status: number,
    readonly requestId: string | null,
  ) {
    super(apiError.message);
    this.name = 'ApiRequestError';
  }

  get code(): string {
    return this.apiError.code;
  }
}

/** Raised when the request never produced a usable response at all. */
export class NetworkError extends Error {
  constructor(message = 'Could not reach the API') {
    super(message);
    this.name = 'NetworkError';
  }
}

type Meta = {
  requestId: string;
  timestamp: string;
  page?: { limit: number; nextCursor: string | null };
};

type Envelope<T> = { data: T; meta: Meta } | { error: ApiError; meta: Meta };

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<{ value: T; meta: Meta; headers: Headers }> {
  let res: Response;

  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...init?.headers },
      cache: 'no-store',
    });
  } catch {
    throw new NetworkError();
  }

  let body: Envelope<T>;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    throw new NetworkError(`API returned a non-JSON response (${res.status})`);
  }

  if ('error' in body) {
    throw new ApiRequestError(
      body.error,
      res.status,
      res.headers.get('x-request-id'),
    );
  }

  return { value: body.data, meta: body.meta, headers: res.headers };
}

/** Matches the API's cap, so a full listing costs as few round trips as possible. */
const PAGE_SIZE = 200;

/**
 * Every site, following the cursor to the end.
 *
 * The dashboard shows a complete picture of the estate, so it walks all pages
 * rather than displaying whichever ones happened to fit in the first response.
 * The loop is bounded: a client that trusts a server to eventually return a null
 * cursor is one bug away from spinning forever.
 */
export async function listSites(): Promise<Site[]> {
  const sites: Site[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 100; page++) {
    const path: string = cursor
      ? `/sites?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
      : `/sites?limit=${PAGE_SIZE}`;

    const res: { value: Site[]; meta: Meta } = await request<Site[]>(path);
    sites.push(...res.value);

    cursor = res.meta.page?.nextCursor ?? null;
    if (!cursor) return sites;
  }

  return sites;
}

export async function getSiteMetrics(id: string): Promise<SiteMetrics> {
  return (await request<SiteMetrics>(`/sites/${id}/metrics`)).value;
}

/**
 * Submits a batch.
 *
 * `idempotencyKey` is supplied by the caller rather than generated here — that
 * is the whole mechanism. A retry must reuse the key from the attempt that
 * failed, so ownership of the key belongs to the component tracking the attempt,
 * not to the transport.
 */
export async function ingest(
  payload: IngestInput,
  idempotencyKey: string,
): Promise<{ result: IngestResult; replayed: boolean }> {
  const { value, headers } = await request<IngestResult>('/v2/ingest', {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify(payload),
  });

  return {
    result: value,
    replayed: headers.get('x-idempotent-replay') === 'true',
  };
}
