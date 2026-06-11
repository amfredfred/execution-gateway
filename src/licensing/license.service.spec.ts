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
    // SignalEngineSubscriberService — only availableSymbols is used in issueKey
    { availableSymbols: ['XAUUSD'] } as never,
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
      { availableSymbols: ['XAUUSD'] } as never,
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
      { availableSymbols: ['XAUUSD'] } as never,
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

  it('returns safe normalized capability data for a valid preflight', async () => {
    const svc = service([
      {
        status: 'active',
        max_devices: 3,
        used_devices: 2,
        expires_at: null,
        symbols: ['xau/usd', 'US100'],
      },
    ]);

    const result = await svc.preflight('TR-VALID-PREFLIGHT-KEY');

    expect(result).toEqual({
      ok: true,
      preflight: {
        valid: true,
        status: 'active',
        max_devices: 3,
        used_devices: 2,
        available_devices: 1,
        expires_at: null,
        symbols: ['XAUUSD', 'US100'],
      },
    });
    expect(mockRpc).toHaveBeenCalledWith('activation_preflight', {
      p_activation_key_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('returns the same invalid response when preflight finds no key', async () => {
    const svc = service([]);

    const result = await svc.preflight('TR-UNKNOWN-PREFLIGHT-KEY');

    expect(result).toEqual({ ok: true, preflight: { valid: false } });
  });

  it('sanitizes Supabase preflight errors', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'database host and internal details' },
    });
    mockCreateClient.mockReturnValue({ rpc: mockRpc });
    const svc = new LicenseService(
      new ConfigService({
        supabase: { url: 'https://example.supabase.co', serviceRoleKey: 'svc' },
        licensing: { activationKeyPepper: 'pepper' },
      }),
      { availableSymbols: ['XAUUSD'] } as never,
    );

    const result = await svc.preflight('TR-VALID-PREFLIGHT-KEY');

    expect(result).toEqual({
      ok: false,
      error: 'Activation preflight unavailable',
    });
  });

  it('releases an owned device and notifies the live-connection listener', async () => {
    const svc = service('engine-001');
    const released = jest.fn();
    svc.onDeviceReleased(released);

    const result = await svc.releaseOwnedDevice(
      'license-001',
      'device-001',
      'user-001',
    );

    expect(result).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith('release_owned_engine_device', {
      p_license_id: 'license-001',
      p_engine_device_id: 'device-001',
      p_owner_user_id: 'user-001',
    });
    expect(released).toHaveBeenCalledWith('engine-001');
  });

  it('self-releases only through a hashed device credential', async () => {
    const svc = service('engine-001');

    const result = await svc.releaseDevice(
      'engine-001',
      'TRDC-DEVICE-CREDENTIAL',
    );

    expect(result).toEqual({ ok: true });
    expect(mockRpc).toHaveBeenCalledWith('release_engine_device', {
      p_engine_id: 'engine-001',
      p_credential_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it('returns an indistinguishable self-release error for rejected credentials', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { message: 'internal credential mismatch details' },
    });
    mockCreateClient.mockReturnValue({ rpc: mockRpc });
    const svc = new LicenseService(
      new ConfigService({
        supabase: { url: 'https://example.supabase.co', serviceRoleKey: 'svc' },
        licensing: { activationKeyPepper: 'pepper' },
      }),
      { availableSymbols: ['XAUUSD'] } as never,
    );

    const result = await svc.releaseDevice('engine-001', 'wrong-credential');

    expect(result).toEqual({
      ok: false,
      error: 'Invalid engine device credential',
    });
  });
});
