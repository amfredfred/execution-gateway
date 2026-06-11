import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { RoomRegistryService } from './room-registry.service';

function openSocket(send = jest.fn()) {
  return {
    readyState: WebSocket.OPEN,
    send,
  } as unknown as WebSocket;
}

describe('RoomRegistryService', () => {
  let rooms: RoomRegistryService;

  beforeEach(() => {
    rooms = new RoomRegistryService(
      new ConfigService({
        rooms: { defaultTtlSeconds: 3600, evictionIntervalSeconds: 15 },
      }),
    );
  });

  it('broadcasts only to members of the matching symbol room', () => {
    const goldSend = jest.fn();
    const bitcoinSend = jest.fn();
    const goldEngine = openSocket(goldSend);
    const bitcoinEngine = openSocket(bitcoinSend);
    rooms.join('gold-engine', goldEngine, ['XAUUSD']);
    rooms.join('bitcoin-engine', bitcoinEngine, ['BTCUSD']);

    expect(rooms.broadcast('XAUUSD', '{"event":"signal.triggered"}')).toBe(1);
    expect(goldSend).toHaveBeenCalledTimes(1);
    expect(bitcoinSend).not.toHaveBeenCalled();
  });

  it('destroys a room when its last member leaves', () => {
    const socket = openSocket();
    rooms.join('engine-001', socket, ['XAUUSD']);
    expect(rooms.symbols.has('XAUUSD')).toBe(true);

    rooms.leave('engine-001');

    expect(rooms.symbols.has('XAUUSD')).toBe(false);
    expect(rooms.roomCount).toBe(0);
  });

  it('does not let a stale socket remove a replacement membership', () => {
    const staleSend = jest.fn();
    const freshSend = jest.fn();
    const stale = openSocket(staleSend);
    const fresh = openSocket(freshSend);
    rooms.join('engine-001', stale, ['XAUUSD']);
    rooms.join('engine-001', fresh, ['XAUUSD']);

    rooms.leave('engine-001', undefined, stale);

    expect(rooms.broadcast('XAUUSD', '{"event":"signal.triggered"}')).toBe(1);
    expect(freshSend).toHaveBeenCalledTimes(1);
    expect(staleSend).not.toHaveBeenCalled();
  });

  it('allows the current socket to remove its own membership', () => {
    const socket = openSocket();
    rooms.join('engine-001', socket, ['XAUUSD']);

    rooms.leave('engine-001', undefined, socket);

    expect(rooms.roomCount).toBe(0);
  });
});
