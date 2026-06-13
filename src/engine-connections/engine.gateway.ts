import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { IncomingMessage } from 'http';
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
import { RemoteCommandService } from '../commands/remote-command.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import type { Mt5AccountMetadata } from '../licensing/license.types';

// ── Rate-limit constants ───────────────────────────────────────────────────
/** Max new engine WS connections accepted per IP per minute. */
const RL_CONNECT_LIMIT = 20;
const RL_CONNECT_WIN_MS = 60_000;

/** Broad abuse ceiling; valid multi-agent startup and retries must fit. */
const RL_ACT_IP_LIMIT = 20;
const RL_ACT_IP_WIN_MS = 600_000;

/** Invalid activation failures allowed per (hashed) key in 10 minutes. */
const RL_ACT_KEY_FAILURE_LIMIT = 3;
const RL_ACT_KEY_WIN_MS = 600_000;

// Symbol used to stash the remote IP on the socket object at connect-time.
const IP_PROP = Symbol('rl_ip');

/**
 * One-way FNV-1a bucket token for an activation key.
 * Never logs or exposes the raw secret.
 */
function keyBucket(raw: string): string {
  let h = 0x811c9dc5;
  const len = Math.min(raw.length, 32);
  for (let i = 0; i < len; i++) {
    h = (h ^ raw.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `actkey:${h.toString(16)}`;
}

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
    private readonly remoteCommands: RemoteCommandService,
    private readonly rateLimit: RateLimitService,
  ) {
    this.connections.onStale((socket, engineId, reason) => {
      this.retireSocket(socket, reason);
    });
    this.licenses.onDeviceReleased((engineId) => {
      const socket = this.connections.currentSocket(engineId);
      if (socket) this.retireSocket(socket, 'device_released');
    });
  }

  handleConnection(socket: WebSocket, req: IncomingMessage) {
    // Resolve remote IP (supports reverse-proxy X-Forwarded-For).
    const forwarded = req.headers['x-forwarded-for'];
    const ip =
      (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ??
      req.socket?.remoteAddress ??
      'unknown';

    // Stash on socket so message handlers can use it without extra lookups.
    (socket as unknown as Record<symbol, string>)[IP_PROP] = ip;

    // Rate-limit: close immediately if this IP is hammering connections.
    if (
      !this.rateLimit.check(
        `eng_conn:${ip}`,
        RL_CONNECT_LIMIT,
        RL_CONNECT_WIN_MS,
      )
    ) {
      this.logger.warn(`Engine rate-limit: too many connections from ${ip}`);
      socket.close(1008, 'rate_limit_exceeded');
      return;
    }

    this.connections.add(socket);
    this.logger.log(`Engine socket connected; total=${this.connections.count}`);
  }

  handleDisconnect(socket: WebSocket) {
    const engineId = this.connections.engineId(socket);
    const wasCurrent = this.connections.isCurrent(socket);
    if (engineId) {
      this.rooms.leave(engineId, undefined, socket);
      if (wasCurrent) this.dashboards.broadcastEngineOffline(engineId);
    }
    this.closeSession(socket, 'socket_disconnected');
    this.connections.remove(socket);
    this.logger.log(
      `Engine socket disconnected; total=${this.connections.count}`,
    );
  }

  @SubscribeMessage('engine.hello')
  async hello(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ProtocolMessage,
  ) {
    const accepted = this.accept('engine.hello', message);
    if (!accepted.ok) return accepted.response;

    const engineId = String(accepted.message.payload.engine_id);
    const accounts = accepted.message.payload.accounts as Mt5AccountMetadata[];
    if (accounts.length > 1) {
      return this.rejected(message.message_id, [
        'only one MT5 account may be reported',
      ]);
    }
    if (!this.connections.identify(socket, engineId)) {
      return this.rejected(message.message_id, [
        'authorized connection cannot change engine_id',
      ]);
    }
    this.connections.setAccount(socket, accounts[0] ?? null);

    // 1.16 — Fast-path: if engine presents a device credential, verify it and
    // skip the activation.request round-trip entirely.
    const credential = accepted.message.payload.device_credential as
      | string
      | undefined;
    if (credential) {
      const result = await this.licenses.verifyDeviceCredential(
        engineId,
        credential,
      );
      if (result?.ok && result.activation) {
        const replacedSocket = this.connections.authorize(
          socket,
          result.activation.licenseId,
          result.activation.engineDeviceId,
          result.activation.symbols,
          result.activation.expiresAt,
        );
        if (replacedSocket) this.retireSocket(replacedSocket, 'replaced');
        if (result.activation.engineDeviceId) {
          const sessionId = await this.sessions.open(
            result.activation.engineDeviceId,
            engineId,
            this.sessionMetadata(socket),
          );
          if (sessionId) this.connections.setSessionId(socket, sessionId);
        }
        // Rotate the credential on every successful fast-path activation
        const rawCred = result.activation.engineDeviceId
          ? await this.licenses.issueDeviceCredential(
              result.activation.engineDeviceId,
            )
          : null;
        this.logger.log(`Engine ${engineId}: fast-path credential activation`);
        return {
          event: 'activation.accepted',
          data: {
            message_id: message.message_id,
            engine_id: engineId,
            symbols: [...result.activation.symbols],
            expires_at: result.activation.expiresAt,
            accepted_at: new Date().toISOString(),
            ...(rawCred ? { device_credential: rawCred } : {}),
          },
        };
      }
      // Credential invalid or expired — fall through to normal protocol.accepted
      // so the engine falls back to activation.request with its activation key.
      this.logger.warn(
        `Engine ${engineId}: credential verification failed, requiring full activation`,
      );
    }

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
      // Renew room membership TTL so active engines never get silently evicted.
      // Without this, rooms expire after ROOM_DEFAULT_TTL_SECONDS (1 h default)
      // even though the engine is alive and sending heartbeats — causing signal
      // delivery to stop until the engine disconnects and re-subscribes.
      // Skip renewal for expired licenses — the sweeper will terminate the
      // connection shortly; don't let expired engines keep receiving signals.
      const engineId = this.connections.engineId(socket);
      const expiresAt = this.connections.licenseExpiresAt(socket);
      const licenseExpired =
        expiresAt !== null && Date.parse(expiresAt) <= Date.now();
      if (engineId && !licenseExpired) this.rooms.renew(engineId);
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

    // ── Rate-limit: per-IP ────────────────────────────────────────────────
    const ip =
      (socket as unknown as Record<symbol, string>)[IP_PROP] ?? 'unknown';
    if (
      !this.rateLimit.check(`act_ip:${ip}`, RL_ACT_IP_LIMIT, RL_ACT_IP_WIN_MS)
    ) {
      this.logger.warn(
        `activation.request rate-limit (IP) exceeded from ${ip}`,
      );
      return this.rejected(message.message_id, ['rate_limit_exceeded']);
    }

    // ── Rate-limit: per key (prevents brute-force across connections) ─────
    const rawKey = String(accepted.message.payload.activation_key ?? '');
    if (
      this.rateLimit.remaining(
        keyBucket(rawKey),
        RL_ACT_KEY_FAILURE_LIMIT,
        RL_ACT_KEY_WIN_MS,
      ) === 0
    ) {
      this.logger.warn(
        `activation.request rate-limit (key) exceeded from ${ip}`,
      );
      return this.rejected(message.message_id, ['rate_limit_exceeded']);
    }

    const activationAccounts = accepted.message.payload
      .mt5_accounts as Mt5AccountMetadata[];
    if (activationAccounts.length > 1) {
      return this.rejected(message.message_id, [
        'only one MT5 account may be reported',
      ]);
    }
    const helloAccount = this.connections.account(socket);
    const activationAccount = activationAccounts[0] ?? null;
    if (JSON.stringify(helloAccount) !== JSON.stringify(activationAccount)) {
      return this.rejected(message.message_id, [
        'MT5 account metadata does not match engine.hello',
      ]);
    }
    if (!helloAccount && activationAccount) {
      this.connections.setAccount(socket, activationAccount);
    }

    const platform = accepted.message.payload.platform as Record<
      string,
      unknown
    >;
    const result = await this.licenses.activate(
      String(accepted.message.payload.activation_key),
      {
        engineId,
        deviceName: String(accepted.message.payload.device_name),
        engineVersion: String(accepted.message.payload.engine_version),
        platform: {
          ...platform,
          ...(activationAccount ? { mt5_account: activationAccount } : {}),
        },
      },
    );
    if (!result.ok || !result.activation) {
      this.rateLimit.check(
        keyBucket(rawKey),
        RL_ACT_KEY_FAILURE_LIMIT,
        RL_ACT_KEY_WIN_MS,
      );
      return this.rejected(message.message_id, result.errors);
    }

    const replacedSocket = this.connections.authorize(
      socket,
      result.activation.licenseId,
      result.activation.engineDeviceId,
      result.activation.symbols,
      result.activation.expiresAt,
    );
    if (replacedSocket) this.retireSocket(replacedSocket, 'replaced');
    if (result.activation.engineDeviceId) {
      const sessionId = await this.sessions.open(
        result.activation.engineDeviceId,
        engineId,
        this.sessionMetadata(socket),
      );
      if (sessionId) this.connections.setSessionId(socket, sessionId);
    }
    // 1.16 — Issue a device credential so the engine can fast-path reconnect
    const rawCred = result.activation.engineDeviceId
      ? await this.licenses.issueDeviceCredential(
          result.activation.engineDeviceId,
        )
      : null;
    return {
      event: 'activation.accepted',
      data: {
        message_id: message.message_id,
        engine_id: engineId,
        symbols: [...result.activation.symbols],
        expires_at: result.activation.expiresAt,
        accepted_at: new Date().toISOString(),
        ...(rawCred ? { device_credential: rawCred } : {}),
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

  @SubscribeMessage('execution.event')
  executionEvent(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: { payload?: unknown },
  ) {
    const engineId = this.connections.engineId(socket);
    if (!engineId || !this.connections.engineDeviceId(socket)) {
      return this.rejected(undefined, ['activation.request required']);
    }
    this.connections.touch(socket);

    const payload = (message?.payload ?? {}) as Record<string, unknown>;
    const eventType = String(
      payload.event_type ?? payload.type ?? payload.event ?? 'unknown',
    );
    const data: unknown = payload.data !== undefined ? payload.data : payload;

    this.dashboards.pushEngineEvent(engineId, eventType, data);

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
    if (!accepted.ok) {
      this.logger.warn(
        `room.subscribe rejected (validation): ${JSON.stringify(accepted.response)}`,
      );
      return accepted.response;
    }

    const engineId = this.connections.engineId(socket);
    if (!engineId) {
      this.logger.warn('room.subscribe rejected: engine.hello required');
      return this.rejected(message.message_id, ['engine.hello required']);
    }

    const payloadEngineId = String(accepted.message.payload.engine_id);
    if (payloadEngineId !== engineId) {
      this.logger.warn(
        `room.subscribe rejected: engine_id mismatch — payload=${payloadEngineId} conn=${engineId}`,
      );
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
      this.logger.warn(
        `room.subscribe rejected: engine=${engineId} symbols=${symbols.join(',')} errors=${authorizationErrors.join(',')}`,
      );
      return this.rejected(message.message_id, authorizationErrors);
    }

    const requestedTtl = accepted.message.payload.ttl_seconds as
      | number
      | undefined;
    const licenseExpiresAt = this.connections.licenseExpiresAt(socket);
    const ttlSeconds = this.cappedTtl(requestedTtl, licenseExpiresAt);
    const isNew = this.rooms.join(engineId, socket, symbols, ttlSeconds);
    const msg = `room.subscribe: engine=${engineId} symbols=${symbols.join(',')} ttl=${ttlSeconds ?? 'default'}s`;
    if (isNew) this.logger.log(msg);
    else this.logger.debug(msg);
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

    this.rooms.leave(
      engineId,
      accepted.message.payload.symbols as string[],
      socket,
    );
    return accepted.response;
  }

  /**
   * Engine reports a command completed successfully.
   * Payload: { command_id, result? }
   */
  @SubscribeMessage('command.completed')
  commandCompleted(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: { payload?: Record<string, unknown> },
  ) {
    const engineId = this.connections.engineId(socket);
    if (!engineId || !this.connections.engineDeviceId(socket)) {
      return this.rejected(undefined, ['activation.request required']);
    }

    const payload = message?.payload ?? {};
    const commandId = String(payload.command_id ?? '');
    if (!commandId) {
      return this.rejected(undefined, ['command_id is required']);
    }

    this.connections.touch(socket);
    void this.remoteCommands.markFinished(
      commandId,
      'completed',
      (payload.result as Record<string, unknown>) ?? {},
    );
    this.logger.log(`Engine ${engineId}: command ${commandId} completed`);

    return {
      event: 'protocol.accepted',
      data: { accepted_at: new Date().toISOString() },
    };
  }

  /**
   * Engine reports a command failed.
   * Payload: { command_id, reason }
   */
  @SubscribeMessage('command.failed')
  commandFailed(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: { payload?: Record<string, unknown> },
  ) {
    const engineId = this.connections.engineId(socket);
    if (!engineId || !this.connections.engineDeviceId(socket)) {
      return this.rejected(undefined, ['activation.request required']);
    }

    const payload = message?.payload ?? {};
    const commandId = String(payload.command_id ?? '');
    if (!commandId) {
      return this.rejected(undefined, ['command_id is required']);
    }

    this.connections.touch(socket);
    void this.remoteCommands.markFinished(commandId, 'failed', {
      reason: String(payload.reason ?? 'engine reported failure'),
    });
    this.logger.warn(
      `Engine ${engineId}: command ${commandId} failed — ${String(payload.reason ?? '')}`,
    );

    return {
      event: 'protocol.accepted',
      data: { accepted_at: new Date().toISOString() },
    };
  }

  // ── private helpers ───────────────────────────────────────────────────────

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

  private sessionMetadata(socket: WebSocket): Record<string, unknown> {
    const account = this.connections.account(socket);
    return account ? { mt5_account: account } : {};
  }

  private retireSocket(socket: WebSocket, reason: string) {
    const engineId = this.connections.engineId(socket);
    const wasCurrent = this.connections.isCurrent(socket);
    if (engineId) this.rooms.leave(engineId, undefined, socket);
    if (engineId && wasCurrent)
      this.dashboards.broadcastEngineOffline(engineId);
    this.closeSession(socket, reason);
    this.connections.remove(socket);
    socket.close(1008, reason);
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
