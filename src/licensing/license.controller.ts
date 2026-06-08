import {
  Controller,
  Delete,
  ForbiddenException,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  Post,
  Param,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient, User } from '@supabase/supabase-js';
import { LicenseService } from './license.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';

/** Max key-issuance requests per IP per hour (manual action — very low). */
const RL_KEY_LIMIT  = 5;
const RL_KEY_WIN_MS = 3_600_000;

@Controller('licenses')
export class LicenseController {
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

  /**
   * POST /licenses/:id/keys
   *
   * Issues (or rotates) the activation key for the given license.
   * The caller must own the license. The raw key is returned exactly once
   * and is never stored — the client must copy it before dismissing.
   *
   * Authorization: Bearer <supabase-access-token>
   *
   * Response 201: { key: "TR-..." }
   */
  @Post(':id/keys')
  @HttpCode(HttpStatus.CREATED)
  async issueKey(
    @Param('id') licenseId: string,
    @Headers('authorization') authHeader: string | undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    @Req() req: any,
  ): Promise<{ key: string }> {
    const ip = this.clientIp(req);
    if (!this.rateLimit.check(`key_issue:${ip}`, RL_KEY_LIMIT, RL_KEY_WIN_MS)) {
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.resolveUser(authHeader);
    const result = await this.licenses.issueKey(licenseId, user.id);

    if ('error' in result) {
      if (result.error === 'license not found') throw new NotFoundException(result.error);
      if (result.error === 'forbidden') throw new ForbiddenException(result.error);
      throw new InternalServerErrorException(result.error);
    }

    return { key: result.raw };
  }

  /**
   * DELETE /licenses/:id/keys
   *
   * Revokes the activation key and suspends the license.
   * No new engine activations are possible until a new key is issued.
   * Existing engine sessions remain connected until the heartbeat sweep.
   *
   * Authorization: Bearer <supabase-access-token>
   *
   * Response 204: (no body)
   */
  @Delete(':id/keys')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeKey(
    @Param('id') licenseId: string,
    @Headers('authorization') authHeader: string | undefined,
  ): Promise<void> {
    const user = await this.resolveUser(authHeader);
    const result = await this.licenses.revokeKey(licenseId, user.id);

    if (!result.ok) {
      if (result.error === 'license not found') throw new NotFoundException(result.error);
      if (result.error === 'forbidden') throw new ForbiddenException(result.error);
      throw new InternalServerErrorException(result.error);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
    if (!this.supabase) throw new InternalServerErrorException('Auth not configured');

    const { data, error } = await this.supabase.auth.getUser(token);
    if (error || !data.user) throw new UnauthorizedException('Invalid or expired token');

    return data.user;
  }
}
