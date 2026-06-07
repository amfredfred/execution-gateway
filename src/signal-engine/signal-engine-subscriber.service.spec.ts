import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { RoomRegistryService } from '../rooms/room-registry.service';
import { DashboardConnectionRegistryService } from '../dashboard-connections/dashboard-connection-registry.service';
import { SignalEngineSubscriberService } from './signal-engine-subscriber.service';

function openSocket(
  send: jest.Mock<void, [string]> = jest.fn<void, [string]>(),
) {
  return {
    readyState: WebSocket.OPEN,
    send,
  } as unknown as WebSocket;
}

describe('SignalEngineSubscriberService', () => {
  it('forwards a triggered signal unchanged to only its symbol room', () => {
    const config = new ConfigService();
    const rooms = new RoomRegistryService(config);
    const goldSend = jest.fn<void, [string]>();
    const bitcoinSend = jest.fn<void, [string]>();
    rooms.join('gold-engine', openSocket(goldSend), ['XAUUSD']);
    rooms.join('bitcoin-engine', openSocket(bitcoinSend), ['BTCUSD']);

    const dashboards = new DashboardConnectionRegistryService();
    const subscriber = new SignalEngineSubscriberService(
      config,
      rooms,
      dashboards,
    );
    const frame = JSON.stringify({
      event: 'signal.triggered',
      payload: { id: 'signal-001', symbol: 'XAUUSD' },
    });

    (
      subscriber as unknown as {
        handleMessage(raw: Buffer): void;
      }
    ).handleMessage(Buffer.from(frame));

    expect(goldSend).toHaveBeenCalledWith(frame);
    expect(bitcoinSend).not.toHaveBeenCalled();
  });

  it('forwards sanitized metric snapshots only to subscribed dashboards', () => {
    const config = new ConfigService();
    const rooms = new RoomRegistryService(config);
    const dashboards = new DashboardConnectionRegistryService();
    const send = jest.fn<void, [string]>();
    const socket = openSocket(send);
    dashboards.add(socket);
    dashboards.authenticate(socket, 'user-001', null);
    dashboards.subscribeSignalMetrics(socket);
    const subscriber = new SignalEngineSubscriberService(
      config,
      rooms,
      dashboards,
    );

    (
      subscriber as unknown as { handleMessage(raw: Buffer): void }
    ).handleMessage(
      Buffer.from(
        JSON.stringify({
          event: 'metrics.snapshot',
          payload: {
            ts: 123,
            system: { uptime_ms: 1000, pid: 42 },
            metrics: { scanner_ticks: 9 },
            config: { secret: 'must-not-leak' },
            errors: { recent: ['internal'] },
          },
        }),
      ),
    );

    expect(JSON.parse(send.mock.calls[0][0]) as unknown).toEqual({
      event: 'signal.metrics.snapshot',
      data: {
        observed_at: 123,
        system: { uptime_ms: 1000 },
        metrics: { scanner_ticks: 9 },
        latency: {},
        scheduler: [],
        active_signals: [],
        active_zones: [],
        api: {},
        recent_events: [],
      },
    });
  });
});
