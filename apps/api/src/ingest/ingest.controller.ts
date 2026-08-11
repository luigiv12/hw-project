import {
  Body,
  Controller,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Res,
} from '@nestjs/common';
import { CommandBus } from '@nestjs/cqrs';
import type { Response } from 'express';
import {
  ErrorCode,
  fromLegacyIngest,
  ingestSchema,
  legacyIngestSchemaV1,
  type IngestInput,
  type IngestResult,
  type LegacyIngestV1,
} from '@emissions/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException } from '../common/app.exception';
import { IngestMeasurementsCommand } from './ingest.command';

/**
 * Current ingestion contract.
 *
 * Neither this controller nor the v1 one below contains ingestion logic — both
 * translate their wire format into `IngestMeasurementsCommand` and dispatch it.
 * The transaction lives in exactly one place regardless of how many versions
 * exist.
 */
@Controller({ path: 'ingest', version: '2' })
export class IngestController {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async ingest(
    @Body(new ZodValidationPipe(ingestSchema)) body: IngestInput,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IngestResult> {
    if (!idempotencyKey?.trim()) {
      throw new AppException(
        ErrorCode.VALIDATION_ERROR,
        'An Idempotency-Key header is required so retries can be de-duplicated',
        [{ path: 'Idempotency-Key', message: 'header is required' }],
      );
    }

    const result = await this.commandBus.execute<
      IngestMeasurementsCommand,
      IngestResult
    >(new IngestMeasurementsCommand(body, idempotencyKey.trim(), '2'));

    /**
     * Surfaced as a header as well as in the body so a client can tell a replay
     * from a first delivery without parsing the payload — which is what the
     * dashboard's retry banner reads.
     */
    res.setHeader('X-Idempotent-Replay', String(result.idempotentReplay));

    return result;
  }
}

/**
 * v1 — frozen contract for field sensors already in the ground.
 *
 * Kept as a separate controller rather than as optional fields on v2. Deployed
 * firmware cannot be changed on our schedule, so this shape must keep working
 * unchanged; isolating it means v2 can evolve without anyone having to reason
 * about whether a change reaches a device in a gas field.
 *
 * The `fromLegacyIngest` adapter converts grams to kilograms and epoch seconds
 * to ISO-8601 at this boundary, so no v1 concept exists past this line.
 */
@Controller({ path: 'ingest', version: '1' })
export class IngestV1Controller {
  constructor(private readonly commandBus: CommandBus) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Header('Deprecation', 'true')
  @Header('Link', '</v2/ingest>; rel="successor-version"')
  async ingestLegacy(
    @Body(new ZodValidationPipe(legacyIngestSchemaV1)) body: LegacyIngestV1,
    @Res({ passthrough: true }) res: Response,
  ): Promise<IngestResult> {
    // v1 firmware carries its de-duplication token in the body; v2 moved it to
    // a header. The adapter is the only place that knows this.
    const { input, idempotencyKey } = fromLegacyIngest(body);

    const result = await this.commandBus.execute<
      IngestMeasurementsCommand,
      IngestResult
    >(new IngestMeasurementsCommand(input, idempotencyKey, '1'));

    res.setHeader('X-Idempotent-Replay', String(result.idempotentReplay));

    return result;
  }
}
