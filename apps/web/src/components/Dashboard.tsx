'use client';

import { useCallback, useEffect, useState } from 'react';
import type { Site } from '@emissions/contracts';
import { listSites } from '@/lib/api';
import { SitesTable } from './SitesTable';
import { IngestForm } from './IngestForm';

/** Dashboard refresh cadence. See ARCHITECTURE.md → Interpretations. */
const POLL_MS = 5_000;

export function Dashboard({
  initialSites,
  bootError,
}: {
  initialSites: Site[];
  bootError: string | null;
}) {
  const [sites, setSites] = useState<Site[]>(initialSites);
  const [error, setError] = useState<string | null>(bootError);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(
    initialSites.length ? new Date() : null,
  );

  const refresh = useCallback(async () => {
    try {
      setSites(await listSites());
      setUpdatedAt(new Date());
      setError(null);
    } catch (err: unknown) {
      // Keep showing the last good data rather than blanking the table — stale
      // figures with a visible warning are more useful to an operator than an
      // empty screen.
      setError(
        err instanceof Error ? err.message : 'Could not reach the emissions API',
      );
    }
  }, []);

  useEffect(() => {
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  return (
    <div className="stack">
      {error && (
        <div className="alert error">
          <strong>Not receiving updates</strong>
          {error}
          {sites.length > 0 && ' — showing the last figures received.'}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Monitored sites</h2>
          <span className="live">
            <span
              className="em-status-dot"
              style={{ background: error ? 'var(--danger)' : 'var(--ok)' }}
            />
            {error
              ? 'stale'
              : updatedAt
                ? `updated ${updatedAt.toLocaleTimeString()}`
                : 'loading…'}
          </span>
        </div>
        <SitesTable sites={sites} />
      </div>

      {sites.length > 0 && (
        // Refresh immediately after a submission rather than waiting for the
        // next poll — watching your own successful submission not appear for
        // five seconds reads as a bug.
        <IngestForm sites={sites} onIngested={() => void refresh()} />
      )}
    </div>
  );
}
