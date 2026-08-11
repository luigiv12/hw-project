import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ERROR_STATUS,
  ErrorCode,
  type ApiError,
  type ErrorEnvelope,
} from '@emissions/contracts';
import { AppException } from './app.exception';
import { currentRequestId } from './request-context';

/**
 * Terminal error handler. Every failure leaves the API through here in the
 * platform's error envelope — there is no path that emits a raw stack trace or
 * a bare framework error body.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const requestId = currentRequestId();

    const { status, error } = this.normalise(exception);

    // 5xx means we failed; log the cause with the id the client was shown so
    // the two can be joined. 4xx is the client being told something valid about
    // its own request and is not an error on our side.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `[${requestId}] ${error.code}: ${error.message}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`[${requestId}] ${error.code}: ${error.message}`);
    }

    const body: ErrorEnvelope = {
      error,
      meta: { requestId, timestamp: new Date().toISOString() },
    };

    res.status(status).json(body);
  }

  private normalise(exception: unknown): { status: number; error: ApiError } {
    if (exception instanceof AppException) {
      return {
        status: ERROR_STATUS[exception.code],
        error: exception.toApiError(),
      };
    }

    // Framework exceptions (404 for an unmatched route, 429 from the throttler,
    // and so on) still have to arrive in the platform envelope.
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        status,
        error: {
          code: this.codeForStatus(status),
          message: exception.message,
          details: [],
        },
      };
    }

    /**
     * Unknown failure. The message is deliberately generic — an unhandled error
     * can carry connection strings or row contents, and that must not reach a
     * client. The real cause was logged above against this request id.
     */
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      error: {
        code: ErrorCode.INTERNAL_ERROR,
        message: 'An unexpected error occurred',
        details: [],
      },
    };
  }

  private codeForStatus(status: number): ErrorCode {
    switch (status) {
      case HttpStatus.NOT_FOUND:
        return ErrorCode.SITE_NOT_FOUND;
      case HttpStatus.BAD_REQUEST:
        return ErrorCode.VALIDATION_ERROR;
      case HttpStatus.TOO_MANY_REQUESTS:
        return ErrorCode.RATE_LIMITED;
      default:
        return ErrorCode.INTERNAL_ERROR;
    }
  }
}
