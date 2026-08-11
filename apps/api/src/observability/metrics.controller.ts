import { Controller, Get, Header, Res, Version, VERSION_NEUTRAL } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service';

/**
 * Prometheus scrape endpoint.
 *
 * Version-neutral — a scraper should not have to track API versions — and
 * exempt from the response envelope, because Prometheus requires its own plain
 * text exposition format rather than JSON.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Version(VERSION_NEUTRAL)
  @Header('Cache-Control', 'no-store')
  async scrape(@Res() res: Response): Promise<void> {
    res.setHeader('Content-Type', this.metrics.contentType);
    res.send(await this.metrics.render());
  }
}
