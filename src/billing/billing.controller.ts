import { Controller, Get, HttpCode, HttpStatus, Logger } from '@nestjs/common';
import { BillingService } from './billing.service';

@Controller('billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(private readonly billing: BillingService) {}

  /**
   * GET /billing/plans
   *
   * Public endpoint — no auth required.
   * Returns available subscription plans fetched from Lemon Squeezy,
   * merged with static plan metadata (features, descriptions).
   * Response is cached for 5 minutes server-side.
   */
  @Get('plans')
  @HttpCode(HttpStatus.OK)
  async getPlans() {
    const plans = await this.billing.getPlans();
    return { plans };
  }
}
