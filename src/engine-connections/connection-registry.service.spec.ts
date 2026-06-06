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
