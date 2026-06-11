import {
  BadRequestException,
  Body,
  Controller,
  HttpException,
  HttpStatus,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { LicenseService } from './license.service';
import type { LicensePreflight } from './license.types';

const RL_PREFLIGHT_IP_LIMIT = 10;
const RL_PREFLIGHT_KEY_LIMIT = 5;
const RL_PREFLIGHT_WIN_MS = 600_000;

@Controller('activation')
export class ActivationController {
  constructor(
    private readonly licenses: LicenseService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('preflight')
  async preflight(
    @Body() body: { activation_key?: string },
    @Req() req: any,
  ): Promise<LicensePreflight> {
    const activationKey = body?.activation_key?.trim() ?? '';
    if (activationKey.length < 16 || activationKey.length > 256) {
      throw new BadRequestException('activation_key is invalid');
    }

    const ip = this.clientIp(req);
    const keyBucket = createHash('sha256').update(activationKey).digest('hex');
    if (
      !this.rateLimit.check(
        `preflight_ip:${ip}`,
        RL_PREFLIGHT_IP_LIMIT,
        RL_PREFLIGHT_WIN_MS,
      ) ||
      !this.rateLimit.check(
        `preflight_key:${keyBucket}`,
        RL_PREFLIGHT_KEY_LIMIT,
        RL_PREFLIGHT_WIN_MS,
      )
    ) {
      throw new HttpException(
        'Rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const result = await this.licenses.preflight(activationKey);
    if (!result.ok || !result.preflight) {
      throw new ServiceUnavailableException(
        result.error ?? 'Activation preflight unavailable',
      );
    }
    return result.preflight;
  }

  private clientIp(req: any): string {
    const forwarded = req.headers['x-forwarded-for'];
    return (
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ??
      req.socket?.remoteAddress ??
      'unknown'
    );
  }
}
