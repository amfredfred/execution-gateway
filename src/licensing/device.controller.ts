import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { LicenseService } from './license.service';

const RL_RELEASE_IP_LIMIT = 10;
const RL_RELEASE_ENGINE_LIMIT = 5;
const RL_RELEASE_WIN_MS = 600_000;

@Controller()
export class DeviceController {
  private readonly supabase?: SupabaseClient;

  constructor(
    private readonly licenses: LicenseService,
    private readonly rateLimit: RateLimitService,
    config: ConfigService,
  ) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  @Delete('licenses/:licenseId/devices/:engineDeviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async releaseOwnedDevice(
    @Param('licenseId') licenseId: string,
    @Param('engineDeviceId') engineDeviceId: string,
    @Headers('authorization') authHeader: string | undefined,
  ): Promise<void> {
    const user = await this.resolveUser(authHeader);
    const result = await this.licenses.releaseOwnedDevice(
      licenseId,
      engineDeviceId,
      user.id,
    );
    if (result.ok) return;
    if (result.error === 'engine device not found') {
      throw new NotFoundException(result.error);
    }
    if (result.error === 'forbidden') {
      throw new ForbiddenException(result.error);
    }
    throw new InternalServerErrorException(result.error);
  }

  @Post('devices/release')
  @HttpCode(HttpStatus.NO_CONTENT)
  async releaseDevice(
    @Body() body: { engine_id?: string; device_credential?: string },
    @Req() req: any,
  ): Promise<void> {
    const engineId = body?.engine_id?.trim() ?? '';
    const credential = body?.device_credential?.trim() ?? '';
    if (!engineId || credential.length < 16 || credential.length > 256) {
      throw new UnauthorizedException('Invalid engine device credential');
    }

    const ip = this.clientIp(req);
    const engineBucket = createHash('sha256').update(engineId).digest('hex');
    if (
      !this.rateLimit.check(
        `device_release_ip:${ip}`,
        RL_RELEASE_IP_LIMIT,
        RL_RELEASE_WIN_MS,
      ) ||
      !this.rateLimit.check(
        `device_release_engine:${engineBucket}`,
        RL_RELEASE_ENGINE_LIMIT,
        RL_RELEASE_WIN_MS,
      )
    ) {
      throw new HttpException(
        'Rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const result = await this.licenses.releaseDevice(engineId, credential);
    if (!result.ok) {
      throw new UnauthorizedException('Invalid engine device credential');
    }
  }

  private clientIp(req: any): string {
    const forwarded = req.headers['x-forwarded-for'];
    return (
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ??
      req.socket?.remoteAddress ??
      'unknown'
    );
  }

  private async resolveUser(authHeader: string | undefined): Promise<User> {
    const token = authHeader?.replace(/^bearer\s+/i, '').trim();
    if (!token) throw new UnauthorizedException('Missing Authorization header');
    if (!this.supabase) {
      throw new InternalServerErrorException('Auth not configured');
    }
    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return data.user;
  }
}
