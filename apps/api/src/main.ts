import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { VersioningType } from '@nestjs/common';
import { AppModule } from './app.module';
import { corsOrigins, type Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  const config = app.get(ConfigService);
  const env = {
    NODE_ENV: config.getOrThrow<Env['NODE_ENV']>('NODE_ENV'),
    PORT: config.getOrThrow<number>('PORT'),
    CORS_ORIGINS: config.getOrThrow<string>('CORS_ORIGINS'),
    TRUST_PROXY_HOPS: config.getOrThrow<number>('TRUST_PROXY_HOPS'),
  } as Env;

  /**
   * Tell Express how many proxy hops to believe.
   *
   * Rate limiting buckets by client IP. Behind a proxy every request carries the
   * proxy's address unless `X-Forwarded-For` is trusted, which collapses all
   * callers into a single bucket — the limiter still fires, but as a global cap
   * rather than a per-client one, so one noisy caller throttles everybody.
   *
   * Trusting a fixed hop count rather than `true`: `true` believes the entire
   * forwarded chain, including whatever a caller prepends to it.
   */
  if (env.TRUST_PROXY_HOPS > 0) {
    app.getHttpAdapter().getInstance().set('trust proxy', env.TRUST_PROXY_HOPS);
  }

  /**
   * URI versioning.
   *
   * Chosen over header or media-type versioning because the clients that most
   * need version stability here are field IoT sensors: a URL is trivial to pin
   * in firmware, visible in logs and traces, and cannot be stripped by an
   * intermediary the way a custom header can.
   *
   * Deliberately no `defaultVersion`. Every route declares which versions it
   * answers to, so nothing is ever resolved by implication:
   *
   *   /sites, /sites/:id/metrics   version-neutral + v1 + v2 — identical in
   *                                every version, so there is nothing to
   *                                disambiguate, and unversioned URLs keep
   *                                working.
   *
   *   /ingest                      v1 and v2 only; unversioned 404s.
   *
   * Ingest is strict because the two wire formats are not distinguishable by
   * inspection but differ by a factor of 1000: v1 reports grams and epoch
   * seconds, v2 kilograms and ISO-8601. A misresolved version would not fail —
   * it would succeed and write an emission total three orders of magnitude
   * wrong into a compliance record. A 404 is the correct answer to an ambiguous
   * ingest.
   */
  app.enableVersioning({
    type: VersioningType.URI,
  });

  app.enableCors({
    origin: corsOrigins(env),
    credentials: true,
    // Clients must be able to send the idempotency key and read the replay flag.
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Idempotent-Replay', 'X-Request-Id'],
  });

  // Lets OnApplicationShutdown run so the pg pool drains rather than dropping
  // in-flight transactions on SIGTERM.
  app.enableShutdownHooks();

  await app.listen(env.PORT, '0.0.0.0');

  console.log(
    `[api] listening on :${env.PORT} (${env.NODE_ENV}) — versions: v1 (legacy sensors), v2 (current)`,
  );
}

void bootstrap();
