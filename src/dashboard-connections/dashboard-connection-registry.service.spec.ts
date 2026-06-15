import { WebSocket } from 'ws';
import { DashboardConnectionRegistryService } from './dashboard-connection-registry.service';

describe('DashboardConnectionRegistryService', () => {
  it('defaults to unauthenticated and stores verified user identity', () => {
    const registry = new DashboardConnectionRegistryService();
    const socket = {} as WebSocket;

    registry.add(socket);
    expect(registry.isAuthenticated(socket)).toBe(false);

    registry.authenticate(socket, 'user-001', 'owner@example.com');
    expect(registry.isAuthenticated(socket)).toBe(true);
    expect(registry.userId(socket)).toBe('user-001');

    registry.remove(socket);
    expect(registry.count).toBe(0);
  });

  it('tracks signal metric demand and stops after the final viewer leaves', () => {
    const registry = new DashboardConnectionRegistryService();
    const socket = {} as WebSocket;
    const demand = jest.fn();
    registry.onSignalMetricDemandChanged(demand);
    registry.add(socket);
    registry.authenticate(socket, 'user-001', null);

    registry.subscribeSignalMetrics(socket);
    expect(registry.signalMetricSubscriberCount).toBe(1);
    registry.remove(socket);
    expect(registry.signalMetricSubscriberCount).toBe(0);
    expect(demand).toHaveBeenNthCalledWith(1, 0);
    expect(demand).toHaveBeenNthCalledWith(2, 1);
    expect(demand).toHaveBeenNthCalledWith(3, 0);
  });

  it('broadcasts signal-engine events immediately to subscribed dashboards', () => {
    const registry = new DashboardConnectionRegistryService();
    const send = jest.fn();
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    registry.add(socket);
    registry.authenticate(socket, 'user-001', null);
    registry.subscribeSignalMetrics(socket);

    registry.pushSignalEvent('log.info', { message: 'scanner online' });

    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      event: 'signal.event',
      data: {
        event_type: 'log.info',
        data: { message: 'scanner online' },
      },
    });
  });

  it('broadcasts complete registry updates to authenticated dashboards', () => {
    const registry = new DashboardConnectionRegistryService();
    const send = jest.fn();
    const socket = { readyState: WebSocket.OPEN, send } as unknown as WebSocket;
    registry.add(socket);
    registry.authenticate(socket, 'user-001', null);

    registry.broadcastEngineRegistryUpdated({
      sourceKey: 'execution-123',
      connectedAt: '2026-06-15T00:00:00.000Z',
      lastSeenAt: '2026-06-15T00:00:01.000Z',
      lastMetricsAt: '2026-06-15T00:00:01.000Z',
      lastAwarenessAt: null,
      healthState: 'online',
      latestMetrics: { balance: 1000 },
      latestAwareness: null,
      lastError: null,
      account: null,
      deviceName: null,
      engineVersion: null,
      parentSourceKey: 'manager-main',
    });

    expect(JSON.parse(send.mock.calls[0][0])).toMatchObject({
      event: 'engine.registry.updated',
      data: {
        entry: {
          sourceKey: 'execution-123',
          latestMetrics: { balance: 1000 },
        },
      },
    });
  });
});
