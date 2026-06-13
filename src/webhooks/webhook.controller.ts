import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  HttpException,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { WebhookService } from './webhook.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';

/** Max Paystack webhook deliveries per IP per minute. */
const RL_WH_LIMIT = 60;
const RL_WH_WIN_MS = 60_000;

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly webhooks: WebhookService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * POST /webhooks/paystack
   *
   * Receives webhook events from Paystack and routes them to the
   * appropriate handler.
   *
   * Authentication: HMAC-SHA512 of the raw body using the Paystack secret key,
   * sent in the X-Paystack-Signature header.
   * See: https://paystack.com/docs/payments/webhooks/#verify-event-origin
   */
  @Post('paystack')
  @HttpCode(HttpStatus.OK)
  async paystack(
    @Req() req: any,
    @Body() body: unknown,
    @Headers('x-paystack-signature') signature: string | undefined,
  ) {
    const forwarded = req.headers['x-forwarded-for'] as string | undefined;
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ??
      (req.socket?.remoteAddress as string | undefined) ??
      'unknown';

    if (!this.rateLimit.check(`wh_ps:${ip}`, RL_WH_LIMIT, RL_WH_WIN_MS)) {
      this.logger.warn(`Webhook rate-limit exceeded from ${ip}`);
      throw new HttpException('Rate limit exceeded', HttpStatus.TOO_MANY_REQUESTS);
    }

    const rawBody: Buffer | undefined = req.rawBody as Buffer | undefined;
    if (!rawBody) {
      this.logger.warn(
        'Raw body not available — falling back to re-serialised body for signature check.',
      );
    }

    if (!signature) {
      this.logger.warn('Paystack webhook: missing X-Paystack-Signature header');
      throw new BadRequestException('Missing webhook signature');
    }

    const bodyForVerification = rawBody ?? Buffer.from(JSON.stringify(body));
    if (!this.webhooks.verifySignature(bodyForVerification, signature)) {
      this.logger.warn('Paystack webhook: signature verification failed');
      throw new BadRequestException('Invalid webhook signature');
    }

    if (!body || typeof body !== 'object') {
      throw new BadRequestException('Expected JSON body');
    }

    const payload = body as { event?: string; data?: unknown };
    if (!payload.event) {
      throw new BadRequestException('Missing event field');
    }

    try {
      await this.webhooks.handleEvent(
        payload as Parameters<WebhookService['handleEvent']>[0],
      );
    } catch (err) {
      this.logger.error(`Paystack webhook handler threw: ${String(err)}`);
      // Return 200 so Paystack does not keep retrying — errors are logged above.
    }

    return { received: true };
  }
}
