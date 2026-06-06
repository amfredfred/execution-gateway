import { WebSocket } from 'ws';
import { ConnectionRegistryService } from './connection-registry.service';

describe('ConnectionRegistryService authorization', () => {
  it('defaults to deny and permits only activated symbol entitlements', () => {
    const connections = new ConnectionRegistryService();
    const socket = {} as WebSocket;
    connections.add(socket);

    expect(connections.authorizationErrors(socket, ['XAUUSD'])).toEqual([
      'activation.request required',
    ]);

    connections.authorize(socket, 'license-001', new Set(['XAUUSD']), null);

    expect(connections.authorizationErrors(socket, ['XAUUSD'])).toEqual([]);
    expect(connections.authorizationErrors(socket, ['BTCUSD'])).toEqual([
      'symbols not entitled: BTCUSD',
    ]);
  });
});
