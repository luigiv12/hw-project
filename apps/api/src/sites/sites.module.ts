import { Module } from '@nestjs/common';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({
  controllers: [SitesController],
  providers: [SitesService],
  // Ingest needs the compliance calculation and site lookups.
  exports: [SitesService],
})
export class SitesModule {}
