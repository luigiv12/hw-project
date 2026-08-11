import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { requestContext } from './request-context';

/**
 * Establishes the request id and the async context every downstream layer reads.
 *
 * Honours an inbound `X-Request-Id` so a trace started at the dashboard or a
 * gateway carries through, and always echoes it back on the response.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const inbound = req.header('x-request-id');
    const requestId =
      inbound && inbound.length <= 200 ? inbound : randomUUID();

    res.setHeader('X-Request-Id', requestId);

    // Everything downstream — controllers, services, the exception filter, log
    // lines — runs inside this store.
    requestContext.run({ requestId }, () => next());
  }
}
