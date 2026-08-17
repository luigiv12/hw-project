import { Module } from '@nestjs/common';
import { PartitionMaintenanceService } from './partition-maintenance.service';

/**
 * Its own module rather than a provider on `DbModule`.
 *
 * The service injects the `DB` token that `DbModule` provides, so registering it
 * there would make `db.module.ts` and `partition-maintenance.service.ts` import
 * each other — a cycle Nest rejects outright. `DbModule` is `@Global`, so the
 * token is available here without importing it.
 */
@Module({
  providers: [PartitionMaintenanceService],
  exports: [PartitionMaintenanceService],
})
export class PartitionMaintenanceModule {}
