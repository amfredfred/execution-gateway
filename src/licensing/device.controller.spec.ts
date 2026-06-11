import { ConfigService } from '@nestjs/config';
import { HttpException, UnauthorizedException } from '@nestjs/common';
import { createClient } from '@supabase/supabase-js';
import { DeviceController } from './device.controller';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockCreateClient = createClient as jest.Mock;
const request = {
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
};

describe('DeviceController', () => {
  const licenses = {
    releaseOwnedDevice: jest.fn(),
    releaseDevice: jest.fn(),
  };
  const rateLimit = { check: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimit.check.mockReturnValue(true);
  });

  function controller(config: Record<string, unknown> = {}) {
    return new DeviceController(
      licenses as never,
      rateLimit as never,
      new ConfigService(config),
    );
  }

  it('self-releases a device using its engine identity and credential', async () => {
    licenses.releaseDevice.mockResolvedValue({ ok: true });
    const instance = controller();

    await expect(
      instance.releaseDevice(
        {
          engine_id: ' engine-001 ',
          device_credential: ' TRDC-DEVICE-CREDENTIAL ',
        },
        request,
      ),
    ).resolves.toBeUndefined();
    expect(licenses.releaseDevice).toHaveBeenCalledWith(
      'engine-001',
      'TRDC-DEVICE-CREDENTIAL',
    );
  });

  it('does not reveal why self-release authentication failed', async () => {
    licenses.releaseDevice.mockResolvedValue({
      ok: false,
      error: 'database-specific detail',
    });

    await expect(
      controller().releaseDevice(
        {
          engine_id: 'engine-001',
          device_credential: 'TRDC-DEVICE-CREDENTIAL',
        },
        request,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rate-limits self-release by IP and hashed engine identity', async () => {
    rateLimit.check.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const result = controller().releaseDevice(
      {
        engine_id: 'engine-001',
        device_credential: 'TRDC-DEVICE-CREDENTIAL',
      },
      request,
    );

    await expect(result).rejects.toBeInstanceOf(HttpException);
    await expect(result).rejects.toMatchObject({ status: 429 });
    expect(licenses.releaseDevice).not.toHaveBeenCalled();
  });

  it('allows an authenticated owner to release a license device', async () => {
    const getUser = jest.fn().mockResolvedValue({
      data: { user: { id: 'user-001' } },
      error: null,
    });
    mockCreateClient.mockReturnValue({ auth: { getUser } });
    licenses.releaseOwnedDevice.mockResolvedValue({ ok: true });
    const instance = controller({
      supabase: { url: 'https://example.supabase.co', serviceRoleKey: 'svc' },
    });

    await expect(
      instance.releaseOwnedDevice(
        'license-001',
        'device-001',
        'Bearer access-token',
      ),
    ).resolves.toBeUndefined();
    expect(licenses.releaseOwnedDevice).toHaveBeenCalledWith(
      'license-001',
      'device-001',
      'user-001',
    );
  });
});
