import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, sql } from 'drizzle-orm';
import {
  ComplianceStatus,
  ErrorCode,
  type CreateSiteInput,
  type PaginationQuery,
  type Site,
  type SiteMetrics,
} from '@emissions/contracts';
import { DB, type Database } from '../db/db.module';
import { measurements, sites, type SiteRow } from '../db/schema';
import { AppException } from '../common/app.exception';
import { Paginated, decodeCursor, encodeCursor } from '../common/paginated';

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
   * A page of sites, in a total order.
   *
   * `id` is a tiebreak rather than decoration: sites created in the same
   * transaction share a `created_at`, and any ordering with ties lets Postgres
   * return rows in whatever order the scan produces — which changes when a row
   * is updated. A stable total order is what makes keyset pagination correct as
   * well as making the listing itself readable.
   *
   * Pages are fetched by sort key, not by offset. `(name, id) > (cursor)` is a
   * row-value comparison that lands on an index and stays correct while rows are
   * being inserted — where an offset would skip or repeat records as the
   * collection shifts underneath it.
   */
  async findPage(query: PaginationQuery): Promise<Paginated<Site>> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;

    if (query.cursor && !after) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'The cursor is not valid. Pass a nextCursor from a previous response, or omit it to start from the beginning.',
        [{ path: 'cursor', message: 'malformed' }],
      );
    }

    // One extra row answers "is there another page?" without a second count
    // query, and is discarded before the results are returned.
    const rows = await this.db
      .select()
      .from(sites)
      .where(
        after
          ? sql`(${sites.name}, ${sites.id}) > (${after.name}, ${after.id}::uuid)`
          : undefined,
      )
      .orderBy(asc(sites.name), asc(sites.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page.at(-1);

    return new Paginated(page.map(toSite), {
      limit: query.limit,
      nextCursor: hasMore && last ? encodeCursor(last.name, last.id) : null,
    });
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

    /**
     * The only aggregate on this path, and it is bounded by `reading_ts`, so
     * Postgres prunes to the one or two partitions the window spans. The
     * cumulative total, the row count, and the reading span all come from the
     * site row, maintained transactionally by ingest.
     */
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
      firstReadingAt: site.firstReadingAt?.toISOString() ?? null,
      lastReadingAt: site.lastReadingAt?.toISOString() ?? null,
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
 * *within* it — "Limit Exceeded" requires strictly greater.
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
