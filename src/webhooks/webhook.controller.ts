import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';

/** Max Lemon Squeezy webhook deliveries per IP per minute. */
const RL_WH_LIMIT  = 60;
const RL_WH_WIN_MS = 60_000;

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhooks: WebhookService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * POST /webhooks/lemon-squeezy
   *
   * Receives webhook events from Lemon Squeezy and routes them to the
   * appropriate handler.
   *
   * Authentication: HMAC-SHA256 signature in X-Signature header.
   * See: https://docs.lemonsqueezy.com/help/webhooks#signing-requests
   */
  @Post('lemon-squeezy')
  @HttpCode(HttpStatus.OK)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async lemonSqueezy(
    @Req() req: any,
    @Body() body: unknown,
    @Headers('x-signature') signature: string | undefined,
  ) {
    // Rate-limit before signature work.
    const forwarded = req.headers['x-forwarded-for'] as string | undefined;
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ??
      (req.socket?.remoteAddress as string | undefined) ??
      'unknown';
    if (!this.rateLimit.check(`wh_ls:${ip}`, RL_WH_LIMIT, RL_WH_WIN_MS)) {
      this.logger.warn(`Webhook rate-limit exceeded from ${ip}`);
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    // Lemon Squeezy sends the raw body for signature verification.
    // NestJS exposes rawBody on the request when rawBody:true is set in main.ts.
    const rawBody: Buffer | undefined = req.rawBody as Buffer | undefined;
    if (!rawBody) {
      // Graceful fallback: use JSON string from parsed body
      this.logger.warn(
        'Raw body not available — falling back to re-serialised body for signature check. ' +
          'Enable rawBody in NestJS bootstrap to fix this.',
      );
    }

    const bodyForVerification = rawBody ?? Buffer.from(JSON.stringify(body));
    const sig = signature ?? '';

    if (!this.webhooks.verifySignature(bodyForVerification, sig)) {
      this.logger.warn('Lemon Squeezy webhook: signature verification failed');
      throw new BadRequestException('Invalid webhook signature');
    }

    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Expected JSON body');
    }

    const payload = body as {
      meta?: { event_name?: string };
      data?: unknown;
    };

    if (!payload.meta?.event_name) {
      throw new BadRequestException('Missing meta.event_name');
    }

    try {
      await this.webhooks.handleEvent(payload as Parameters<WebhookService['handleEvent']>[0]);
    } catch (err) {
      this.logger.error(
        `Lemon Squeezy webhook handler threw: ${String(err)}`,
      );
      // Still return 200 to prevent Lemon Squeezy from retrying (errors are logged above)
    }

    return { received: true };
  }
}
