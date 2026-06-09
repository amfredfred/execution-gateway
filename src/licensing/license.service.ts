import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  LicenseActivationContext,
  LicenseActivationResult,
} from './license.types';
import { SignalEngineSubscriberService } from '../signal-engine/signal-engine-subscriber.service';

interface ActivationRpcRow {
  license_id: string;
  engine_device_id: string;
  expires_at: string | null;
  symbols: string[];
}

@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);
  private readonly supabase?: SupabaseClient;
  private readonly activationKeyPepper?: string;

  constructor(
    private readonly config: ConfigService,
    private readonly signalEngine: SignalEngineSubscriberService,
  ) {
    this.activationKeyPepper = this.config.get<string>(
      'licensing.activationKeyPepper',
    );
    const supabaseUrl = this.config.get<string>('supabase.url');
    const serviceRoleKey = this.config.get<string>('supabase.serviceRoleKey');
    if (supabaseUrl && serviceRoleKey) {
      this.supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  /**
   * Activates an engine against the Supabase license store.
   * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and
   * ACTIVATION_KEY_PEPPER to be set. Returns an error result if any are missing.
   */
  async activate(
    activationKey: string,
    context?: LicenseActivationContext,
  ): Promise<LicenseActivationResult> {
    if (!this.supabase || !this.activationKeyPepper) {
      this.logger.warn(
        'Supabase activation attempted but gateway is not fully configured ' +
        '(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or ACTIVATION_KEY_PEPPER missing)',
      );
      return {
        ok: false,
        errors: ['Gateway is not configured for license activation'],
      };
    }
    if (!context) {
      return {
        ok: false,
        errors: ['Activation context (engine metadata) is required'],
      };
    }
    return this.activateWithSupabase(activationKey, context);
  }

  /**
   * Generates a fresh activation key, hashes it with the pepper, stores the
   * hash in Supabase via the `issue_activation_key` RPC, and returns the raw
   * key. The raw key is never stored — the caller must display it once.
   *
   * Returns `{ raw }` on success or `{ error }` on failure.
   */
  async issueKey(
    licenseId: string,
    userId: string,
  ): Promise<{ raw: string } | { error: string }> {
    if (!this.supabase || !this.activationKeyPepper) {
      return { error: 'Key issuance requires Supabase and ACTIVATION_KEY_PEPPER' };
    }

    const raw = `TR-${randomBytes(20).toString('hex').toUpperCase()}`;
    const hash = createHmac('sha256', this.activationKeyPepper)
      .update(raw)
      .digest('hex');

    const symbols = this.signalEngine.availableSymbols;
    if (symbols.length === 0) {
      this.logger.warn(
        `Key issuance for license ${licenseId}: signal engine has no available symbols — ` +
        'ensure the signal engine is connected before issuing keys',
      );
      return { error: 'Signal engine not connected — no symbols available to entitle' };
    }

    const { error } = await this.supabase.rpc('issue_activation_key', {
      p_license_id:    licenseId,
      p_owner_user_id: userId,
      p_new_key_hash:  hash,
      p_symbols:       symbols,
    });

    if (error) {
      this.logger.warn(`Key issuance failed for license ${licenseId}: ${error.message}`);
      return { error: error.message };
    }

    this.logger.log(
      `Activation key issued for license ${licenseId} — symbols: ${symbols.join(', ')}`,
    );
    return { raw };
  }

  /**
   * Clears the activation key hash and suspends the license.
   * No new engine activations are possible until a new key is issued.
   * Existing engine sessions remain until the heartbeat sweep expires them.
   */
  async revokeKey(
    licenseId: string,
    userId: string,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.supabase) {
      return { ok: false, error: 'Supabase is not configured' };
    }

    const { error } = await this.supabase.rpc('revoke_license_key', {
      p_license_id:    licenseId,
      p_owner_user_id: userId,
    });

    if (error) {
      this.logger.warn(`Key revocation failed for license ${licenseId}: ${error.message}`);
      return { ok: false, error: error.message };
    }

    this.logger.log(`Activation key revoked for license ${licenseId}`);
    return { ok: true };
  }

  /**
   * Generates a device-bound credential (TRDC-<64 hex>), stores its
   * HMAC-SHA256 hash in `engine_devices.credential_hash`, and returns the
   * plaintext.  Returns null on any failure — callers should proceed without
   * the credential rather than blocking activation.
   *
   * 1.16 — called after every successful activation (full or fast-path) so the
   * engine always holds a fresh rotated credential.
   */
  async issueDeviceCredential(engineDeviceId: string): Promise<string | null> {
    if (!this.supabase || !this.activationKeyPepper) return null;

    const raw = `TRDC-${randomBytes(32).toString('hex').toUpperCase()}`;
    const hash = createHmac('sha256', this.activationKeyPepper)
      .update(raw)
      .digest('hex');

    const { error } = await this.supabase
      .from('engine_devices')
      .update({ credential_hash: hash, updated_at: new Date().toISOString() })
      .eq('id', engineDeviceId);

    if (error) {
      this.logger.warn(
        `Credential issuance failed for device ${engineDeviceId}: ${error.message}`,
      );
      return null;
    }

    this.logger.log(`Device credential issued for ${engineDeviceId}`);
    return raw;
  }

  /**
   * Verifies a device credential presented in `engine.hello`.
   * Queries `engine_devices`, checks the HMAC-SHA256 hash in constant time,
   * validates the license is still active and not expired, then returns the
   * full activation result so the caller can fast-path authorize the socket.
   *
   * Returns null on any verification failure (bad credential, expired license,
   * Supabase error).  Never throws.
   *
   * 1.16 — fast-path reconnect: avoids the full activation.request round-trip.
   */
  async verifyDeviceCredential(
    engineId: string,
    credential: string,
  ): Promise<LicenseActivationResult | null> {
    if (!this.supabase || !this.activationKeyPepper) return null;

    try {
      const resp = await this.supabase
        .from('engine_devices')
        .select(`
          id,
          credential_hash,
          license:licenses!inner(
            id,
            status,
            expires_at,
            entitlements:license_symbol_entitlements(symbol)
          )
        `)
        .eq('engine_id', engineId)
        .eq('status', 'active')
        .maybeSingle();

      if (resp.error || !resp.data) return null;

      const device = resp.data as unknown as {
        id: string;
        credential_hash: string | null;
        license: {
          id: string;
          status: string;
          expires_at: string | null;
          entitlements: { symbol: string }[];
        };
      };

      if (!device.credential_hash) return null;

      // License must be active and not expired
      const lic = device.license;
      if (lic.status !== 'active') return null;
      if (lic.expires_at && Date.parse(lic.expires_at) <= Date.now()) return null;

      // Constant-time HMAC comparison
      const expected = createHmac('sha256', this.activationKeyPepper!)
        .update(credential)
        .digest();
      const stored = Buffer.from(device.credential_hash, 'hex');

      if (expected.length !== stored.length || !timingSafeEqual(expected, stored)) {
        return null;
      }

      const symbols = new Set(
        lic.entitlements.map((e) => this.normalize(e.symbol)),
      );

      return {
        ok: true,
        errors: [],
        activation: {
          licenseId: lic.id,
          engineDeviceId: device.id,
          symbols,
          expiresAt: lic.expires_at,
        },
      };
    } catch (err) {
      this.logger.warn(
        `Credential verification error for engine ${engineId}: ${String(err)}`,
      );
      return null;
    }
  }

  async userOwnsEngine(userId: string, engineId: string): Promise<boolean> {
    if (!this.supabase) return false;
    const response = await this.supabase
      .from('engine_devices')
      .select('license:licenses!inner(owner_user_id)')
      .eq('engine_id', engineId)
      .eq('status', 'active')
      .maybeSingle();
    if (response.error || !response.data) return false;
    const license = response.data.license as unknown as
      | { owner_user_id?: string }
      | { owner_user_id?: string }[];
    const owner = Array.isArray(license)
      ? license[0]?.owner_user_id
      : license?.owner_user_id;
    return owner === userId;
  }

  private async activateWithSupabase(
    activationKey: string,
    context: LicenseActivationContext,
  ): Promise<LicenseActivationResult> {
    const activationKeyHash = createHmac('sha256', this.activationKeyPepper!)
      .update(activationKey)
      .digest('hex');
    const response = await this.supabase!.rpc('activate_engine', {
      p_activation_key_hash: activationKeyHash,
      p_engine_id: context.engineId,
      p_device_name: context.deviceName,
      p_engine_version: context.engineVersion,
      p_platform: context.platform,
    });
    const error = response.error;
    const data = response.data as unknown;

    if (error) {
      this.logger.warn(`Supabase activation rejected: ${error.message}`);
      return { ok: false, errors: [error.message] };
    }
    const row = (data as ActivationRpcRow[] | null)?.[0];
    if (!row) return { ok: false, errors: ['activation returned no result'] };

    return {
      ok: true,
      errors: [],
      activation: {
        licenseId: row.license_id,
        engineDeviceId: row.engine_device_id,
        symbols: new Set(row.symbols.map((symbol) => this.normalize(symbol))),
        expiresAt: row.expires_at,
      },
    };
  }

  private normalize(symbol: string) {
    return symbol.trim().replaceAll('/', '').toUpperCase();
  }
}
