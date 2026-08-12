import { createHash, timingSafeEqual } from 'node:crypto';
import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ErrorCode } from '@emissions/contracts';
import type { Request } from 'express';
import { AppException } from '../common/app.exception';

/**
 * Optional bearer-token gate on the Prometheus exposition endpoint.
 *
 * `METRICS_TOKEN` unset leaves `/metrics` open, which is deliberate: local
 * development and the demo deployment both want it curl-able, and a scrape
 * endpoint that needs credentials to try out is one nobody tries. Setting the
 * variable turns the gate on with no code change.
 *
 * Worth gating in an operational deployment because the exposition describes the
 * business — ingest volume, site count, duplicate and error rates — alongside
 * runtime and version detail from the default process collectors.
 */
@Injectable()
export class MetricsGuard implements CanActivate {
  private readonly logger = new Logger(MetricsGuard.name);
  private readonly expected?: Buffer;

  constructor(config: ConfigService) {
    const token = config.get<string>('METRICS_TOKEN');
    this.expected = token ? digest(token) : undefined;

    if (!token && config.get<string>('NODE_ENV') === 'production') {
      this.logger.warn(
        'METRICS_TOKEN is unset, so /metrics is publicly readable. ' +
          'Set it to require a bearer token.',
      );
    }
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expected) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? '';
    const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';

    /**
     * Compared as fixed-width digests rather than raw strings.
     * `timingSafeEqual` throws on a length mismatch, which would itself reveal
     * the token's length, so both sides are hashed to the same width first.
     */
    if (!timingSafeEqual(digest(supplied), this.expected)) {
      throw new AppException(
        ErrorCode.UNAUTHORIZED,
        'A bearer token is required to read metrics.',
      );
    }

    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
