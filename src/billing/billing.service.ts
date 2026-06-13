import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─── Paystack API shapes ───────────────────────────────────────────────────────

interface PaystackPlan {
  id: number;
  plan_code: string;
  name: string;
  description: string | null;
  amount: number;       // smallest currency unit (kobo for NGN)
  interval: string;     // "monthly" | "annually" | "weekly" | "quarterly" | "biannually"
  currency: string;
  is_deleted: boolean;
  is_archived: boolean;
}

interface PaystackPlansResponse {
  status: boolean;
  data: PaystackPlan[];
}

// ─── Public plan shape returned to the dashboard ──────────────────────────────

export interface BillingPlan {
  variantId: string;   // plan_code
  planKey: string;   // "starter" | "pro" | "infrastructure"
  interval: 'monthly' | 'yearly' | 'custom';
  name: string;
  price: string;   // formatted, e.g. "₦33,000"
  priceNote: string;   // e.g. "₦396,000 billed yearly"
  currency: string;
  devices: number;
  desc: string;
  features: string[];
  highlight: boolean;
  checkoutUrl: string;   // https://paystack.com/pay/{plan_code}
  trialDays: number | null;
}

// ─── Static plan metadata (matched by plan name substring) ────────────────────

interface PlanMeta {
  planKey: string;
  interval: 'monthly' | 'yearly' | 'custom';
  name: string;
  devices: number;
  desc: string;
  features: string[];
  highlight: boolean;
}

const PLAN_META: Array<{ matchKey: string; matchInterval: string } & PlanMeta> = [
  {
    matchKey: 'starter', matchInterval: 'monthly',
    planKey: 'starter', interval: 'monthly',
    name: 'AQM Starter', devices: 1,
    desc: 'One Trading Agent. Signals delivered and traded automatically on your MT5.',
    features: ['1 Trading Agent', 'Live signal delivery', 'Automatic MT5 execution', 'Customer dashboard'],
    highlight: false,
  },
  {
    matchKey: 'starter', matchInterval: 'annually',
    planKey: 'starter', interval: 'yearly',
    name: 'AQ Starter', devices: 1,
    desc: 'Everything in AQM Starter — billed yearly at a lower rate.',
    features: ['1 Trading Agent', 'Live signal delivery', 'Automatic MT5 execution', 'Customer dashboard', '20% yearly discount'],
    highlight: false,
  },
  {
    matchKey: 'pro', matchInterval: 'monthly',
    planKey: 'pro', interval: 'monthly',
    name: 'AQM Pro', devices: 3,
    desc: 'Run up to 3 Trading Agents across multiple accounts or VPS instances simultaneously.',
    features: ['3 Trading Agents', 'Live signal delivery', 'Automatic MT5 execution', 'Multi-account support', 'Customer dashboard'],
    highlight: true,
  },
  {
    matchKey: 'pro', matchInterval: 'annually',
    planKey: 'pro', interval: 'yearly',
    name: 'AQ Pro', devices: 3,
    desc: 'Everything in AQM Pro — billed yearly at a lower rate.',
    features: ['3 Trading Agents', 'Live signal delivery', 'Automatic MT5 execution', 'Multi-account support', 'Customer dashboard', '20% yearly discount'],
    highlight: true,
  },
  {
    matchKey: 'infra', matchInterval: '',
    planKey: 'infrastructure', interval: 'custom',
    name: 'AQ Infrastructure', devices: 9999,
    desc: 'Unlimited Trading Agents for institutions, prop firms, and large-scale deployments.',
    features: ['Unlimited Trading Agents', 'Dedicated signal infrastructure', 'Custom integration support', 'Priority onboarding', 'Customer dashboard'],
    highlight: false,
  },
];

