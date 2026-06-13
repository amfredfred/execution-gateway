import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billing: BillingService,
    private readonly config: ConfigService,
  ) {}

  /** GET /billing/plans — public, cached 5 min */
  @Get('plans')
  @HttpCode(HttpStatus.OK)
  async getPlans() {
    const plans = await this.billing.getPlans();
    return { plans };
  }

  /**
   * POST /billing/initialize
   * Initializes a Paystack subscription checkout.
   * Body: { planCode: string; email: string }
   * Returns: { url: string } — the Paystack authorization_url
   */
  @Post('initialize')
  @HttpCode(HttpStatus.OK)
  async initializeCheckout(@Body() body: { planCode?: string; email?: string }) {
    const { planCode, email } = body ?? {};
    if (!planCode || !email) {
      throw new BadRequestException('planCode and email are required');
    }

    const dashboardUrl = this.config.get<string>('dashboard.url') ?? 'https://app.apexquantel.io';
    const callbackUrl = `${dashboardUrl}/app/billing/callback`;

    try {
      const url = await this.billing.initializeCheckout(planCode, email, callbackUrl);
      return { url };
    } catch (err) {
      this.logger.error(`Checkout initialization failed: ${String(err)}`);
      throw new BadRequestException('Could not initialize checkout. Please try again.');
    }
  }

  /**
   * GET /billing/verify?reference=xxx
   * Verifies a Paystack transaction after the customer returns from checkout.
   * Returns: { success, planName?, amount?, email? }
   */
  @Get('verify')
  @HttpCode(HttpStatus.OK)
  async verifyTransaction(@Query('reference') reference: string) {
    if (!reference) throw new BadRequestException('reference is required');
    try {
      return await this.billing.verifyTransaction(reference);
    } catch (err) {
      this.logger.error(`Transaction verification failed: ${String(err)}`);
      return { success: false };
    }
  }
}
