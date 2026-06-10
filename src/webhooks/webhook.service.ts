import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomBytes } from 'node:crypto';
import * as nodemailer from 'nodemailer';
import { SignalEngineSubscriberService } from '../signal-engine/signal-engine-subscriber.service';

// ─── Lemon Squeezy event payload shapes (partial) ─────────────────────────────

interface LsCustomer {
  email: string;
  name?: string;
}

interface LsOrderAttributes {
  status: string;
  customer_email: string;
  customer_name?: string;
  first_order_item?: {
    variant_id: number;
    product_name?: string;
  };
  user_email?: string;
  total?: number;
  currency?: string;
  created_at?: string;
}

interface LsSubscriptionAttributes {
  status: string;
  customer_email: string;
  user_name?: string;
  user_email?: string;
  variant_id?: number;
  ends_at?: string | null;
  renews_at?: string | null;
  trial_ends_at?: string | null;
  created_at?: string;
}

interface LsWebhookPayload {
  meta: {
    event_name: string;
    custom_data?: Record<string, unknown>;
  };
  data: {
    id: string;
    type: string;
    attributes: LsOrderAttributes | LsSubscriptionAttributes;
  };
}

// ─── Default trial / plan durations ───────────────────────────────────────────

const DEFAULT_LICENSE_DAYS = 30;
const DEFAULT_MAX_DEVICES = 3;

// ─── Lemon Squeezy variant → plan config ──────────────────────────────────────
// Set NEXT_PUBLIC_LS_VARIANT_STARTER, _PRO, _INFRASTRUCTURE in the gateway env
// to match the variant IDs from your Lemon Squeezy dashboard.
// Falls back to DEFAULT_MAX_DEVICES (3) for any unrecognised variant.
interface PlanConfig { maxDevices: number; days: number }