const CACHE_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly secretKey?: string;

  private _cache: BillingPlan[] | null = null;
  private _cacheAt = 0;
  private _planAmounts = new Map<string, number>(); // plan_code → kobo amount

  constructor(private readonly config: ConfigService) {
    this.secretKey = config.get<string>('billing.paystackSecretKey');
  }

  async verifyTransaction(reference: string): Promise<{
    success: boolean;
    planName?: string;
    amount?: string;
    email?: string;
  }> {
    if (!this.secretKey) throw new Error('PAYSTACK_SECRET_KEY not configured');

    const res = await BillingService.paystackFetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${this.secretKey}` } },
    );

    if (!res.ok) {
      throw new Error(`Paystack verify responded ${res.status}`);
    }

    const json = (await res.json()) as {
      status: boolean;
      data: {
        status: string;
        amount: number;
        currency: string;
        customer: { email: string };
        plan_object?: { name: string };
      };
    };

    const data = json.data;
    const success = json.status && data?.status === 'success';

    return {
      success,
      planName: data?.plan_object?.name,
      amount: success ? this.formatAmount(data.amount, data.currency) : undefined,
      email: data?.customer?.email,
    };
  }

  async initializeCheckout(planCode: string, email: string, callbackUrl: string): Promise<string> {
    if (!this.secretKey) throw new Error('PAYSTACK_SECRET_KEY not configured');

    // Ensure plan amounts are loaded
    if (!this._planAmounts.has(planCode)) {
      await this.getPlans();
    }
    const amount = this._planAmounts.get(planCode);
    if (amount === undefined) {
      throw new Error(`Unknown plan code: ${planCode}`);
    }

    const res = await BillingService.paystackFetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, amount, plan: planCode, callback_url: callbackUrl }),
    });

    if (!res.ok) {
      throw new Error(`Paystack initialize responded ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as { status: boolean; data: { authorization_url: string } };
    if (!json.status || !json.data?.authorization_url) {
      throw new Error('Paystack did not return an authorization_url');
    }

    return json.data.authorization_url;
  }

  async getPlans(): Promise<BillingPlan[]> {
    if (this._cache && Date.now() - this._cacheAt < CACHE_TTL_MS) {
      return this._cache;
    }

    if (!this.secretKey) {
      this.logger.warn('PAYSTACK_SECRET_KEY not set — returning empty plan list');
      return [];
    }

    try {
      const plans = await this.fetchAndMapPlans();
      this._cache = plans;
      this._cacheAt = Date.now();
      return plans;
    } catch (err) {
      this.logger.error(`Failed to fetch plans from Paystack: ${String(err)}`);
      return this._cache ?? [];
    }
  }

  private static paystackFetch(url: string, init: RequestInit = {}): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
  }

  private async fetchAndMapPlans(): Promise<BillingPlan[]> {
    const res = await BillingService.paystackFetch('https://api.paystack.co/plan?perPage=50', {
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!res.ok) {
      throw new Error(`Paystack API responded ${res.status}: ${await res.text()}`);
    }

    const json = (await res.json()) as PaystackPlansResponse;
    const rawPlans = (json.data ?? []).filter((p) => !p.is_deleted && !p.is_archived);
    this.logger.debug(`Paystack returned ${rawPlans.length} active plans`);

    const result: BillingPlan[] = [];

    for (const plan of rawPlans) {
      const meta = this.matchMeta(plan);
      if (!meta) {
        this.logger.debug(`No meta match for plan "${plan.name}" (${plan.plan_code}) — skipping`);
        continue;
      }

      const isYearly = plan.interval === 'annually';
      const headlineAmount = isYearly ? Math.round(plan.amount / 12) : plan.amount;
      const price = this.formatAmount(headlineAmount, plan.currency);
      const priceNote = isYearly
        ? `· ${this.formatAmount(plan.amount, plan.currency)} billed yearly`
        : '';

      const checkoutUrl = `https://paystack.com/pay/${plan.plan_code}`;

      this._planAmounts.set(plan.plan_code, plan.amount);

      result.push({
        variantId: plan.plan_code,
        planKey: meta.planKey,
        interval: meta.interval,
        name: meta.name,
        price,
        priceNote,
        currency: plan.currency,
        devices: meta.devices,
        desc: plan.description?.trim() || meta.desc,
        features: meta.features,
        highlight: meta.highlight,
        checkoutUrl,
        trialDays: null,
      });

      this.logger.debug(`Matched plan "${plan.name}" → ${meta.planKey}/${meta.interval}`);
    }

    const planOrder = ['starter', 'pro', 'infrastructure'];
    const intervalOrder = ['monthly', 'yearly', 'custom'];
    result.sort((a, b) => {
      const pd = planOrder.indexOf(a.planKey) - planOrder.indexOf(b.planKey);
      return pd !== 0 ? pd : intervalOrder.indexOf(a.interval) - intervalOrder.indexOf(b.interval);
    });

    return result;
  }

  /**
   * Match a Paystack plan to static metadata by name substring.
   * Rules (case-insensitive):
   *   name contains "infra"           → infrastructure / custom
   *   name contains "pro" + interval  → pro / monthly|yearly
   *   name contains "starter" + interval → starter / monthly|yearly
   */
  private matchMeta(plan: PaystackPlan): PlanMeta | null {
    const name = plan.name.toLowerCase();
    const itvl = plan.interval.toLowerCase(); // "monthly" | "annually"

    for (const meta of PLAN_META) {
      if (!name.includes(meta.matchKey)) continue;
      if (meta.matchInterval && !itvl.startsWith(meta.matchInterval.slice(0, 5))) continue;
      return meta;
    }
    return null;
  }

  private formatAmount(smallestUnit: number, currency: string): string {
    if (smallestUnit === 0) return 'Free';
    const amount = smallestUnit / 100;
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  }
}
