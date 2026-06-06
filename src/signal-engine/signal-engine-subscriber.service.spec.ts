import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { RoomRegistryService } from '../rooms/room-registry.service';
import { SignalEngineSubscriberService } from './signal-engine-subscriber.service';

function openSocket(send = jest.fn()) {
  return {
    readyState: WebSocket.OPEN,
    send,
  } as unknown as WebSocket;
}

describe('SignalEngineSubscriberService', () => {
  it('forwards a triggered signal unchanged to only its symbol room', () => {
    const config = new ConfigService();
    const rooms = new RoomRegistryService(config);
    const goldSend = jest.fn();
    const bitcoinSend = jest.fn();
    rooms.join('gold-engine', openSocket(goldSend), ['XAUUSD']);
    rooms.join('bitcoin-engine', openSocket(bitcoinSend), ['BTCUSD']);

    const subscriber = new SignalEngineSubscriberService(config, rooms);
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
});