function planConfigFromVariant(
  variantId: number | undefined,
  config: import('@nestjs/config').ConfigService,
): PlanConfig {
  if (variantId === undefined) return { maxDevices: DEFAULT_MAX_DEVICES, days: DEFAULT_LICENSE_DAYS };

  const v = Number(variantId);
  const get = (key: string) => { const n = config.get<number>(key); return n ? Number(n) : undefined; };

  if (get('licensing.variantStarterMonthly') === v) return { maxDevices: 1, days: 30  };
  if (get('licensing.variantStarterYearly')  === v) return { maxDevices: 1, days: 365 };
  if (get('licensing.variantProMonthly')     === v) return { maxDevices: 3, days: 30  };
  if (get('licensing.variantProYearly')      === v) return { maxDevices: 3, days: 365 };
  if (get('licensing.variantInfrastructure') === v) return { maxDevices: 9999, days: 365 };

  return { maxDevices: DEFAULT_MAX_DEVICES, days: DEFAULT_LICENSE_DAYS };
}

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly supabase?: SupabaseClient;
  private readonly pepper?: string;
  private readonly webhookSecret?: string;
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
    this.webhookSecret = config.get<string>('webhooks.lemonSqueezySecret');
    this.emailFrom = config.get<string>('smtp.from') ?? 'Apex Quantel <noreply@apexquantel.io>';
    this.dashboardUrl = config.get<string>('dashboard.url') ?? 'https://app.apexquantel.io';

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
      this.logger.log(`SMTP configured: ${smtpHost}:${config.get<number>('smtp.port') ?? 587}`);
    } else {
      this.logger.warn(
        'SMTP_HOST not set — activation keys will be logged to console only (dev mode)',
      );
    }
  }

  // ── Signature verification ─────────────────────────────────────────────────

  /**
   * Verifies the X-Signature header from Lemon Squeezy.
   * Returns true if the signature matches, false otherwise.
   */
  verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!this.webhookSecret) {
      const isProduction = this.config.get<string>('NODE_ENV') === 'production'
        || process.env['NODE_ENV'] === 'production';
      if (isProduction) {
        // BUG-07: Never accept unsigned webhooks in production — forged events would
        // bypass licensing entirely. Reject hard so ops notice the misconfiguration.
        this.logger.error(
          'LEMON_SQUEEZY_WEBHOOK_SECRET is not set in production — rejecting all webhook calls. ' +
          'Set the env var to the Lemon Squeezy signing secret immediately.',
        );
        return false;
      }
      this.logger.warn(
        'LEMON_SQUEEZY_WEBHOOK_SECRET not set — skipping signature verification (development mode only)',
      );
      return true;
    }
    const expected = createHmac('sha256', this.webhookSecret)
      .update(rawBody)
      .digest('hex');
    // Constant-time comparison to prevent timing attacks
    if (expected.length !== signature.length) return false;
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) {
      mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    return mismatch === 0;
  }

  // ── Event routing ──────────────────────────────────────────────────────────

  async handleEvent(payload: LsWebhookPayload): Promise<void> {
    const event = payload.meta.event_name;
    this.logger.log(`Lemon Squeezy webhook: ${event}`);

    switch (event) {
      case 'order_created':
        await this.handleOrderCreated(payload);
        break;
      case 'subscription_created':
        await this.handleSubscriptionCreated(payload);
        break;
      case 'subscription_payment_success':
        await this.handleSubscriptionRenewed(payload);
        break;
      case 'subscription_cancelled':
      case 'subscription_expired':
        await this.handleSubscriptionEnded(payload);
        break;
      case 'subscription_payment_failed':
        await this.handlePaymentFailed(payload);
        break;
      case 'subscription_resumed':
      case 'subscription_unpaused':
        await this.handleSubscriptionResumed(payload);
        break;
      case 'subscription_plan_changed':
        await this.handlePlanChanged(payload);
        break;
      case 'order_refunded':
        await this.handleOrderRefunded(payload);
        break;
      default:
        this.logger.debug(`Unhandled Lemon Squeezy event: ${event}`);
    }
  }

  // ── Order created → new license ────────────────────────────────────────────

  private async handleOrderCreated(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) {
      this.logger.error('Supabase not configured — cannot create license from order');
      return;
    }

    const attrs = payload.data.attributes as LsOrderAttributes;
    const email = attrs.customer_email || attrs.user_email;
    if (!email) {
      this.logger.error('Order created: no customer email in payload');
      return;
    }

    const orderId = payload.data.id;
    const plan    = planConfigFromVariant(attrs.first_order_item?.variant_id, this.config);
    const expiresAt = this.futureIso(plan.days);

    // Use supabase_user_id from checkout custom data if present (pre-linked at checkout),
    // otherwise resolve/create by email.
    const knownUserId = payload.meta.custom_data?.supabase_user_id as string | undefined;
    const userId = knownUserId
      ? await this.resolveUserById(knownUserId) ?? await this.resolveOrCreateUser(email, attrs.customer_name)
      : await this.resolveOrCreateUser(email, attrs.customer_name);
    if (!userId) return;

    // Insert license row
    const licenseId = await this.createLicense(userId, expiresAt, orderId, plan.maxDevices);
    if (!licenseId) return;

    // Issue activation key and deliver
    await this.issueAndDeliverKey(licenseId, userId, email);
  }

  // ── Subscription created → new license ────────────────────────────────────
  // Fired when a customer starts a new subscription (distinct from order_created
  // which fires for one-time purchases). Both flows provision a license + key.

  private async handleSubscriptionCreated(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) {
      this.logger.error('Supabase not configured — cannot create license from subscription');
      return;
    }

    const attrs  = payload.data.attributes as LsSubscriptionAttributes;
    const email  = attrs.customer_email || attrs.user_email;
    if (!email) {
      this.logger.error('subscription_created: no customer email in payload');
      return;
    }

    const plan      = planConfigFromVariant(attrs.variant_id, this.config);
    const expiresAt = attrs.renews_at
      ? new Date(new Date(attrs.renews_at).getTime() + plan.days * 86_400_000).toISOString()
      : this.futureIso(plan.days);

    const knownUserId = payload.meta.custom_data?.supabase_user_id as string | undefined;
    const userId = knownUserId
      ? await this.resolveUserById(knownUserId) ?? await this.resolveOrCreateUser(email, attrs.user_name)
      : await this.resolveOrCreateUser(email, attrs.user_name);
    if (!userId) return;

    // Guard: skip if this user already has an active license (e.g. order_created
    // already ran for the same purchase).
    const { data: existing } = await this.supabase
      .from('licenses')
      .select('id')
      .eq('owner_user_id', userId)
      .eq('status', 'active')
      .limit(1);

    if (existing && existing.length > 0) {
      this.logger.log(
        `subscription_created: user ${email} already has an active license — skipping duplicate provision`,
      );
      return;
    }

    const licenseId = await this.createLicense(userId, expiresAt, payload.data.id, plan.maxDevices);
    if (!licenseId) return;

    await this.issueAndDeliverKey(licenseId, userId, email);
  }

  // ── Subscription renewed → extend expiry ──────────────────────────────────

  private async handleSubscriptionRenewed(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) return;

    const attrs = payload.data.attributes as LsSubscriptionAttributes;
    const email = attrs.customer_email || attrs.user_email;
    if (!email) return;

    const userId = await this.resolveUserId(email);
    if (!userId) return;

    const newExpiresAt = attrs.renews_at
      ? new Date(
          new Date(attrs.renews_at).getTime() + DEFAULT_LICENSE_DAYS * 86_400_000,
        ).toISOString()
      : this.futureIso(DEFAULT_LICENSE_DAYS);

    // BUG-05: Select the single most-recently-created active license so we never
    // accidentally extend every license a user holds when only one subscription renewed.
    const { data: licenses, error: selectErr } = await this.supabase
      .from('licenses')
      .select('id')
      .eq('owner_user_id', userId)
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(1);

    if (selectErr || !licenses?.length) {
      this.logger.warn(`Subscription renewed: no active license found for ${email}`);
      return;
    }

    if (licenses.length > 1) {
      // Defensive — limit(1) above should prevent this, but log if Supabase returns more.
      this.logger.warn(
        `Subscription renewed: multiple active licenses for ${email} — extending only the most recent`,
      );
    }

    const licenseId = licenses[0].id as string;
    const { error } = await this.supabase
      .from('licenses')
      .update({ expires_at: newExpiresAt, updated_at: new Date().toISOString() })
      .eq('id', licenseId);

    if (error) {
      this.logger.error(`Subscription renewed: failed to extend license ${licenseId} — ${error.message}`);
      return;
    }

    this.logger.log(
      `Subscription renewed: extended license ${licenseId} for ${email} to ${newExpiresAt}`,
    );
  }

  // ── Subscription cancelled/expired → suspend license ─────────────────────

  private async handleSubscriptionEnded(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) return;

    const attrs = payload.data.attributes as LsSubscriptionAttributes;
    const email = attrs.customer_email || attrs.user_email;
    if (!email) return;

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
      this.logger.error(`Subscription ended: failed to suspend license — ${error.message}`);
      return;
    }

    this.logger.log(`Subscription ended: suspended license for ${email}`);
  }

  // ── Payment failed → log only (LS will retry) ─────────────────────────────

  private async handlePaymentFailed(payload: LsWebhookPayload): Promise<void> {
    const attrs = payload.data.attributes as LsSubscriptionAttributes;
    const email = (attrs.customer_email || attrs.user_email) ?? '(unknown)';
    // Lemon Squeezy retries failed payments automatically; the license remains
    // active during the retry window.  We log prominently so ops can monitor.
    this.logger.warn(
      `\n${'─'.repeat(70)}\n` +
      `  PAYMENT FAILED — customer: ${email}\n` +
      `  Subscription ID : ${payload.data.id}\n` +
      `  LS will retry automatically. License left active.\n` +
      `${'─'.repeat(70)}`,
    );
  }

  // ── Subscription resumed / unpaused → reactivate license ──────────────────

  private async handleSubscriptionResumed(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) return;

    const attrs = payload.data.attributes as LsSubscriptionAttributes;
    const email = attrs.customer_email || attrs.user_email;
    if (!email) return;

    const userId = await this.resolveUserId(email);
    if (!userId) return;

    const newExpiresAt = attrs.renews_at
      ? new Date(
          new Date(attrs.renews_at).getTime() + DEFAULT_LICENSE_DAYS * 86_400_000,
        ).toISOString()
      : this.futureIso(DEFAULT_LICENSE_DAYS);

    // BUG-06: Reactivate and return the license ID so we can re-issue the key.
    // When a subscription is suspended, activation_key_hash is cleared — the
    // customer would have an active license but no usable key without this step.
    const { data: updated, error } = await this.supabase
      .from('licenses')
      .update({ status: 'active', expires_at: newExpiresAt, updated_at: new Date().toISOString() })
      .eq('owner_user_id', userId)
      .eq('status', 'suspended')
      .select('id')
      .limit(1);

    if (error) {
      this.logger.error(`Subscription resumed: failed to reactivate license for ${email} — ${error.message}`);
      return;
    }

    if (!updated?.length) {
      this.logger.warn(`Subscription resumed: no suspended license found for ${email} — nothing to reactivate`);
      return;
    }

    const licenseId = updated[0].id as string;
    this.logger.log(`Subscription resumed: reactivated license ${licenseId} for ${email}`);

    // Re-issue a fresh activation key — the previous one was cleared on suspension.
    await this.issueAndDeliverKey(licenseId, userId, email);
  }

  // ── Plan changed → update max_devices ─────────────────────────────────────

  private async handlePlanChanged(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) return;

    const attrs = payload.data.attributes as LsSubscriptionAttributes;
    const email = attrs.customer_email || attrs.user_email;
    if (!email) return;

    const userId = await this.resolveUserId(email);
    if (!userId) return;

    const plan = planConfigFromVariant(attrs.variant_id, this.config);
    const newExpiresAt = attrs.renews_at
      ? new Date(
          new Date(attrs.renews_at).getTime() + plan.days * 86_400_000,
        ).toISOString()
      : this.futureIso(plan.days);

    const { error } = await this.supabase
      .from('licenses')
      .update({
        max_devices: plan.maxDevices,
        expires_at: newExpiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('owner_user_id', userId)
      .eq('status', 'active');

    if (error) {
      this.logger.error(`Plan changed: failed to update license for ${email} — ${error.message}`);
      return;
    }

    this.logger.log(
      `Plan changed: updated license for ${email} — max_devices=${plan.maxDevices}, expires=${newExpiresAt}`,
    );
  }

  // ── Order refunded → suspend license ──────────────────────────────────────

  private async handleOrderRefunded(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) return;

    const attrs = payload.data.attributes as LsOrderAttributes;
    const email = attrs.customer_email || attrs.user_email;
    if (!email) return;

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
      this.logger.error(`Order refunded: failed to suspend license for ${email} — ${error.message}`);
      return;
    }

    this.logger.log(`Order refunded: suspended license for ${email}`);
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async resolveOrCreateUser(
    email: string,
    displayName?: string,
  ): Promise<string | null> {
    const userId = await this.resolveUserId(email);
    if (userId) return userId;

    // Create a new Supabase user with a random password (they will use magic link to sign in)
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

  private async resolveUserById(id: string): Promise<string | null> {
    const { data, error } = await this.supabase!.auth.admin.getUserById(id);
    if (error || !data.user) return null;
    return data.user.id;
  }

  private async resolveUserId(email: string): Promise<string | null> {
    // supabase-js v2 PageParams type omits `filter`, but GoTrue admin API supports it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await this.supabase!.auth.admin.listUsers({ filter: `email.eq.${email}` } as any);
    if (error || !data) return null;
    return data.users[0]?.id ?? null;
  }

  private async createLicense(
    ownerUserId: string,
    expiresAt: string,
    orderId: string,
    maxDevices: number = DEFAULT_MAX_DEVICES,
  ): Promise<string | null> {
    const { data, error } = await this.supabase!
      .from('licenses')
      .insert({
        owner_user_id: ownerUserId,
        activation_key_hash: '', // will be updated by issueKey
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
        `Failed to create license for user ${ownerUserId} (order ${orderId}): ${error?.message}`,
      );
      return null;
    }

    this.logger.log(
      `License created: ${data.id} for user ${ownerUserId} (order ${orderId})`,
    );
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
        `Cannot issue key for license ${licenseId}: signal engine has no available symbols. ` +
        'Ensure the signal engine is connected before processing orders.',
      );
      return;
    }

    const { error } = await this.supabase!.rpc('issue_activation_key', {
      p_license_id:    licenseId,
      p_owner_user_id: userId,
      p_new_key_hash:  hash,
      p_symbols:       symbols,
    });

    if (error) {
      this.logger.error(
        `Failed to store activation key for license ${licenseId}: ${error.message}`,
      );
      return;
    }

    // ── Deliver the key ──────────────────────────────────────────────────────
    await this.sendActivationKeyEmail(email, email.split('@')[0], raw, licenseId);
  }

  // ── Email delivery ─────────────────────────────────────────────────────────

  private async sendActivationKeyEmail(
    to: string,
    name: string,
    rawKey: string,
    licenseId: string,
  ): Promise<void> {
    // Always log prominently so the key is never silently lost
    this.logger.log(
      `\n${'─'.repeat(70)}\n` +
        `  ACTIVATION KEY READY — DELIVER TO: ${to}\n` +
        `  License ID : ${licenseId}\n` +
        `  Key        : ${rawKey}\n` +
        `${'─'.repeat(70)}`,
    );

    if (!this.mailer) {
      this.logger.warn(
        'SMTP not configured — key logged above; set SMTP_HOST to enable email delivery',
      );
      return;
    }

    const subject = 'Your Apex Quantel Activation Key';
    const html = this.buildActivationEmail(name, rawKey, licenseId, to);
    const text = this.buildActivationEmailText(name, rawKey, licenseId);

    try {
      const info = await this.mailer.sendMail({
        from: this.emailFrom,
        to,
        subject,
        html,
        text,
      });
      this.logger.log(`Activation key email sent to ${to} — messageId: ${info.messageId}`);
    } catch (err) {
      // Email failure must NOT block the flow — key is already stored in Supabase.
      // Customer can retrieve it from the dashboard; log the error for ops visibility.
      this.logger.error(
        `Failed to send activation key email to ${to}: ${String(err)}`,
      );
    }
  }

  private buildActivationEmail(
    name: string,
    rawKey: string,
    licenseId: string,
    email: string,
  ): string {
    const licensesUrl = `${this.dashboardUrl}/app/licenses`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Your Apex Quantel Activation Key</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:40px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.08);">

        <!-- Header -->
        <tr>
          <td style="background:#0f172a;padding:24px 32px;">
            <span style="color:#f1f5f9;font-size:20px;font-weight:700;letter-spacing:-0.02em;">Apex Quantel</span>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px;">
            <h1 style="margin:0 0 8px;color:#0f172a;font-size:22px;font-weight:700;">Your activation key is ready</h1>
            <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
              Hi ${name}, thanks for your purchase. Copy the key below and paste it into your AQ Agent's
              <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:13px;">config.yaml</code>
              under <code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:13px;">gateway.activation_key</code>.
            </p>

            <!-- Key block -->
            <div style="background:#0f172a;border-radius:6px;padding:18px 22px;margin:0 0 24px;word-break:break-all;">
              <code style="color:#22d3ee;font-family:'Menlo','Consolas','Courier New',monospace;font-size:14px;letter-spacing:0.04em;">${rawKey}</code>
            </div>

            <p style="margin:0 0 28px;color:#64748b;font-size:13px;line-height:1.6;">
              ⚠️&nbsp; Keep this key private. It is shown only once and cannot be retrieved later.
              If you lose it, you can rotate it from your dashboard.
            </p>

            <a href="${licensesUrl}"
               style="display:inline-block;background:#3b82f6;color:#ffffff;text-decoration:none;padding:11px 22px;border-radius:6px;font-size:14px;font-weight:600;">
              Open Dashboard &rarr;
            </a>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;">
              License&nbsp;ID:&nbsp;${licenseId} &middot; Sent to ${email}
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;
  }

  private buildActivationEmailText(
    name: string,
    rawKey: string,
    licenseId: string,
  ): string {
    return [
      `Hi ${name},`,
      '',
      'Your Apex Quantel activation key is ready.',
      '',
      `  ${rawKey}`,
      '',
      'Paste this into your AQ Agent config.yaml under gateway.activation_key.',
      '',
      '⚠️  Keep this key private. It is shown only once.',
      'If you lose it, rotate it from your dashboard.',
      '',
      `Dashboard: ${this.dashboardUrl}/app/licenses`,
      '',
      `License ID: ${licenseId}`,
    ].join('\n');
  }

  private futureIso(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString();
  }
}
