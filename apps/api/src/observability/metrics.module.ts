import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import { MetricsService } from './metrics.service';

/**
 * Global: ingest and the outbox dispatcher both record metrics, and threading a
 * module import through every feature that wants a counter is friction that
 * discourages instrumenting things.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
