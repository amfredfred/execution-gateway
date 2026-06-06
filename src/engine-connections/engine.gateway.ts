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
import { EngineSessionService } from './engine-session.service';
import {
  ExecutionLifecycleService,
  type ExecutionLifecycleTransition,
} from './execution-lifecycle.service';
import { DashboardConnectionRegistryService } from '../dashboard-connections/dashboard-connection-registry.service';

@WebSocketGateway({ path: '/engine' })
export class EngineGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(EngineGateway.name);

  constructor(
    private readonly protocol: ProtocolService,
    private readonly connections: ConnectionRegistryService,
    private readonly rooms: RoomRegistryService,
    private readonly licenses: LicenseService,
    private readonly sessions: EngineSessionService,
    private readonly lifecycles: ExecutionLifecycleService,
    private readonly dashboards: DashboardConnectionRegistryService,
  ) {
    this.connections.onStale((socket, engineId, reason) => {
      if (engineId) this.rooms.leave(engineId);
      this.closeSession(socket, reason);
      this.connections.remove(socket);
      socket.close(1008, reason);
    });
  }

  handleConnection(socket: WebSocket) {
    this.connections.add(socket);
    this.logger.log(`Engine socket connected; total=${this.connections.count}`);
  }

  handleDisconnect(socket: WebSocket) {
    const engineId = this.connections.engineId(socket);
    if (engineId) this.rooms.leave(engineId);
    this.closeSession(socket, 'socket_disconnected');
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
    if (accepted.ok) {
      this.connections.touch(socket);
      const sessionId = this.connections.sessionId(socket);
      if (sessionId) this.sessions.touch(sessionId);
    }
    return accepted.response;
  }

  @SubscribeMessage('activation.request')
  async activate(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('activation.request', message);
    if (!accepted.ok) return accepted.response;

    const engineId = this.connections.engineId(socket);
    if (!engineId)
      return this.rejected(message.message_id, ['engine.hello required']);

    const result = await this.licenses.activate(
      String(accepted.message.payload.activation_key),
      {
        engineId,
        deviceName: String(accepted.message.payload.device_name),
        engineVersion: String(accepted.message.payload.engine_version),
        platform: accepted.message.payload.platform as Record<string, unknown>,
      },
    );
    if (!result.ok || !result.activation) {
      return this.rejected(message.message_id, result.errors);
    }

    this.connections.authorize(
      socket,
      result.activation.licenseId,
      result.activation.engineDeviceId,
      result.activation.symbols,
      result.activation.expiresAt,
    );
    if (result.activation.engineDeviceId) {
      const sessionId = await this.sessions.open(
        result.activation.engineDeviceId,
        engineId,
      );
      if (sessionId) this.connections.setSessionId(socket, sessionId);
    }
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

  @SubscribeMessage('execution.lifecycle')
  executionLifecycle(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('execution.lifecycle', message);
    if (!accepted.ok) return accepted.response;

    const engineId = this.connections.engineId(socket);
    const engineDeviceId = this.connections.engineDeviceId(socket);
    if (!engineId || !engineDeviceId) {
      return this.rejected(message.message_id, ['activation.request required']);
    }
    if (accepted.message.payload.engine_id !== engineId) {
      return this.rejected(message.message_id, [
        'engine_id does not match connection',
      ]);
    }

    this.connections.touch(socket);
    this.lifecycles.record(
      engineDeviceId,
      this.connections.sessionId(socket),
      accepted.message.payload as unknown as ExecutionLifecycleTransition,
    );
    return accepted.response;
  }

  @SubscribeMessage('execution.metrics.snapshot')
  executionMetrics(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: { payload?: unknown },
  ) {
    const engineId = this.connections.engineId(socket);
    if (!engineId || !this.connections.engineDeviceId(socket)) {
      return this.rejected(undefined, ['activation.request required']);
    }
    this.connections.touch(socket);
    this.dashboards.broadcastExecutionMetrics(engineId, message.payload ?? {});
    return {
      event: 'protocol.accepted',
      data: { accepted_at: new Date().toISOString() },
    };
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

    const requestedTtl = accepted.message.payload.ttl_seconds as
      | number
      | undefined;
    const licenseExpiresAt = this.connections.licenseExpiresAt(socket);
    const ttlSeconds = this.cappedTtl(requestedTtl, licenseExpiresAt);
    this.rooms.join(engineId, socket, symbols, ttlSeconds);
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

  private cappedTtl(
    requestedSeconds: number | undefined,
    licenseExpiresAt: string | null,
  ): number | undefined {
    if (!licenseExpiresAt) return requestedSeconds;
    const remainingMs = Math.max(0, Date.parse(licenseExpiresAt) - Date.now());
    const remainingSeconds = Math.floor(remainingMs / 1000);
    if (requestedSeconds === undefined) return remainingSeconds;
    return Math.min(requestedSeconds, remainingSeconds);
  }

  private closeSession(socket: WebSocket, reason: string) {
    const sessionId = this.connections.sessionId(socket);
    if (sessionId) this.sessions.close(sessionId, reason);
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
