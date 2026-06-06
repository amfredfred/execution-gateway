import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { WebSocket } from 'ws';
import { ProtocolService } from '../protocol/protocol.service';
import type { ProtocolMessage } from '../protocol/protocol.types';
import { RoomRegistryService } from '../rooms/room-registry.service';
import { LicenseService } from '../licensing/license.service';
import { ConnectionRegistryService } from './connection-registry.service';

@WebSocketGateway({ path: '/engine' })
export class EngineGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EngineGateway.name);

  constructor(
    private readonly protocol: ProtocolService,
    private readonly connections: ConnectionRegistryService,
    private readonly rooms: RoomRegistryService,
    private readonly licenses: LicenseService,
  ) {}

  handleConnection(socket: WebSocket) {
    this.connections.add(socket);
    this.logger.log(`Engine socket connected; total=${this.connections.count}`);
  }

  handleDisconnect(socket: WebSocket) {
    const engineId = this.connections.engineId(socket);
    if (engineId) this.rooms.leave(engineId);
    this.connections.remove(socket);
    this.logger.log(
      `Engine socket disconnected; total=${this.connections.count}`,
    );
  }

  @SubscribeMessage('engine.hello')
  hello(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('engine.hello', message);
    if (!accepted.ok) return accepted.response;

    this.connections.identify(
      socket,
      String(accepted.message.payload.engine_id),
    );
    return accepted.response;
  }

  @SubscribeMessage('engine.heartbeat')
  heartbeat(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('engine.heartbeat', message);
    if (accepted.ok) this.connections.touch(socket);
    return accepted.response;
  }

  @SubscribeMessage('activation.request')
  activate(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('activation.request', message);
    if (!accepted.ok) return accepted.response;

    const engineId = this.connections.engineId(socket);
    if (!engineId)
      return this.rejected(message.message_id, ['engine.hello required']);

    const result = this.licenses.activate(
      String(accepted.message.payload.activation_key),
    );
    if (!result.ok || !result.activation) {
      return this.rejected(message.message_id, result.errors);
    }

    this.connections.authorize(
      socket,
      result.activation.licenseId,
      result.activation.symbols,
      result.activation.expiresAt,
    );
    return {
      event: 'activation.accepted',
      data: {
        message_id: message.message_id,
        engine_id: engineId,
        symbols: [...result.activation.symbols],
        expires_at: result.activation.expiresAt,
        accepted_at: new Date().toISOString(),
      },
    };
  }

  @SubscribeMessage('telemetry.snapshot')
  telemetry(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('telemetry.snapshot', message);
    if (accepted.ok) this.connections.touch(socket);
    return accepted.response;
  }

  @SubscribeMessage('signal.acknowledged')
  signalAcknowledged(@MessageBody() message: ProtocolMessage) {
    return this.accept('signal.acknowledged', message).response;
  }

  @SubscribeMessage('signal.rejected')
  signalRejected(@MessageBody() message: ProtocolMessage) {
    return this.accept('signal.rejected', message).response;
  }

  @SubscribeMessage('room.subscribe')
  subscribe(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('room.subscribe', message);
    if (!accepted.ok) return accepted.response;

    const engineId = this.connections.engineId(socket);
    if (!engineId)
      return this.rejected(message.message_id, ['engine.hello required']);

    const payloadEngineId = String(accepted.message.payload.engine_id);
    if (payloadEngineId !== engineId) {
      return this.rejected(message.message_id, [
        'engine_id does not match connection',
      ]);
    }

    const symbols = accepted.message.payload.symbols as string[];
    const authorizationErrors = this.connections.authorizationErrors(
      socket,
      symbols,
    );
    if (authorizationErrors.length > 0) {
      return this.rejected(message.message_id, authorizationErrors);
    }

    this.rooms.join(
      engineId,
      socket,
      symbols,
      accepted.message.payload.ttl_seconds as number | undefined,
    );
    return accepted.response;
  }

  @SubscribeMessage('room.unsubscribe')
  unsubscribe(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('room.unsubscribe', message);
    if (!accepted.ok) return accepted.response;

    const engineId = this.connections.engineId(socket);
    if (!engineId)
      return this.rejected(message.message_id, ['engine.hello required']);

    this.rooms.leave(engineId, accepted.message.payload.symbols as string[]);
    return accepted.response;
  }

  private accept(event: string, message: ProtocolMessage) {
    const result = this.protocol.validate({ ...message, event });
    if (!result.valid || !result.message) {
      return {
        ok: false as const,
        response: this.rejected(message?.message_id, result.errors),
      };
    }

    return {
      ok: true as const,
      message: result.message,
      response: {
        event: 'protocol.accepted',
        data: {
          message_id: result.message.message_id,
          accepted_at: new Date().toISOString(),
        },
      },
    };
  }

  private rejected(messageId: string | undefined, errors: string[]) {
    return {
      event: 'protocol.rejected',
      data: { message_id: messageId, errors },
    };
  }
}
