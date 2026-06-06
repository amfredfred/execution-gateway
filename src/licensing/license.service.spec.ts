import { ConfigService } from '@nestjs/config';
import { LicenseService } from './license.service';

const ACTIVE_KEY = 'active-license-key-001';

function service(licenses: unknown[]) {
  return new LicenseService(
    new ConfigService({
      licensing: { licensesJson: JSON.stringify(licenses) },
    }),
  );
}

describe('LicenseService', () => {
  it('returns normalized symbol entitlements for an active license', () => {
    const licenses = service([
      { id: 'license-001', activation_key: ACTIVE_KEY, symbols: ['xau/usd'] },
    ]);

    const result = licenses.activate(ACTIVE_KEY);

    expect(result.ok).toBe(true);
    expect(result.activation?.licenseId).toBe('license-001');
    expect([...result.activation!.symbols]).toEqual(['XAUUSD']);
  });

  it('rejects invalid, disabled, and expired licenses', () => {
    const licenses = service([
      {
        activation_key: 'disabled-license-key',
        symbols: ['XAUUSD'],
        enabled: false,
      },
      {
        activation_key: 'expired-license-key-001',
        symbols: ['XAUUSD'],
        expires_at: '2020-01-01T00:00:00.000Z',
      },
    ]);

    expect(licenses.activate('unknown-license-key').errors).toEqual([
      'invalid activation key',
    ]);
    expect(licenses.activate('disabled-license-key').errors).toEqual([
      'license disabled',
    ]);
    expect(licenses.activate('expired-license-key-001').errors).toEqual([
      'license expired',
    ]);
  });
});
