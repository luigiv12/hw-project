import { Controller, Get, Version, VERSION_NEUTRAL } from '@nestjs/common';

type ApiIndex = {
  name: string;
  description: string;
  versions: { current: string; supported: string[] };
  endpoints: Record<string, string>;
  documentation: string;
};

/**
 * Index of the API surface.
 *
 * Version-neutral and unauthenticated: the root is the first URL anyone opens
 * after being handed a base address, and a self-describing response gets them
 * to the endpoint they want without reading the source.
 */
@Controller()
export class RootController {
  @Get()
  @Version(VERSION_NEUTRAL)
  index(): ApiIndex {
    return {
      name: 'Emissions Ingestion & Analytics Engine',
      description:
        'Methane ingestion with exactly-once counting under retries and concurrent writers.',
      versions: {
        current: 'v2',
        supported: ['v1', 'v2'],
      },
      endpoints: {
        'POST /sites': 'Create a site with an emission limit',
        'GET /sites': 'List sites with running totals',
        'GET /sites/:id': 'A single site',
        'GET /sites/:id/metrics': 'Summary and compliance status',
        'POST /v2/ingest':
          'Ingest up to 100 readings. Requires an Idempotency-Key header.',
        'POST /v1/ingest':
          'Legacy sensor format: epoch seconds, grams, batch_id in the body.',
        'GET /health': 'Liveness',
        'GET /health/ready': 'Readiness, including the database',
        'GET /metrics': 'Prometheus exposition',
      },
      documentation: 'https://github.com/luigiv12/hw-project#readme',
    };
  }
}
