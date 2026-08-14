import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComplianceStatus, type Site } from '@emissions/contracts';
import { ApiRequestError, NetworkError, listSites } from './api';

const site = (name: string): Site => ({
  id: `0a5b1c2d-0000-4000-8000-${name.padStart(12, '0')}`,
  name,
  emissionLimitKg: '1000.000',
  totalEmissionsToDateKg: '0.0000',
  measurementCount: 0,
  complianceStatus: ComplianceStatus.WITHIN_LIMIT,
  metadata: {},
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
});

const envelope = (data: unknown, nextCursor: string | null = null) => ({
  ok: true,
  status: 200,
  headers: new Headers(),
  json: async () => ({
    data,
    meta: {
      requestId: 'test',
      timestamp: '2026-08-01T00:00:00.000Z',
      page: { limit: 200, nextCursor },
    },
  }),
});

afterEach(() => vi.unstubAllGlobals());

describe('listSites', () => {
  it('returns a single page without asking for another', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(envelope([site('a'), site('b')]));
    vi.stubGlobal('fetch', fetchMock);

    const sites = await listSites();

    expect(sites.map((s) => s.name)).toEqual(['a', 'b']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows the cursor until it is exhausted', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(envelope([site('a')], 'cursor-1'))
      .mockResolvedValueOnce(envelope([site('b')], 'cursor-2'))
      .mockResolvedValueOnce(envelope([site('c')], null));
    vi.stubGlobal('fetch', fetchMock);

    const sites = await listSites();

    // The dashboard shows the whole estate, not whichever sites fit in the
    // first response.
    expect(sites.map((s) => s.name)).toEqual(['a', 'b', 'c']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('passes the cursor back verbatim, url-encoded', async () => {
    const cursor = 'WyJhIiwiYiJd+/=';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(envelope([site('a')], cursor))
      .mockResolvedValueOnce(envelope([site('b')], null));
    vi.stubGlobal('fetch', fetchMock);

    await listSites();

    const secondUrl = String(fetchMock.mock.calls[1][0]);
    expect(secondUrl).toContain(`cursor=${encodeURIComponent(cursor)}`);
  });

  it('stops rather than looping forever if the cursor never clears', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(envelope([site('a')], 'always'));
    vi.stubGlobal('fetch', fetchMock);

    const sites = await listSites();

    // A client that trusts the server to eventually return null is one bug away
    // from spinning forever.
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(100);
    expect(sites.length).toBeLessThanOrEqual(100);
  });

  it('raises a typed error carrying the API error code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({
          error: { code: 'SITE_NOT_FOUND', message: 'nope', details: [] },
          meta: { requestId: 'r', timestamp: '2026-08-01T00:00:00.000Z' },
        }),
      }),
    );

    await expect(listSites()).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('raises a network error when the request never completes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(listSites()).rejects.toBeInstanceOf(NetworkError);
  });
});
