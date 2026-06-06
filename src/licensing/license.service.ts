import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type {
  LicenseActivationContext,
  LicenseActivationResult,
  LicenseRecord,
} from './license.types';

interface ActivationRpcRow {
  license_id: string;
  engine_device_id: string;
  expires_at: string | null;
  symbols: string[];
}

@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);
  private readonly licenses: LicenseRecord[];
  private readonly supabase?: SupabaseClient;
  private readonly activationKeyPepper?: string;

  constructor(private readonly config: ConfigService) {
    this.licenses = this.loadLicenses(
      this.config.get<string>('licensing.licensesJson', '[]'),
    );
    this.activationKeyPepper = this.config.get<string>(
      'licensing.activationKeyPepper',
    );
    const supabaseUrl = this.config.get<string>('supabase.url');
    const serviceRoleKey = this.config.get<string>('supabase.serviceRoleKey');
    if (supabaseUrl && serviceRoleKey && this.activationKeyPepper) {
      this.supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  async activate(
    activationKey: string,
    context?: LicenseActivationContext,
  ): Promise<LicenseActivationResult> {
    if (this.supabase && this.activationKeyPepper && context) {
      return this.activateWithSupabase(activationKey, context);
    }
    return this.activateConfigured(activationKey);
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

  private activateConfigured(activationKey: string): LicenseActivationResult {
    const record = this.licenses.find((license) =>
      this.keysMatch(license.activation_key, activationKey),
    );
    if (!record) return { ok: false, errors: ['invalid activation key'] };
    if (record.enabled === false)
      return { ok: false, errors: ['license disabled'] };
    if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
      return { ok: false, errors: ['license expired'] };
    }

    const symbols = new Set(
      record.symbols.map((symbol) => this.normalize(symbol)),
    );
    if (symbols.size === 0)
      return { ok: false, errors: ['license has no symbol entitlements'] };

    return {
      ok: true,
      errors: [],
      activation: {
        licenseId: record.id ?? this.fingerprint(record.activation_key),
        symbols,
        expiresAt: record.expires_at ?? null,
      },
    };
  }

  private loadLicenses(raw: string): LicenseRecord[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) throw new Error('must be an array');
      return parsed.filter(this.isLicenseRecord);
    } catch (error) {
      this.logger.error(`Invalid ACTIVATION_LICENSES_JSON: ${String(error)}`);
      return [];
    }
  }

  private readonly isLicenseRecord = (
    value: unknown,
  ): value is LicenseRecord => {
    if (!value || typeof value !== 'object') return false;
    const record = value as Partial<LicenseRecord>;
    return (
      typeof record.activation_key === 'string' &&
      record.activation_key.length >= 16 &&
      Array.isArray(record.symbols) &&
      record.symbols.every((symbol) => typeof symbol === 'string')
    );
  };

  private keysMatch(expected: string, received: string) {
    const expectedHash = createHash('sha256').update(expected).digest();
    const receivedHash = createHash('sha256').update(received).digest();
    return timingSafeEqual(expectedHash, receivedHash);
  }

  private fingerprint(value: string) {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private normalize(symbol: string) {
    return symbol.trim().replaceAll('/', '').toUpperCase();
  }
}
