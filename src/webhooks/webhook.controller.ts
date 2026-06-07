import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { WebhookService } from './webhook.service';

@Controller('webhooks')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly webhooks: WebhookService) {}

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
