import { Dashboard } from '@/components/Dashboard';
import { listSites } from '@/lib/api';
import type { Site } from '@emissions/contracts';

/**
 * Always rendered fresh — a cached compliance figure is a wrong compliance
 * figure.
 */
export const dynamic = 'force-dynamic';

export default async function Page() {
  let initialSites: Site[] = [];
  let bootError: string | null = null;

  /**
   * The initial fetch runs on the server so the first paint already carries
   * data. If the API is down we still render the shell with an explanation —
   * a dashboard that renders nothing at all tells an operator less than one
   * that says why it is empty.
   */
  try {
    initialSites = await listSites();
  } catch (err: unknown) {
    bootError =
      err instanceof Error ? err.message : 'Could not reach the emissions API';
  }

  return (
    <>
      <header className="masthead">
        <h1>Emissions Monitoring</h1>
        <p>Methane ingestion and compliance status across monitored sites</p>
      </header>

      <Dashboard initialSites={initialSites} bootError={bootError} />
    </>
  );
}
