'use client';

import { ComplianceStatus, type Site } from '@emissions/contracts';

/**
 * Display-only, so float is fine here: this drives the width of a bar, and no
 * decision rests on it. `site.complianceStatus` is the authority on whether a
 * site is in breach, decided server-side in exact decimal — a bar that rounds
 * to 100% and a badge that says "Within Limit" is the correct rendering of a
 * site sitting exactly at its limit.
 */
function utilisation(site: Site): number {
  const limit = Number(site.emissionLimitKg);
  if (!limit) return 0;
  return (Number(site.totalEmissionsToDateKg) / limit) * 100;
}

const kg = (v: string) =>
  Number(v).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

export function SitesTable({ sites }: { sites: Site[] }) {
  if (sites.length === 0) {
    return (
      <div className="card-body">
        <p style={{ color: 'var(--text-dim)', margin: 0 }}>
          No sites yet. Seed the database with{' '}
          <code className="mono">pnpm db:seed</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Site</th>
            <th style={{ textAlign: 'right' }}>Total CH₄</th>
            <th style={{ textAlign: 'right' }}>Limit</th>
            <th>Utilisation</th>
            <th style={{ textAlign: 'right' }}>Readings</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => {
            const pct = utilisation(site);
            const status = site.complianceStatus;
            const over = status === ComplianceStatus.LIMIT_EXCEEDED;
            const operator =
              typeof site.metadata?.operator === 'string'
                ? site.metadata.operator
                : null;

            return (
              <tr key={site.id}>
                <td>
                  <div className="site-name">{site.name}</div>
                  {operator && <div className="site-meta">{operator}</div>}
                </td>
                <td className="num">{kg(site.totalEmissionsToDateKg)}</td>
                <td className="num">{kg(site.emissionLimitKg)}</td>
                <td>
                  <div className="util">
                    <div className="util-track">
                      <div
                        className={`util-fill${over ? ' over' : pct >= 80 ? ' warn' : ''}`}
                        // Bar caps at 100% width; the numeric label carries the
                        // real figure, so a site at 130% is not misread as
                        // merely "full".
                        style={{ width: `${Math.min(pct, 100)}%` }}
                      />
                    </div>
                    <span className="util-pct">{pct.toFixed(0)}%</span>
                  </div>
                </td>
                <td className="num">
                  {site.measurementCount.toLocaleString()}
                </td>
                <td>
                  <span className={`badge ${over ? 'over' : 'ok'}`}>
                    {status}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
