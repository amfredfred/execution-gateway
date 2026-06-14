import { WebSocket } from 'ws';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { EngineGateway } from './engine.gateway';

function message(
  id: string,
  account?: { login: string; server: string; mode: 'demo' | 'live' },
) {
  return {
    event: 'activation.request',
    protocol_version: '1.0',
    message_id: id,
    sent_at: new Date().toISOString(),
    payload: {
      activation_key: 'TR-SHARED-ACTIVATION-KEY',
      device_name: id,
      engine_version: '1.0.0',
      platform: { os: 'windows' },
      mt5_accounts: account ? [account] : [],
    },
  };
}

describe('EngineGateway multi-agent activation rate limits', () => {
  function setup() {
    const engineIds = new Map<WebSocket, string>();
    const protocol = {
      validate: jest.fn((value) => ({ valid: true, message: value })),
    };
    const connections = {
      onStale: jest.fn(),
      currentSocket: jest.fn(),
      engineId: jest.fn((socket: WebSocket) => engineIds.get(socket) ?? null),
      account: jest.fn().mockReturnValue(null),
      setAccount: jest.fn(),
      authorize: jest.fn().mockReturnValue(null),
      setSessionId: jest.fn(),
    };
    const licenses = {
      onDeviceReleased: jest.fn(),
      activate: jest.fn(),
      issueDeviceCredential: jest.fn().mockResolvedValue(null),
    };
    const sessions = { open: jest.fn().mockResolvedValue('session-001') };
    const gateway = new EngineGateway(
      protocol as never,
      connections as never,
      {} as never,
      licenses as never,
      sessions as never,
      {} as never,
      {} as never,
      {} as never,
      new RateLimitService(),
      { register: jest.fn(), heartbeat: jest.fn(), markOffline: jest.fn(), recordMetrics: jest.fn(), updateAwareness: jest.fn(), onHealthChanged: jest.fn() } as never,
    );

    return { gateway, engineIds, licenses, connections, sessions };
  }

  it('allows three new agents plus a transient retry on one shared key', async () => {
    const { gateway, engineIds, licenses } = setup();
    licenses.activate
      .mockResolvedValueOnce({ ok: false, errors: ['temporary failure'] })
      .mockResolvedValue({
        ok: true,
        errors: [],
        activation: {
          licenseId: 'license-001',
          engineDeviceId: 'device-001',
          symbols: new Set(['XAUUSD']),
          expiresAt: null,
        },
      });

    const sockets = Array.from({ length: 4 }, (_, index) => {
      const socket = {} as WebSocket;
      engineIds.set(socket, `engine-${index}`);
      return socket;
    });

    const responses = [];
    for (let index = 0; index < sockets.length; index++) {
      responses.push(
        await gateway.activate(sockets[index], message(`attempt-${index}`)),
      );
    }

    expect(responses.map((response) => response.event)).toEqual([
      'protocol.rejected',
      'activation.accepted',
      'activation.accepted',
      'activation.accepted',
    ]);
    expect(licenses.activate).toHaveBeenCalledTimes(4);
  });

  it('blocks a shared invalid key after three failures', async () => {
    const { gateway, engineIds, licenses } = setup();
    licenses.activate.mockResolvedValue({
      ok: false,
      errors: ['invalid activation key'],
    });
    const socket = {} as WebSocket;
    engineIds.set(socket, 'engine-001');

    const responses = [];
    for (let index = 0; index < 4; index++) {
      responses.push(await gateway.activate(socket, message(`bad-${index}`)));
    }

    expect(licenses.activate).toHaveBeenCalledTimes(3);
    expect(responses[3]).toEqual({
      event: 'protocol.rejected',
      data: { message_id: 'bad-3', errors: ['rate_limit_exceeded'] },
    });
  });

  it('persists the reported account in device and session metadata', async () => {
    const { gateway, engineIds, licenses, connections, sessions } = setup();
    const account = {
      login: '1003',
      server: 'Broker-Server',
      mode: 'live' as const,
    };
    connections.account.mockReturnValue(account);
    licenses.activate.mockResolvedValue({
      ok: true,
      errors: [],
      activation: {
        licenseId: 'license-001',
        engineDeviceId: 'device-001',
        symbols: new Set(['XAUUSD']),
        expiresAt: null,
      },
    });
    const socket = {} as WebSocket;
    engineIds.set(socket, 'engine-001');

    const response = await gateway.activate(
      socket,
      message('account-activation', account),
    );

    expect(response.event).toBe('activation.accepted');
    expect(licenses.activate).toHaveBeenCalledWith(
      'TR-SHARED-ACTIVATION-KEY',
      expect.objectContaining({
        platform: expect.objectContaining({ mt5_account: account }),
      }),
    );
    expect(sessions.open).toHaveBeenCalledWith('device-001', 'engine-001', {
      mt5_account: account,
    });
  });

  it('rejects account metadata that differs from engine hello', async () => {
    const { gateway, engineIds, licenses, connections } = setup();
    connections.account.mockReturnValue({
      login: '1003',
      server: 'Broker-Server',
      mode: 'live',
    });
    const socket = {} as WebSocket;
    engineIds.set(socket, 'engine-001');

    const response = await gateway.activate(
      socket,
      message('account-mismatch', {
        login: '1004',
        server: 'Broker-Server',
        mode: 'live',
      }),
    );

    expect(response).toEqual({
      event: 'protocol.rejected',
      data: {
        message_id: 'account-mismatch',
        errors: ['MT5 account metadata does not match engine.hello'],
      },
    });
    expect(licenses.activate).not.toHaveBeenCalled();
  });
});
