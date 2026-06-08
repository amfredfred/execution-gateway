import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ─── LS API shapes (partial) ───────────────────────────────────────────────────

interface LsVariantAttributes {
  name: string;
  status: string;
  price: number;           // smallest currency unit (e.g. kobo for NGN, cents for USD)
  is_subscription: boolean;
  interval: string | null; // "month" | "year" | null
  interval_count: number | null;
  product_id: number;
  buy_now_url: string;
  sort: number;
}

interface LsVariant {
  id: string;
  type: string;
  attributes: LsVariantAttributes;
}

interface LsVariantsResponse {
  data: LsVariant[];
  links?: { next?: string | null };
}

interface LsStoreAttributes {
  currency: string; // ISO 4217, e.g. "NGN", "USD"
}

interface LsStoreResponse {
  data: { attributes: LsStoreAttributes };
}

// ─── Public plan shape returned to the dashboard ──────────────────────────────

export interface BillingPlan {
  variantId: string;
  planKey: string;    // "starter" | "pro" | "infrastructure"
  interval: 'monthly' | 'yearly' | 'custom';
  name: string;
  price: string;    // formatted, e.g. "₦33,000"
  priceNote: string;    // e.g. "₦25,000/mo · ₦300,000 billed yearly"
  currency: string;    // ISO 4217 code, e.g. "NGN"
  devices: number;
  desc: string;
  features: string[];
  highlight: boolean;
  checkoutUrl: string;
}

// ─── Static plan metadata ──────────────────────────────────────────────────────

interface PlanMeta {
  planKey: string;
  interval: 'monthly' | 'yearly' | 'custom';
  name: string;
  devices: number;
  desc: string;
  features: string[];
  highlight: boolean;
}

