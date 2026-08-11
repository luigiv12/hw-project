import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { SuccessEnvelope } from '@emissions/contracts';
import { currentRequestId } from './request-context';

/**
 * Wraps every successful handler return value in the platform envelope.
 *
 * Applied globally so controllers return plain domain objects and no endpoint
 * can accidentally ship a differently-shaped success response. The spec calls a
 * consistent response structure a "Platform Goal" for multi-team work; enforcing
 * it in one interceptor is what makes that true in practice rather than by
 * convention.
 */
@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, SuccessEnvelope<T>>
{
  intercept(
    _ctx: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessEnvelope<T>> {
    return next.handle().pipe(
      map((data) => ({
        data,
        meta: {
          requestId: currentRequestId(),
          timestamp: new Date().toISOString(),
        },
      })),
    );
  }
}
