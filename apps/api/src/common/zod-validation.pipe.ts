import { type PipeTransform } from '@nestjs/common';
import { ErrorCode } from '@emissions/contracts';
import type { ZodType } from 'zod';
import { AppException } from './app.exception';

/**
 * Validates a payload against a Zod schema from the shared contracts package.
 *
 * The same schema object validates here and drives the dashboard's form
 * resolver, so the two cannot drift: a field the API rejects is a field the form
 * refuses to submit.
 *
 * Failures become VALIDATION_ERROR with per-field details, so a client can point
 * at the offending input rather than showing a generic failure.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);

    if (result.success) return result.data;

    throw new AppException(
      ErrorCode.VALIDATION_ERROR,
      'Request failed validation',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    );
  }
}