const PLAN_META: Array<{ match: string } & PlanMeta> = [
  {
    match: 'starter monthly',
    planKey: 'starter',
    interval: 'monthly',
    name: 'Starter',
    devices: 1,
    desc: 'Get started with one live execution engine.',
    features: [],
    highlight: false,
  },
  {
    match: 'starter yearly',
    planKey: 'starter',
    interval: 'yearly',
    name: 'Starter',
    devices: 5,
    desc: 'Run up to 5 engines at a reduced yearly rate.',
    features: [],
    highlight: false,
  },
  {
    match: 'pro monthly',
    planKey: 'pro',
    interval: 'monthly',
    name: 'Pro',
    devices: 3,
    desc: 'Three engines running simultaneously.',
    features: [],
    highlight: true,
  },
  {
    match: 'pro yearly',
    planKey: 'pro',
    interval: 'yearly',
    name: 'Pro',
    devices: 10,
    desc: 'Scale to 10 engines at a reduced yearly rate.',
    features: [],
    highlight: true,
  },
  {
    match: 'infrastructure',
    planKey: 'infrastructure',
    interval: 'custom',
    name: 'Infrastructure',
    devices: 9999,
    desc: 'Unlimited engines. Reach out to discuss.',
    features: ['Unlimited execution engines', 'Signal delivery', 'Customer dashboard'],
    highlight: false,
  },
];

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly apiKey?: string;
  private readonly storeId?: string;

  private _cache: BillingPlan[] | null = null;
  private _cacheAt = 0;
  private _currency = 'USD'; // updated from LS store on first fetch

  constructor(private readonly config: ConfigService) {
    this.apiKey = config.get<string>('billing.lsApiKey');
    this.storeId = config.get<string>('billing.lsStoreId');
  }

  async getPlans(): Promise<BillingPlan[]> {
    if (this._cache && Date.now() - this._cacheAt < CACHE_TTL_MS) {
      return this._cache;
    }

    if (!this.apiKey) {
      this.logger.warn('LS_API_KEY not set — returning empty plan list');
      return [];
    }

    try {
      // Fetch store currency + variants in parallel
      const [currency, variants] = await Promise.all([
        this.fetchStoreCurrency(),
        this.fetchVariants(),
      ]);
      this._currency = currency;
      const plans = this.mapVariantsToPlans(variants, currency);
      this._cache = plans;
      this._cacheAt = Date.now();
      return plans;
    } catch (err) {
      this.logger.error(`Failed to fetch plans from Lemon Squeezy: ${String(err)}`);
      return this._cache ?? [];
    }
  }

  // ── LS API fetch ─────────────────────────────────────────────────────────────

  private async fetchStoreCurrency(): Promise<string> {
    if (!this.storeId) return 'USD';
    const res = await fetch(`https://api.lemonsqueezy.com/v1/stores/${this.storeId}`, {
      headers: {
        Accept: 'application/vnd.api+json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      this.logger.warn(`Could not fetch store currency — defaulting to USD`);
      return 'USD';
    }
    const json = await res.json() as LsStoreResponse;
    return json.data?.attributes?.currency ?? 'USD';
  }

  private async fetchVariants(): Promise<LsVariant[]> {
    const res = await fetch(`https://api.lemonsqueezy.com/v1/variants?page[size]=50`, {
      headers: {
        Accept: 'application/vnd.api+json',
        Authorization: `Bearer ${this.apiKey}`,
      },
    });
    if (!res.ok) {
      throw new Error(`LS API responded ${res.status}: ${await res.text()}`);
    }
    const json = await res.json() as LsVariantsResponse;
    return json.data ?? [];
  }

  // ── Mapping ───────────────────────────────────────────────────────────────────

  private mapVariantsToPlans(variants: LsVariant[], currency: string): BillingPlan[] {
    const idToMeta = new Map<string, (typeof PLAN_META)[number]>();
    const keys: Array<[string, (typeof PLAN_META)[number]]> = [
      [this.config.get<string>('licensing.variantStarterMonthly') ?? '', PLAN_META.find(m => m.match === 'starter monthly')!],
      [this.config.get<string>('licensing.variantStarterYearly') ?? '', PLAN_META.find(m => m.match === 'starter yearly')!],
      [this.config.get<string>('licensing.variantProMonthly') ?? '', PLAN_META.find(m => m.match === 'pro monthly')!],
      [this.config.get<string>('licensing.variantProYearly') ?? '', PLAN_META.find(m => m.match === 'pro yearly')!],
      [this.config.get<string>('licensing.variantInfrastructure') ?? '', PLAN_META.find(m => m.match === 'infrastructure')!],
    ];
    for (const [id, meta] of keys) {
      if (id && meta) idToMeta.set(String(id), meta);
    }

    const plans: BillingPlan[] = [];

    for (const v of variants) {
      const meta = idToMeta.get(v.id);
      if (!meta) continue;

      const attrs = v.attributes;
      const price = this.formatAmount(attrs.price, currency);
      const priceNote = this.buildPriceNote(attrs.price, attrs.interval, attrs.interval_count, currency);

      plans.push({
        variantId: v.id,
        planKey: meta.planKey,
        interval: meta.interval,
        name: meta.name,
        price,
        priceNote,
        currency,
        devices: meta.devices,
        desc: meta.desc,
        features: meta.features,
        highlight: meta.highlight,
        checkoutUrl: attrs.buy_now_url,
      });
    }

    const planOrder = ['starter', 'pro', 'infrastructure'];
    const intvlOrder = ['monthly', 'yearly', 'custom'];
    plans.sort((a, b) => {
      const pd = planOrder.indexOf(a.planKey) - planOrder.indexOf(b.planKey);
      if (pd !== 0) return pd;
      return intvlOrder.indexOf(a.interval) - intvlOrder.indexOf(b.interval);
    });

    return plans;
  }

  // ── Formatting ────────────────────────────────────────────────────────────────

  private formatAmount(smallestUnit: number, currency: string): string {
    if (smallestUnit === 0) return 'Free';
    // LS stores price in smallest currency unit (kobo for NGN, cents for USD, etc.)
    const amount = smallestUnit / 100;
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency,
      maximumFractionDigits: amount % 1 === 0 ? 0 : 2,
    }).format(amount);
  }

  private buildPriceNote(
    smallestUnit: number,
    interval: string | null,
    count: number | null,
    currency: string,
  ): string {
    if (!interval || smallestUnit === 0) return '';

    if (interval === 'month') {
      return count && count > 1 ? `billed every ${count} months` : '/mo';
    }

    if (interval === 'year') {
      // Show per-month equivalent and total yearly amount
      const yearly = smallestUnit / 100;
      const perMonth = yearly / 12;
      const perMonthFmt = this.formatAmount(perMonth * 100, currency);
      const yearlyFmt = this.formatAmount(smallestUnit, currency);
      return `${perMonthFmt}/mo · ${yearlyFmt} billed yearly`;
    }

    return '';
  }
}
