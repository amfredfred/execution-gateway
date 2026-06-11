import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ActivationController } from './activation.controller';

const request = {
  headers: {},
  socket: { remoteAddress: '127.0.0.1' },
};

describe('ActivationController', () => {
  const licenses = { preflight: jest.fn() };
  const rateLimit = { check: jest.fn() };
  const controller = new ActivationController(
    licenses as never,
    rateLimit as never,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    rateLimit.check.mockReturnValue(true);
  });

  it('returns a successful preflight response', async () => {
    const preflight = {
      valid: true,
      status: 'active',
      max_devices: 3,
      used_devices: 1,
      available_devices: 2,
      expires_at: null,
      symbols: ['XAUUSD'],
    };
    licenses.preflight.mockResolvedValue({ ok: true, preflight });

    await expect(
      controller.preflight(
        { activation_key: '  TR-VALID-PREFLIGHT-KEY  ' },
        request,
      ),
    ).resolves.toEqual(preflight);
    expect(licenses.preflight).toHaveBeenCalledWith('TR-VALID-PREFLIGHT-KEY');
    expect(rateLimit.check).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed activation keys before rate limiting', async () => {
    await expect(
      controller.preflight({ activation_key: 'short' }, request),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(rateLimit.check).not.toHaveBeenCalled();
    expect(licenses.preflight).not.toHaveBeenCalled();
  });

  it('rejects a request when either rate-limit bucket is exhausted', async () => {
    rateLimit.check.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const result = controller.preflight(
      { activation_key: 'TR-VALID-PREFLIGHT-KEY' },
      request,
    );

    await expect(result).rejects.toBeInstanceOf(HttpException);
    await expect(result).rejects.toMatchObject({ status: 429 });
    expect(licenses.preflight).not.toHaveBeenCalled();
  });

  it('returns service unavailable without exposing infrastructure details', async () => {
    licenses.preflight.mockResolvedValue({
      ok: false,
      error: 'Activation preflight unavailable',
    });

    await expect(
      controller.preflight(
        { activation_key: 'TR-VALID-PREFLIGHT-KEY' },
        request,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
