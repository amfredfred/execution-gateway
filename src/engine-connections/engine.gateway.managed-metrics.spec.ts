import { WebSocket } from 'ws';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { EngineGateway } from './engine.gateway';

describe('EngineGateway managed metrics', () => {
  it('broadcasts managed agent metrics using the execution snapshot contract', () => {
    const socket = {} as WebSocket;
    const connections = {
      onStale: jest.fn(),
      engineId: jest.fn().mockReturnValue('AQM-test-machine-guid'),
      engineDeviceId: jest.fn().mockReturnValue('manager-device'),
      touch: jest.fn(),
    };
    const dashboards = {
      broadcastEngineAwareness: jest.fn(),
      broadcastExecutionMetrics: jest.fn(),
    };
    const engineRegistry = {
      upsertManagedSource: jest.fn(),
      onHealthChanged: jest.fn(),
    };
    const licenses = { onDeviceReleased: jest.fn() };
    const gateway = new EngineGateway(
      {} as never,
      connections as never,
      {} as never,
      licenses as never,
      {} as never,
      {} as never,
      dashboards as never,
      {} as never,
      new RateLimitService(),
      engineRegistry as never,
    );

    gateway.managerAgentSnapshot(socket, {
      payload: {
        engine_id: 'execution-123',
        display_name: 'Fundednext',
        account: { login: '123', server: 'Broker', mode: 'live' },
        awareness: {
          terminal_connected: true,
          runtime_state: 'running',
        },
        metrics: {
          balance: 1000,
          equity: 995,
          open_trades: 2,
        },
      },
    });

    const expectedSnapshot = {
      connected: true,
      engine: {
        terminal_connected: true,
        runtime_state: 'running',
        account: { login: '123', server: 'Broker', mode: 'live' },
      },
      metrics: {
        balance: 1000,
        equity: 995,
        open_trades: 2,
      },
    };
    expect(engineRegistry.upsertManagedSource).toHaveBeenCalledWith(
      'execution-123',
      'AQM-test-machine-guid',
      { login: '123', server: 'Broker', mode: 'live' },
      { terminal_connected: true, runtime_state: 'running' },
      expectedSnapshot,
      'Fundednext',
    );
    expect(dashboards.broadcastExecutionMetrics).toHaveBeenCalledWith(
      'execution-123',
      expectedSnapshot,
    );
  });

  it('preserves a complete managed execution snapshot', () => {
    const socket = {} as WebSocket;
    const connections = {
      onStale: jest.fn(),
      engineId: jest.fn().mockReturnValue('AQM-test-machine-guid'),
      engineDeviceId: jest.fn().mockReturnValue('manager-device'),
      touch: jest.fn(),
    };
    const dashboards = {
      broadcastEngineAwareness: jest.fn(),
      broadcastExecutionMetrics: jest.fn(),
    };
    const engineRegistry = {
      upsertManagedSource: jest.fn(),
      onHealthChanged: jest.fn(),
    };
    const gateway = new EngineGateway(
      {} as never,
      connections as never,
      {} as never,
      { onDeviceReleased: jest.fn() } as never,
      {} as never,
      {} as never,
      dashboards as never,
      {} as never,
      new RateLimitService(),
      engineRegistry as never,
    );
    const snapshot = {
      connected: true,
      engine: { status: 'RUNNING' },
      metrics: { balance: 1000, daily_pnl: 25 },
      trades: [{ symbol: 'XAUUSD' }],
      riskGuards: [{ id: 'guard1' }],
    };

    gateway.managerAgentSnapshot(socket, {
      payload: {
        engine_id: 'execution-123',
        awareness: { terminal_connected: true },
        metrics: snapshot,
      },
    });

    expect(dashboards.broadcastExecutionMetrics).toHaveBeenCalledWith(
      'execution-123',
      snapshot,
    );
  });
});
