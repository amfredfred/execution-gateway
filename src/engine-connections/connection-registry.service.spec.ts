import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { ConnectionRegistryService } from './connection-registry.service';
import { DashboardConnectionRegistryService } from '../dashboard-connections/dashboard-connection-registry.service';

function service(offlineAfterSeconds = 90) {
  return new ConnectionRegistryService(
    new ConfigService({ connections: { offlineAfterSeconds } }),
    new DashboardConnectionRegistryService(),
  );
}

describe('ConnectionRegistryService authorization', () => {
  it('defaults to deny and permits only activated symbol entitlements', () => {
    const connections = service();
    const socket = {} as WebSocket;
    connections.add(socket);

    expect(connections.authorizationErrors(socket, ['XAUUSD'])).toEqual([
      'activation.request required',
    ]);

    connections.authorize(
      socket,
      'license-001',
      'device-001',
      new Set(['XAUUSD']),
      null,
    );

    expect(connections.authorizationErrors(socket, ['XAUUSD'])).toEqual([]);
    expect(connections.authorizationErrors(socket, ['BTCUSD'])).toEqual([
      'symbols not entitled: BTCUSD',
    ]);
  });

  it('reports license_expired when license expiry is in the past', () => {
    const connections = service();
    const socket = {} as WebSocket;
    connections.add(socket);
    connections.authorize(
      socket,
      'license-001',
      'device-001',
      new Set(['XAUUSD']),
      new Date(Date.now() - 1000).toISOString(),
    );

    expect(connections.authorizationErrors(socket, ['XAUUSD'])).toEqual([
      'license expired',
    ]);
  });
});

describe('ConnectionRegistryService TTL cap', () => {
  it('licenseExpiresAt returns the stored expiry for a socket', () => {
    const connections = service();
    const socket = {} as WebSocket;
    const expiry = new Date(Date.now() + 3600 * 1000).toISOString();
    connections.add(socket);
    connections.authorize(
      socket,
      'license-001',
      'device-001',
      new Set(['XAUUSD']),
      expiry,
    );

    expect(connections.licenseExpiresAt(socket)).toBe(expiry);
  });

  it('returns null when socket has no license', () => {
    const connections = service();
    const socket = {} as WebSocket;
    connections.add(socket);

    expect(connections.licenseExpiresAt(socket)).toBeNull();
  });
});

describe('ConnectionRegistryService sendToEngine (BUG-12 reverse index)', () => {
  function openSocket(): { socket: WebSocket; send: jest.Mock } {
    const send = jest.fn();
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    return { socket, send };
  }

  it('delivers to the identified, authorized engine socket', () => {
    const connections = service();
    const { socket, send } = openSocket();
    connections.add(socket);
    connections.identify(socket, 'engine-001');
    connections.authorize(socket, 'license-001', 'device-001', new Set(), null);

    expect(connections.sendToEngine('engine-001', 'command.pause', {})).toBe(
      true,
    );
    expect(send).toHaveBeenCalledWith(
      JSON.stringify({ event: 'command.pause', data: {} }),
    );
  });

  it('returns only the current authorized socket for release handling', () => {
    const connections = service();
    const { socket } = openSocket();
    connections.add(socket);
    connections.identify(socket, 'engine-001');

    expect(connections.currentSocket('engine-001')).toBeNull();

    connections.authorize(socket, 'license-001', 'device-001', new Set(), null);

    expect(connections.currentSocket('engine-001')).toBe(socket);
  });

  it('refuses delivery to an identified but unauthorized engine', () => {
    const connections = service();
    const { socket } = openSocket();
    connections.add(socket);
    connections.identify(socket, 'engine-001');

    expect(connections.sendToEngine('engine-001', 'command.pause', {})).toBe(
      false,
    );
  });

  it('routes to the newest socket after a reconnect with the same engineId', () => {
    const connections = service();
    const old = openSocket();
    const fresh = openSocket();
    connections.add(old.socket);
    connections.identify(old.socket, 'engine-001');
    connections.authorize(
      old.socket,
      'license-001',
      'device-001',
      new Set(),
      null,
    );

    connections.add(fresh.socket);
    connections.identify(fresh.socket, 'engine-001');
    const replaced = connections.authorize(
      fresh.socket,
      'license-001',
      'device-001',
      new Set(),
      null,
    );

    expect(replaced).toBe(old.socket);
    expect(connections.sendToEngine('engine-001', 'command.pause', {})).toBe(
      true,
    );
    expect(fresh.send).toHaveBeenCalled();
    expect(old.send).not.toHaveBeenCalled();

    // Removing the stale old socket must not unindex the live one.
    connections.remove(old.socket);
    expect(connections.sendToEngine('engine-001', 'command.resume', {})).toBe(
      true,
    );
  });

  it('does not replace a live engine until the new socket is authorized', () => {
    const connections = service();
    const old = openSocket();
    const untrusted = openSocket();
    connections.add(old.socket);
    connections.identify(old.socket, 'engine-001');
    connections.authorize(
      old.socket,
      'license-001',
      'device-001',
      new Set(),
      null,
    );

    connections.add(untrusted.socket);
    connections.identify(untrusted.socket, 'engine-001');

    expect(connections.isCurrent(old.socket)).toBe(true);
    expect(connections.isCurrent(untrusted.socket)).toBe(false);
    expect(connections.sendToEngine('engine-001', 'command.pause', {})).toBe(
      true,
    );
    expect(old.send).toHaveBeenCalled();
    expect(untrusted.send).not.toHaveBeenCalled();
  });

  it('does not let an authorized socket change its engine identity', () => {
    const connections = service();
    const { socket } = openSocket();
    connections.add(socket);
    connections.identify(socket, 'engine-001');
    connections.authorize(socket, 'license-001', 'device-001', new Set(), null);

    expect(connections.identify(socket, 'engine-002')).toBe(false);
    expect(connections.engineId(socket)).toBe('engine-001');
    expect(connections.isCurrent(socket)).toBe(true);
    expect(connections.sendToEngine('engine-002', 'command.pause', {})).toBe(
      false,
    );
  });

  it('returns false after the engine socket is removed', () => {
    const connections = service();
    const { socket } = openSocket();
    connections.add(socket);
    connections.identify(socket, 'engine-001');
    connections.authorize(socket, 'license-001', 'device-001', new Set(), null);
    connections.remove(socket);

    expect(connections.sendToEngine('engine-001', 'command.pause', {})).toBe(
      false,
    );
  });
});

describe('ConnectionRegistryService stale sweep', () => {
  it('fires stale handler for heartbeat-timeout connection', () => {
    jest.useFakeTimers();
    // offlineAfterSeconds=30, sweep runs every 10 s (30/3).
    // Advance 41 s so at least one sweep fires after the 30 s threshold is crossed.
    const connections = service(30);
    const socket = { close: jest.fn() } as unknown as WebSocket;
    connections.add(socket);
    connections.onModuleInit();

    const handler = jest.fn();
    connections.onStale(handler);

    jest.advanceTimersByTime(41_000);

    expect(handler).toHaveBeenCalledWith(socket, null, 'heartbeat_timeout');
    connections.onModuleDestroy();
    jest.useRealTimers();
  });
});
