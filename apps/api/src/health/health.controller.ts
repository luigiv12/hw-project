import {
  Controller,
  Get,
  Inject,
  Version,
  VERSION_NEUTRAL,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';

/**
 * Liveness and readiness.
 *
 * Version-neutral: orchestrators and uptime checks should not have to track API
 * versions to find out whether the process is alive.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Liveness — the process is up. Deliberately touches nothing. */
  @Get()
  @Version(VERSION_NEUTRAL)
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness — the process can serve traffic, which requires the database.
   *
   * Separate from liveness on purpose: a database blip should stop traffic
   * being routed here, not cause the container to be killed and restarted into
   * the same unavailable database.
   */
  @Get('ready')
  @Version(VERSION_NEUTRAL)
  async ready(): Promise<{ status: 'ok'; database: 'up' }> {
    await this.db.execute(sql`select 1`);
    return { status: 'ok', database: 'up' };
  }
}
