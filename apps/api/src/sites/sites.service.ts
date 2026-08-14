import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import {
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
import { complianceFor } from '../common/compliance';

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
   * The 24-hour window genuinely is aggregated, but it is closed at both ends,
   * so it touches at most two monthly partitions and is bounded by the site+time
   * index.
   */
  async getMetrics(id: string): Promise<SiteMetrics> {
    const site = await this.requireSite(id);

    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    /**
     * The only aggregate on this path, and it is closed at both ends.
     *
     * The upper bound is doing real work. Nothing rejects a reading timestamped
     * in the future — a device with a skewed clock produces them — and an
     * open-ended window would count those as "the last 24 hours" indefinitely,
     * however far ahead they sit. It also restores partition pruning: with only
     * a lower bound Postgres must consider every partition from `since` forward,
     * including DEFAULT and any future months, rather than the one or two the
     * window actually spans.
     *
     * The cumulative total, the row count, and the reading span all come from
     * the site row, maintained transactionally by ingest.
     */
    const [recent] = await this.db
      .select({
        sumKg: sql<string>`coalesce(sum(${measurements.ch4Kg}), 0)::text`,
      })
      .from(measurements)
      .where(
        and(
          eq(measurements.siteId, id),
          gte(measurements.readingTs, since),
          lte(measurements.readingTs, now),
        ),
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

function toSite(row: SiteRow): Site {
  return {
    id: row.id,
    name: row.name,
    emissionLimitKg: row.emissionLimitKg,
    totalEmissionsToDateKg: row.totalEmissionsToDateKg,
    measurementCount: row.measurementCount,
    complianceStatus: complianceFor(
      row.totalEmissionsToDateKg,
      row.emissionLimitKg,
    ),
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
