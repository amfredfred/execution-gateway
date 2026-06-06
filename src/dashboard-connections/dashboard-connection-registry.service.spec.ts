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
});
