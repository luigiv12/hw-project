import type { PageMeta } from '@emissions/contracts';

/**
 * A page of results returned from a handler.
 *
 * Controllers return this instead of a bare array; the response interceptor
 * recognises it, unwraps the items into `data`, and moves the page details into
 * `meta.page`. That keeps pagination out of every controller — a handler
 * declares that it paginates and the envelope handles the rest.
 */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly page: PageMeta,
  ) {}
}

/**
 * Encodes the sort key of the last row on a page.
 *
 * base64url of the ordering columns, so the value is opaque at the boundary and
 * clients are not tempted to construct or interpret one. Not a security
 * measure — it is a compatibility one, leaving the ordering free to change
 * without breaking clients that stored a cursor.
 */
export function encodeCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify([name, id]), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { name: string; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );

    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    ) {
      return null;
    }

    return { name: parsed[0], id: parsed[1] };
  } catch {
    return null;
  }
}
