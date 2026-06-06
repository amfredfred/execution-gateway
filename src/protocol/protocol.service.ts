import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Ajv2020, { ErrorObject, ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EVENT_SCHEMA_FILES, PROTOCOL_VERSION } from './protocol.constants';
import { ProtocolEnvelope, ProtocolValidationResult } from './protocol.types';

@Injectable()
export class ProtocolService implements OnModuleInit {
  private readonly logger = new Logger(ProtocolService.name);
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly eventValidators = new Map<string, ValidateFunction>();
  private readonly fileValidators = new Map<string, ValidateFunction>();
  private envelopeValidator!: ValidateFunction;

  readonly supportedVersions = [PROTOCOL_VERSION];

  constructor(private readonly config: ConfigService) {
    addFormats(this.ajv);
  }

  onModuleInit() {
    const schemaDirectory =
      this.config.get<string>('protocol.schemaDirectory') ??
      resolve(process.cwd(), '..', 'protocol', 'schemas');

    this.envelopeValidator = this.compileSchema(
      schemaDirectory,
      'envelope.schema.json',
    );

    for (const [event, file] of Object.entries(EVENT_SCHEMA_FILES)) {
      let validator = this.fileValidators.get(file);
      if (!validator) {
        validator = this.compileSchema(schemaDirectory, file);
        this.fileValidators.set(file, validator);
      }
      this.eventValidators.set(event, validator);
    }

    this.logger.log(
      `Loaded Protocol ${PROTOCOL_VERSION} schemas from ${schemaDirectory}`,
    );
  }

  validate(input: unknown): ProtocolValidationResult {
    if (!this.envelopeValidator(input)) {
      return {
        valid: false,
        errors: this.formatErrors(this.envelopeValidator.errors),
      };
    }

    const envelope = input as ProtocolEnvelope;
    const payloadValidator = this.eventValidators.get(envelope.event);
    if (!payloadValidator) {
      return {
        valid: false,
        errors: [`Unsupported protocol event: ${envelope.event}`],
      };
    }

    if (!payloadValidator(envelope.payload)) {
      return {
        valid: false,
        errors: this.formatErrors(payloadValidator.errors),
      };
    }

    return { valid: true, errors: [], message: envelope };
  }

  private compileSchema(directory: string, file: string): ValidateFunction {
    const schema = JSON.parse(
      readFileSync(resolve(directory, file), 'utf8'),
    ) as object;
    return this.ajv.compile(schema);
  }

  private formatErrors(errors: ErrorObject[] | null | undefined): string[] {
    return (errors ?? []).map(
      (error) =>
        `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`,
    );
  }
}
