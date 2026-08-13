import { HttpException } from '@nestjs/common';
import {
  ERROR_STATUS,
  type ApiError,
  type ErrorCode,
} from '@emissions/contracts';

/**
 * The only exception type the domain throws.
 *
 * Carries a machine-readable code from the shared contract rather than an HTTP
 * status, so the status mapping lives in exactly one place and the frontend can
 * branch on `code` without parsing prose. Message wording stays free to change
 * without it counting as a breaking API change.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly details: ApiError['details'];

  constructor(
    code: ErrorCode,
    message: string,
    details: ApiError['details'] = [],
  ) {
    super({ code, message, details }, ERROR_STATUS[code]);
    this.code = code;
    this.details = details;
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, details: this.details };
  }
}
