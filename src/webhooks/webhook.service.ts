import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import * as nodemailer from 'nodemailer';
import { SignalEngineSubscriberService } from '../signal-engine/signal-engine-subscriber.service';

// ─── Paystack webhook payload shapes ──────────────────────────────────────────

interface PaystackCustomer {
  email: string;
  first_name?: string;
  last_name?: string;
}

interface PaystackPlan {
  plan_code: string;
  name: string;
  amount: number;       // smallest currency unit (kobo for NGN)
  interval: string;     // "monthly" | "annually" | "weekly" etc.
  currency: string;
}

interface PaystackSubscriptionData {
  subscription_code: string;
  status: string;
  next_payment_date?: string | null;
  plan: PaystackPlan;
  customer: PaystackCustomer;
}

interface PaystackInvoiceData {
  status: string;
  paid: boolean;
  period_end?: string | null;
  subscription: {
    subscription_code: string;
    next_payment_date?: string | null;
  };
  plan: PaystackPlan;
  customer: PaystackCustomer;
}

interface PaystackChargeData {
  reference: string;
  amount: number;
  currency: string;
  status: string;
  plan?: PaystackPlan;
  subscription?: { subscription_code: string }; // present on subscription charges
  customer: PaystackCustomer;
}

interface PaystackWebhookPayload {
  event: string;
  data: PaystackSubscriptionData | PaystackInvoiceData | PaystackChargeData;
}

// ─── Plan config ───────────────────────────────────────────────────────────────

interface PlanConfig {
  maxDevices: number;
  days: number;
}

function planConfigFromPaystackPlan(plan: PaystackPlan | undefined): PlanConfig {
  if (!plan) return { maxDevices: 1, days: 30 };
  const name = plan.name.toLowerCase();
  const days = plan.interval === 'annually' ? 365 : 30;
  if (name.includes('infra')) return { maxDevices: 9999, days };
  if (name.includes('pro'))   return { maxDevices: 3,    days };
  return { maxDevices: 1, days };
}

// ─── Constants ────────────────────────────────────────────────────────────────

const GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000; // 3 days after next payment date

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly supabase?: SupabaseClient;
  private readonly pepper?: string;
  private readonly paystackSecretKey?: string;
  private readonly mailer?: nodemailer.Transporter;
  private readonly emailFrom: string;
  private readonly dashboardUrl: string;

  constructor(
    private readonly config: ConfigService,
    private readonly signalEngine: SignalEngineSubscriberService,
  ) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    this.pepper = config.get<string>('licensing.activationKeyPepper');
    this.paystackSecretKey = config.get<string>('webhooks.paystackSecretKey');
    this.emailFrom =
      config.get<string>('smtp.from') ??
      'Apex Quantel <noreply@apexquantel.io>';
    this.dashboardUrl =
      config.get<string>('dashboard.url') ?? 'https://app.apexquantel.io';

    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }

    const smtpHost = config.get<string>('smtp.host');
    if (smtpHost) {
      this.mailer = nodemailer.createTransport({
        host: smtpHost,
        port: config.get<number>('smtp.port') ?? 587,
        secure: config.get<boolean>('smtp.secure') ?? false,
        auth: {
          user: config.get<string>('smtp.user'),
          pass: config.get<string>('smtp.pass'),
        },
      });
      this.logger.log(
        `SMTP configured: ${smtpHost}:${config.get<number>('smtp.port') ?? 587}`,
      );
    } else {
      const isProd = (process.env.NODE_ENV ?? 'development') === 'production';
      if (isProd) {
        throw new Error(
          'SMTP_HOST is required in production. Set SMTP_HOST in .env to enable activation key email delivery.',
        );
      }
      this.logger.warn(
        'SMTP_HOST not set — activation keys will be logged to console only (dev mode)',
      );
    }
  }

  // ── Signature verification ─────────────────────────────────────────────────

  /**
   * Verifies the x-paystack-signature header.
   * Paystack signs the raw request body with HMAC-SHA512 using the secret key.
   */
  verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!this.paystackSecretKey) {
      const isProd = process.env.NODE_ENV === 'production';
      if (isProd) {
        this.logger.error(
          'PAYSTACK_SECRET_KEY is not set — rejecting all webhook calls in production.',
        );
        return false;
      }
      this.logger.warn(
        'PAYSTACK_SECRET_KEY not set — skipping signature verification (dev mode only)',
      );
      return true;
    }
    const expected = createHmac('sha512', this.paystackSecretKey)
      .update(rawBody)
      .digest();
    const provided = Buffer.from(signature, 'hex');
    if (expected.length !== provided.length) return false;
    return timingSafeEqual(expected, provided);
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  async handleEvent(payload: PaystackWebhookPayload): Promise<void> {
    const event = payload.event;
    this.logger.log(`Paystack webhook: ${event}`);

    switch (event) {
      // One-time charge (non-subscription purchase)
      case 'charge.success':
        await this.handleChargeSuccess(payload.data as PaystackChargeData);
        break;
      // New subscription created
      case 'subscription.create':
        await this.handleSubscriptionCreate(payload.data as PaystackSubscriptionData);
        break;
      // Invoice paid — subscription renewed
      case 'invoice.update':
        await this.handleInvoiceUpdate(payload.data as PaystackInvoiceData);
        break;
      // Subscription cancelled / disabled
      case 'subscription.disable':
        await this.handleSubscriptionDisable(payload.data as PaystackSubscriptionData);
        break;
      // Subscription re-enabled after being disabled
      case 'subscription.enable':
        await this.handleSubscriptionEnable(payload.data as PaystackSubscriptionData);
        break;
      // Refund processed — suspend license
      case 'refund.processed':
        await this.handleRefundProcessed(payload.data as PaystackChargeData);
        break;
      default:
        this.logger.debug(`Unhandled Paystack event: ${event}`);
    }
  }

  // ── charge.success → new license (one-time purchase) ──────────────────────

  private async handleChargeSuccess(data: PaystackChargeData): Promise<void> {
    // Subscription charges: subscription.create handles initial license creation,
    // invoice.update handles renewals. Skip here to avoid the race-condition
    // where both events fire within milliseconds and both try to INSERT.
    if (data.plan && data.subscription) {
      this.logger.debug(
        `charge.success ref=${data.reference}: subscription charge — handled by subscription.create / invoice.update`,
      );
      return;
    }

    // Plain one-time charges without a plan don't need a license row.
    if (!data.plan) {
      this.logger.debug(
        `charge.success ref=${data.reference}: no plan attached — skipping license provision`,
      );
      return;
    }
    if (!this.supabase) {
      this.logger.error('Supabase not configured — cannot create license from charge');
      return;
    }

    const email = data.customer.email;
    const name = [data.customer.first_name, data.customer.last_name]
      .filter(Boolean)
      .join(' ') || undefined;

    const plan = planConfigFromPaystackPlan(data.plan);
    const expiresAt = this.futureIso(plan.days);

    const userId = await this.resolveOrCreateUser(email, name);
    if (!userId) return;

    // Guard: skip if the user already has an active license (subscription.create
    // may fire for the same purchase shortly after charge.success).
    const { data: existing } = await this.supabase
      .from('licenses')
      .select('id')
      .eq('owner_user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (existing && existing.length > 0) {
      this.logger.log(
        `charge.success: user ${email} already has an active license — skipping duplicate provision`,
      );
      return;
    }

    const licenseId = await this.createLicense(
      userId,
      expiresAt,
      data.reference,
      plan.maxDevices,
    );
    if (!licenseId) return;

    await this.issueAndDeliverKey(licenseId, userId, email);
  }

  // ── subscription.create → new license ─────────────────────────────────────

  private async handleSubscriptionCreate(data: PaystackSubscriptionData): Promise<void> {
    if (!this.supabase) {
      this.logger.error('Supabase not configured — cannot create license from subscription');
      return;
    }

    const email = data.customer.email;
    const name = [data.customer.first_name, data.customer.last_name]
      .filter(Boolean)
      .join(' ') || undefined;

    const plan = planConfigFromPaystackPlan(data.plan);
    const expiresAt = data.next_payment_date
      ? new Date(Date.parse(data.next_payment_date) + GRACE_PERIOD_MS).toISOString()
      : this.futureIso(plan.days);

    const userId = await this.resolveOrCreateUser(email, name);
    if (!userId) return;

    const { data: existing } = await this.supabase
      .from('licenses')
      .select('id')
      .eq('owner_user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (existing && existing.length > 0) {
      this.logger.log(
        `subscription.create: user ${email} already has an active license — skipping duplicate`,
      );
      return;
    }

    const licenseId = await this.createLicense(
      userId,
      expiresAt,
      data.subscription_code,
      plan.maxDevices,
    );
    if (!licenseId) return;

    await this.issueAndDeliverKey(licenseId, userId, email);
  }

  // ── invoice.update → renewal or payment failure ────────────────────────────

  private async handleInvoiceUpdate(data: PaystackInvoiceData): Promise<void> {
    if (!this.supabase) return;

    const email = data.customer.email;
    const userId = await this.resolveUserId(email);
    if (!userId) return;

    if (data.status === 'success' && data.paid) {
      // Renewal — extend the license expiry
      const nextPayment = data.subscription?.next_payment_date ?? data.period_end;
      const newExpiresAt = nextPayment
        ? new Date(Date.parse(nextPayment) + GRACE_PERIOD_MS).toISOString()
        : this.futureIso(planConfigFromPaystackPlan(data.plan).days);

      const { data: licenses, error } = await this.supabase
        .from('licenses')
        .select('id')
        .eq('owner_user_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1);

      if (error || !licenses?.length) {
        this.logger.warn(`invoice.update renewal: no active license for ${email}`);
        return;
      }

      await this.supabase
        .from('licenses')
        .update({ expires_at: newExpiresAt, updated_at: new Date().toISOString() })
        .eq('id', licenses[0].id);

      this.logger.log(`Subscription renewed: extended license for ${email} to ${newExpiresAt}`);
    } else if (data.status === 'failed' || !data.paid) {
      // Payment failed — notify customer
      this.logger.warn(
        `\n${'─'.repeat(70)}\n` +
          `  PAYMENT FAILED — customer: ${email}\n` +
          `  Subscription  : ${data.subscription?.subscription_code ?? '?'}\n` +
          `  Paystack will retry automatically. License left active.\n` +
          `${'─'.repeat(70)}`,
      );
      const name = [data.customer.first_name, data.customer.last_name]
        .filter(Boolean)
        .join(' ') || email.split('@')[0];
      await this.sendPaymentFailedEmail(email, name);
    }
  }

  // ── subscription.disable → suspend license ─────────────────────────────────

  private async handleSubscriptionDisable(data: PaystackSubscriptionData): Promise<void> {
    if (!this.supabase) return;

    const email = data.customer.email;
    const userId = await this.resolveUserId(email);
    if (!userId) return;

    const { error } = await this.supabase
      .from('licenses')
      .update({
        status: 'suspended',
        activation_key_hash: '',
        updated_at: new Date().toISOString(),
      })
      .eq('owner_user_id', userId)
      .eq('status', 'active');

    if (error) {
      this.logger.error(`subscription.disable: failed to suspend license for ${email} — ${error.message}`);
      return;
    }

    this.logger.log(`Subscription disabled: suspended license for ${email}`);
  }

  // ── subscription.enable → reactivate license ───────────────────────────────

  private async handleSubscriptionEnable(data: PaystackSubscriptionData): Promise<void> {
    if (!this.supabase) return;

    const email = data.customer.email;
    const userId = await this.resolveUserId(email);
    if (!userId) return;

    const plan = planConfigFromPaystackPlan(data.plan);
    const newExpiresAt = data.next_payment_date
      ? new Date(Date.parse(data.next_payment_date) + GRACE_PERIOD_MS).toISOString()
      : this.futureIso(plan.days);

    const { data: updated, error } = await this.supabase
      .from('licenses')
      .update({
        status: 'active',
        expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('owner_user_id', userId)
      .eq('status', 'suspended')
      .select('id')
      .limit(1);

    if (error) {
      this.logger.error(`subscription.enable: failed to reactivate license for ${email} — ${error.message}`);
      return;
    }
    if (!updated?.length) {
      this.logger.warn(`subscription.enable: no suspended license for ${email}`);
      return;
    }

    const licenseId = updated[0].id as string;
    this.logger.log(`Subscription re-enabled: reactivated license ${licenseId} for ${email}`);
    await this.issueAndDeliverKey(licenseId, userId, email);
  }

  // ── refund.processed → suspend license ────────────────────────────────────

  private async handleRefundProcessed(data: PaystackChargeData): Promise<void> {
    if (!this.supabase) return;

    const email = data.customer.email;
    const userId = await this.resolveUserId(email);
    if (!userId) return;

    const { error } = await this.supabase
      .from('licenses')
      .update({
        status: 'suspended',
        activation_key_hash: '',
        updated_at: new Date().toISOString(),
      })
      .eq('owner_user_id', userId)
      .eq('status', 'active');

    if (error) {
      this.logger.error(`refund.processed: failed to suspend license for ${email} — ${error.message}`);
      return;
    }

    this.logger.log(`Refund processed: suspended license for ${email}`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async resolveOrCreateUser(
    email: string,
    displayName?: string,
  ): Promise<string | null> {
    const userId = await this.resolveUserId(email);
    if (userId) return userId;

    const { data, error } = await this.supabase!.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: displayName || email.split('@')[0] },
      password: randomBytes(24).toString('hex'),
    });

    if (error || !data.user) {
      this.logger.error(`Failed to create Supabase user for ${email}: ${error?.message}`);
      return null;
    }

    this.logger.log(`New Supabase user created: ${email} (${data.user.id})`);
    return data.user.id;
  }

  private async resolveUserId(email: string): Promise<string | null> {
    const params = { filter: `email.eq.${email}` } as unknown as Parameters<
      SupabaseClient['auth']['admin']['listUsers']
    >[0];
    const { data, error } = await this.supabase!.auth.admin.listUsers(params);
    if (error || !data) return null;
    return data.users[0]?.id ?? null;
  }

  private async createLicense(
    ownerUserId: string,
    expiresAt: string,
    reference: string,
    maxDevices: number,
  ): Promise<string | null> {
    const { data, error } = await this.supabase!.from('licenses')
      .insert({
        owner_user_id: ownerUserId,
        activation_key_hash: '',
        status: 'active',
        max_devices: maxDevices,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (error || !data) {
      this.logger.error(
        `Failed to create license for ${ownerUserId} (ref ${reference}): ${error?.message}`,
      );
      return null;
    }

    this.logger.log(`License created: ${data.id} for user ${ownerUserId} (ref ${reference})`);
    return data.id as string;
  }

  private async issueAndDeliverKey(
    licenseId: string,
    userId: string,
    email: string,
  ): Promise<void> {
    if (!this.pepper) {
      this.logger.error('ACTIVATION_KEY_PEPPER not configured — cannot issue key');
      return;
    }

    const raw = `TR-${randomBytes(20).toString('hex').toUpperCase()}`;
    const hash = createHmac('sha256', this.pepper).update(raw).digest('hex');

    const symbols = this.signalEngine.availableSymbols;
    if (symbols.length === 0) {
      this.logger.error(
        `Cannot issue key for license ${licenseId}: signal engine has no available symbols.`,
      );
      return;
    }

    const { error } = await this.supabase!.rpc('issue_activation_key', {
      p_license_id: licenseId,
      p_owner_user_id: userId,
      p_new_key_hash: hash,
      p_symbols: symbols,
    });

    if (error) {
      this.logger.error(`Failed to store activation key for license ${licenseId}: ${error.message}`);
      return;
    }

    await this.sendActivationKeyEmail(email, email.split('@')[0], raw, licenseId);
  }

  // ── Email delivery ─────────────────────────────────────────────────────────

  private async sendActivationKeyEmail(
    to: string,
    name: string,
    rawKey: string,
    licenseId: string,
  ): Promise<void> {
    this.logger.log(
      `\n${'─'.repeat(70)}\n` +
        `  ACTIVATION KEY READY — DELIVER TO: ${to}\n` +
        `  License ID : ${licenseId}\n` +
        `  Key        : ${rawKey}\n` +
        `${'─'.repeat(70)}`,
    );

    if (!this.mailer) {
      this.logger.warn('SMTP not configured — key logged above');
      return;
    }

    const licensesUrl = `${this.dashboardUrl}/app/licenses`;
    const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"/><title>Your Apex Quantel Activation Key</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">
        <tr><td style="background:#0f172a;padding:24px 32px;">
          <span style="color:#f1f5f9;font-size:20px;font-weight:700;">Apex Quantel</span>
        </td></tr>
        <tr><td style="padding:32px;">
          <h1 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700;">Your activation key is ready</h1>
          <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
            Hi ${name}, thanks for your purchase. Copy the key below and paste it into your AQ Agent's
            <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:13px;">config.yaml</code>.
          </p>
          <div style="background:#0f172a;border-radius:6px;padding:18px 22px;margin:0 0 24px;word-break:break-all;">
            <code style="color:#22d3ee;font-family:monospace;font-size:14px;letter-spacing:.04em;">${rawKey}</code>
          </div>
          <p style="margin:0 0 28px;color:#64748b;font-size:13px;">
            Keep this key private — it is shown only once. Rotate it from your dashboard if lost.
          </p>
          <a href="${licensesUrl}" style="display:inline-block;background:#3b82f6;color:#fff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600;">
            Open Dashboard &rarr;
          </a>
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;">
          <p style="margin:0;color:#94a3b8;font-size:12px;">License&nbsp;ID:&nbsp;${licenseId} &middot; Sent to ${to}</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const text = [
      `Hi ${name},`,
      '',
      'Your Apex Quantel activation key is ready.',
      '',
      `  ${rawKey}`,
      '',
      'Paste this into your AQ Agent config.yaml under gateway.activation_key.',
      'Keep this key private — rotate it from your dashboard if lost.',
      '',
      `Dashboard: ${licensesUrl}`,
      `License ID: ${licenseId}`,
    ].join('\n');

    try {
      const info = (await this.mailer.sendMail({
        from: this.emailFrom,
        to,
        subject: 'Your Apex Quantel Activation Key',
        html,
        text,
      })) as { messageId?: string };
      this.logger.log(`Activation key email sent to ${to} — messageId: ${info.messageId}`);
    } catch (err) {
      this.logger.error(`Failed to send activation key email to ${to}: ${String(err)}`);
    }
  }

  private async sendPaymentFailedEmail(to: string, name: string): Promise<void> {
    if (!this.mailer) {
      this.logger.warn(`SMTP not configured — payment-failed notice for ${to} logged only`);
      return;
    }

    const billingUrl = `${this.dashboardUrl}/app/billing`;
    const text = [
      `Hi ${name},`,
      '',
      'We could not process the latest payment for your Apex Quantel subscription.',
      'Your license remains active and Paystack will retry the charge automatically.',
      '',
      `Update your payment method here: ${billingUrl}`,
      '',
      '— Apex Quantel',
    ].join('\n');

    try {
      await this.mailer.sendMail({
        from: this.emailFrom,
        to,
        subject: 'Action needed: your Apex Quantel payment failed',
        text,
      });
      this.logger.log(`Payment-failed email sent to ${to}`);
    } catch (err) {
      this.logger.error(`Failed to send payment-failed email to ${to}: ${String(err)}`);
    }
  }

  private futureIso(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString();
  }
}
