import { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { LicenseService } from './license.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockRpc = jest.fn();
const mockCreateClient = createClient as jest.Mock;

const ACTIVATION_CONTEXT = {
  engineId: 'engine-001',
  deviceName: 'Test Machine',
  engineVersion: '1.0.0',
  platform: { os: 'windows' },
};

function service(rpcResult: unknown = []) {
  mockRpc.mockResolvedValue({ data: rpcResult, error: null });
  mockCreateClient.mockReturnValue({ rpc: mockRpc });

  return new LicenseService(
    new ConfigService({
      supabase: {
        url: 'https://example.supabase.co',
        serviceRoleKey: 'service-role-key',
      },
      licensing: {
        activationKeyPepper: 'test-pepper',
      },
    }),
  );
}

describe('LicenseService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns normalized symbol entitlements for a valid activation', async () => {
    const svc = service([
      {
        license_id: 'license-001',
        engine_device_id: 'device-001',
        expires_at: null,
        symbols: ['xau/usd', 'EUR/USD'],
      },
    ]);

    const result = await svc.activate('TR-VALIDKEY', ACTIVATION_CONTEXT);

    expect(result.ok).toBe(true);
    expect(result.activation?.licenseId).toBe('license-001');
    expect(result.activation?.engineDeviceId).toBe('device-001');
    expect([...result.activation!.symbols]).toEqual(['XAUUSD', 'EURUSD']);
  });

  it('returns an error when Supabase rejects the activation key', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'invalid activation key' },
    });
    mockCreateClient.mockReturnValue({ rpc: mockRpc });

    const svc = new LicenseService(
      new ConfigService({
        supabase: { url: 'https://example.supabase.co', serviceRoleKey: 'svc' },
        licensing: { activationKeyPepper: 'pepper' },
      }),
    );

    const result = await svc.activate('TR-BADKEY', ACTIVATION_CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['invalid activation key']);
  });

  it('returns an error when Supabase returns no rows (key not found)', async () => {
    const svc = service([]); // empty rows = key not found / already used

    const result = await svc.activate('TR-UNKNOWN', ACTIVATION_CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['activation returned no result']);
  });

  it('returns a configuration error when Supabase is not configured', async () => {
    mockCreateClient.mockReturnValue(undefined); // ensures no supabase instance
    const svc = new LicenseService(
      // no supabase config keys → this.supabase stays undefined
      new ConfigService({
        licensing: { activationKeyPepper: 'pepper' },
      }),
    );

    const result = await svc.activate('TR-ANYKEY', ACTIVATION_CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/not configured/);
  });

  it('returns a configuration error when activation context is omitted', async () => {
    const svc = service([]);

    const result = await svc.activate('TR-VALIDKEY');

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/context/i);
  });
});
