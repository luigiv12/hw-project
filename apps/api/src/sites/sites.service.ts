import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import {
  ComplianceStatus,
  ErrorCode,
  type CreateSiteInput,
  type Site,
  type SiteMetrics,
} from '@emissions/contracts';
import { DB, type Database } from '../db/db.module';
import { measurements, sites, type SiteRow } from '../db/schema';
import { AppException } from '../common/app.exception';

@Injectable()
export class SitesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(input: CreateSiteInput): Promise<Site> {
    const [row] = await this.db
      .insert(sites)
      .values({
        name: input.name,
        emissionLimitKg: input.emissionLimitKg,
        metadata: input.metadata,
      })
      .returning();

    return toSite(row);
  }

  /**
   * All sites, in a total order.
   *
   * `id` is a tiebreak rather than decoration: sites created in the same
   * transaction share a `created_at`, and any ordering with ties lets Postgres
   * return rows in whatever order the scan produces — which changes when a row
   * is updated. The dashboard polls this endpoint continuously, so the order
   * must not depend on write history.
   */
  async findAll(): Promise<Site[]> {
    const rows = await this.db
      .select()
      .from(sites)
      .orderBy(asc(sites.name), asc(sites.id));

    return rows.map(toSite);
  }

  async findOne(id: string): Promise<Site> {
    return toSite(await this.requireSite(id));
  }

  /**
   * Site performance summary including compliance status.
   *
   * The cumulative total is read from the denormalised column on the site row —
   * maintained transactionally by ingest — rather than aggregated from
   * measurements. At the 100M-row scale this system is designed for, summing the
   * partitions on every dashboard poll would not be viable.
   *
   * The 24-hour window genuinely is aggregated, but it touches at most two
   * monthly partitions and is bounded by the site+time index.
   */
  async getMetrics(id: string): Promise<SiteMetrics> {
    const site = await this.requireSite(id);

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [window] = await this.db
      .select({
        last24hCh4Kg: sql<string>`coalesce(sum(${measurements.ch4Kg}), 0)::text`,
        firstReadingAt: sql<Date | null>`min(${measurements.readingTs})`,
        lastReadingAt: sql<Date | null>`max(${measurements.readingTs})`,
      })
      .from(measurements)
      .where(eq(measurements.siteId, id));

    const [recent] = await this.db
      .select({
        sumKg: sql<string>`coalesce(sum(${measurements.ch4Kg}), 0)::text`,
      })
      .from(measurements)
      .where(
        and(eq(measurements.siteId, id), gte(measurements.readingTs, since)),
      );

    const totalKg = Number(site.totalEmissionsToDateKg);
    const limitKg = Number(site.emissionLimitKg);

    return {
      id: site.id,
      name: site.name,
      emissionLimitKg: site.emissionLimitKg,
      totalEmissionsToDateKg: site.totalEmissionsToDateKg,
      measurementCount: site.measurementCount,
      complianceStatus: complianceFor(
        site.totalEmissionsToDateKg,
        site.emissionLimitKg,
      ),
      utilizationPct: Number(((totalKg / limitKg) * 100).toFixed(2)),
      last24hCh4Kg: recent?.sumKg ?? '0',
      firstReadingAt: window?.firstReadingAt
        ? new Date(window.firstReadingAt).toISOString()
        : null,
      lastReadingAt: window?.lastReadingAt
        ? new Date(window.lastReadingAt).toISOString()
        : null,
    };
  }

  private async requireSite(id: string): Promise<SiteRow> {
    const [row] = await this.db.select().from(sites).where(eq(sites.id, id));

    if (!row) {
      throw new AppException(
        ErrorCode.SITE_NOT_FOUND,
        `No site exists with id ${id}`,
      );
    }

    return row;
  }
}

/**
 * Compliance comparison.
 *
 * Compared as decimal strings via BigInt rather than as JS numbers: this is the
 * boundary that decides whether a site is reported as in breach, and it should
 * not depend on binary floating-point rounding. A site exactly at its limit is
 * *within* it — the spec's language is "Limit Exceeded", which requires strictly
 * greater.
 */
export function complianceFor(
  totalKg: string,
  limitKg: string,
): ComplianceStatus {
  return compareDecimalStrings(totalKg, limitKg) > 0
    ? ComplianceStatus.LIMIT_EXCEEDED
    : ComplianceStatus.WITHIN_LIMIT;
}

/** Returns >0 if a > b, 0 if equal, <0 if a < b. Exact for decimal strings. */
export function compareDecimalStrings(a: string, b: string): number {
  const [aInt, aFrac = ''] = a.split('.');
  const [bInt, bFrac = ''] = b.split('.');

  const width = Math.max(aFrac.length, bFrac.length);
  const aScaled = BigInt(aInt + aFrac.padEnd(width, '0'));
  const bScaled = BigInt(bInt + bFrac.padEnd(width, '0'));

  return aScaled === bScaled ? 0 : aScaled > bScaled ? 1 : -1;
}

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    emissionLimitKg: row.emissionLimitKg,
    totalEmissionsToDateKg: row.totalEmissionsToDateKg,
    measurementCount: row.measurementCount,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
