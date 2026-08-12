import { Module } from '@nestjs/common';
import { CqrsModule } from '@nestjs/cqrs';
import { IngestController, IngestV1Controller } from './ingest.controller';
import { IngestMeasurementsHandler } from './ingest.handler';

@Module({
  imports: [CqrsModule],
  controllers: [IngestController, IngestV1Controller],
  providers: [IngestMeasurementsHandler],
})
export class IngestModule {}
