import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomBytes } from 'node:crypto';

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
  user_email?: string;
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

@Injectable()
export class WebhookService {
  private readonly logger = new Logger(WebhookService.name);
  private readonly supabase?: SupabaseClient;
  private readonly pepper?: string;
  private readonly webhookSecret?: string;

  constructor(private readonly config: ConfigService) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    this.pepper = config.get<string>('licensing.activationKeyPepper');
    this.webhookSecret = config.get<string>('webhooks.lemonSqueezySecret');

    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  // ── Signature verification ─────────────────────────────────────────────────

  /**
   * Verifies the X-Signature header from Lemon Squeezy.
   * Returns true if the signature matches, false otherwise.
   */
  verifySignature(rawBody: Buffer, signature: string): boolean {
    if (!this.webhookSecret) {
      this.logger.warn(
        'LEMON_SQUEEZY_WEBHOOK_SECRET not set — skipping signature verification (development mode)',
      );
      return true; // Allow in development; enforce in production via env var
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
      case 'subscription_payment_success':
        await this.handleSubscriptionRenewed(payload);
        break;
      case 'subscription_cancelled':
      case 'subscription_expired':
        await this.handleSubscriptionEnded(payload);
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
    const expiresAt = this.futureIso(DEFAULT_LICENSE_DAYS);

    // Resolve or create Supabase user
    const userId = await this.resolveOrCreateUser(email, attrs.customer_name);
    if (!userId) return;

    // Insert license row
    const licenseId = await this.createLicense(userId, expiresAt, orderId);
    if (!licenseId) return;

    // Issue activation key and deliver
    await this.issueAndDeliverKey(licenseId, userId, email);
  }

  // ── Subscription renewed → extend expiry ──────────────────────────────────

  private async handleSubscriptionRenewed(payload: LsWebhookPayload): Promise<void> {
    if (!this.supabase) return;

    const attrs = payload.data.attributes as LsSubscriptionAttributes;
    const email = attrs.customer_email || attrs.user_email;
    if (!email) return;

    // Find the user
    const userId = await this.resolveUserId(email);
    if (!userId) return;

    // Extend all active licenses for this user
    const newExpiresAt = attrs.renews_at
      ? new Date(
          new Date(attrs.renews_at).getTime() + DEFAULT_LICENSE_DAYS * 86_400_000,
        ).toISOString()
      : this.futureIso(DEFAULT_LICENSE_DAYS);

    const { error } = await this.supabase
      .from('licenses')
      .update({ expires_at: newExpiresAt, updated_at: new Date().toISOString() })
      .eq('owner_user_id', userId)
      .eq('status', 'active');

    if (error) {
      this.logger.error(`Subscription renewed: failed to extend license — ${error.message}`);
      return;
    }

    this.logger.log(`Subscription renewed: extended license for ${email} to ${newExpiresAt}`);
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

  private async resolveUserId(email: string): Promise<string | null> {
    const { data, error } = await this.supabase!.auth.admin.listUsers();
    if (error || !data) return null;
    const user = data.users.find((u) => u.email === email);
    return user?.id ?? null;
  }

  private async createLicense(
    ownerUserId: string,
    expiresAt: string,
    orderId: string,
  ): Promise<string | null> {
    const { data, error } = await this.supabase!
      .from('licenses')
      .insert({
        owner_user_id: ownerUserId,
        activation_key_hash: '', // will be set by issueKey
        status: 'pending',
        max_devices: DEFAULT_MAX_DEVICES,
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

    const { error } = await this.supabase!.rpc('issue_activation_key', {
      p_license_id: licenseId,
      p_owner_user_id: userId,
      p_new_key_hash: hash,
    });

    if (error) {
      this.logger.error(
        `Failed to store activation key for license ${licenseId}: ${error.message}`,
      );
      return;
    }

    // ── Deliver the key ──────────────────────────────────────────────────────
    // TODO: Replace this with a real transactional email via Resend / Supabase email.
    // The raw key MUST be delivered to the customer exactly once and never re-shown.
    // For now, we log it prominently so it can be manually delivered during testing.
    this.logger.warn(
      `\n${'─'.repeat(70)}\n` +
        `  ACTIVATION KEY READY — DELIVER TO: ${email}\n` +
        `  License ID : ${licenseId}\n` +
        `  Key        : ${raw}\n` +
        `  (Wire a transactional email service here — Resend, Postmark, etc.)\n` +
        `${'─'.repeat(70)}`,
    );
  }

  private futureIso(days: number): string {
    return new Date(Date.now() + days * 86_400_000).toISOString();
  }
}
