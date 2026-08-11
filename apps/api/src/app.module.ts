import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { SitesModule } from './sites/sites.module';
import { IngestModule } from './ingest/ingest.module';
import { OutboxModule } from './outbox/outbox.module';
import { MetricsModule } from './observability/metrics.module';
import { validateEnv } from './config/env';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ResponseInterceptor } from './common/response.interceptor';
import { RequestIdMiddleware } from './common/request-id.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
      // Repo root .env when running from source; in a container the values
      // arrive as real environment variables and no file is present.
      envFilePath: ['../../.env', '.env'],
    }),

    /**
     * The demo deployment exposes public write endpoints. A generous ceiling
     * costs a legitimate reviewer nothing while stopping a script from filling
     * the measurements table.
     */
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('RATE_LIMIT_TTL_MS') ?? 60_000,
            limit: config.get<number>('RATE_LIMIT_MAX') ?? 300,
          },
        ],
      }),
    }),

    MetricsModule,
    DbModule,
    HealthModule,
    SitesModule,
    IngestModule,
    OutboxModule,
  ],
  providers: [
    // Registered globally rather than per-controller. The envelope is a platform
    // guarantee, and a guarantee that each team has to remember to opt into is
    // not one.
    { provide: APP_INTERCEPTOR, useClass: ResponseInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Runs before everything else so the request id exists for the whole
    // lifecycle, including failures handled by the exception filter.
    consumer.apply(RequestIdMiddleware).forRoutes('*splat');
  }
}
