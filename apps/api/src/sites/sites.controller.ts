import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import {
  createSiteSchema,
  paginationQuerySchema,
  type CreateSiteInput,
  type PaginationQuery,
  type Site,
  type SiteMetrics,
} from '@emissions/contracts';
import { SitesService } from './sites.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { Paginated } from '../common/paginated';

/**
 * Site management and analytics.
 *
 * Answers on the unversioned path as well as v1 and v2: these endpoints are
 * identical across versions, so there is nothing to disambiguate, and the
 * unversioned URLs keep working. `/ingest` is the endpoint where
 * versions genuinely differ, and it is strict about it.
 *
 * Handlers return plain domain objects — the global interceptor applies the
 * response envelope, and the global filter applies it to failures.
 */
@Controller({ path: 'sites', version: [VERSION_NEUTRAL, '1', '2'] })
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body(new ZodValidationPipe(createSiteSchema)) body: CreateSiteInput,
  ): Promise<Site> {
    return this.sites.create(body);
  }

  @Get()
  findAll(
    @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery,
  ): Promise<Paginated<Site>> {
    return this.sites.findPage(query);
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Site> {
    return this.sites.findOne(id);
  }

  @Get(':id/metrics')
  getMetrics(@Param('id', ParseUUIDPipe) id: string): Promise<SiteMetrics> {
    return this.sites.getMetrics(id);
  }
}
