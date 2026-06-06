import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  LicenseActivationResult,
  LicenseRecord,
} from './license.types';

@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);
  private readonly licenses: LicenseRecord[];

  constructor(private readonly config: ConfigService) {
    this.licenses = this.loadLicenses(
      this.config.get<string>('licensing.licensesJson', '[]'),
    );
  }

  activate(activationKey: string): LicenseActivationResult {
    const record = this.licenses.find((license) =>
      this.keysMatch(license.activation_key, activationKey),
    );
    if (!record) return { ok: false, errors: ['invalid activation key'] };
    if (record.enabled === false)
      return { ok: false, errors: ['license disabled'] };
    if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) {
      return { ok: false, errors: ['license expired'] };
    }

    const symbols = new Set(record.symbols.map((symbol) => this.normalize(symbol)));
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

  private readonly isLicenseRecord = (value: unknown): value is LicenseRecord => {
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
