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
import { DashboardAuthService } from './dashboard-auth.service';
import { DashboardConnectionRegistryService } from './dashboard-connection-registry.service';
import { LicenseService } from '../licensing/license.service';
import { RateLimitService } from '../common/rate-limit/rate-limit.service';
import { EngineRegistryService } from '../engine-connections/engine-registry.service';
import { isManagerEngineId } from '../engine-connections/manager-engine';

// ── Rate-limit constants ───────────────────────────────────────────────────
/** Max new dashboard WS connections accepted per IP per minute. */
const RL_DCONN_LIMIT = 30;
const RL_DCONN_WIN_MS = 60_000;

/** Max dashboard.authenticate attempts per IP per minute. */
const RL_DAUTH_LIMIT = 10;
const RL_DAUTH_WIN_MS = 60_000;

// Symbol used to stash the remote IP on the socket at connect-time.
const IP_PROP = Symbol('rl_ip');

interface DashboardAuthMessage {
  access_token?: string;
}
interface ExecutionMetricsMessage {
  engine_id?: string;
}

@WebSocketGateway({ path: '/dashboard' })
export class DashboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DashboardGateway.name);

  constructor(
    private readonly auth: DashboardAuthService,
    private readonly connections: DashboardConnectionRegistryService,
    private readonly licenses: LicenseService,
    private readonly rateLimit: RateLimitService,
    private readonly engineRegistry: EngineRegistryService,
  ) {
    this.engineRegistry.onHealthChanged((entry) => {
      this.connections.broadcastEngineHealthChanged(entry.sourceKey, entry.healthState);
      if (!isManagerEngineId(entry.sourceKey)) {
        this.connections.broadcastEngineRegistryUpdated(entry);
      }
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

    // Rate-limit: close immediately if this IP is flooding dashboard connections.
    if (
      !this.rateLimit.check(`dash_conn:${ip}`, RL_DCONN_LIMIT, RL_DCONN_WIN_MS)
    ) {
      this.logger.warn(`Dashboard rate-limit: too many connections from ${ip}`);
      socket.close(1008, 'rate_limit_exceeded');
      return;
    }

    this.connections.add(socket);
    this.logger.log(
      `Dashboard socket connected; total=${this.connections.count}`,
    );
  }

  handleDisconnect(socket: WebSocket) {
    this.connections.remove(socket);
    this.logger.log(
      `Dashboard socket disconnected; total=${this.connections.count}`,
    );
  }

  @SubscribeMessage('dashboard.authenticate')
  async authenticate(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: DashboardAuthMessage,
  ) {
    // Rate-limit before doing any crypto work on the token.
    const ip =
      (socket as unknown as Record<symbol, string>)[IP_PROP] ?? 'unknown';
    if (!this.rateLimit.check(`dauth:${ip}`, RL_DAUTH_LIMIT, RL_DAUTH_WIN_MS)) {
      this.logger.warn(`dashboard.authenticate rate-limit exceeded from ${ip}`);
      socket.close(1008, 'rate_limit_exceeded');
      return {
        event: 'dashboard.authentication_failed',
        data: { reason: 'rate_limit_exceeded' },
      };
    }

    const user = await this.auth.verify(String(message?.access_token ?? ''));
    if (!user) {
      socket.close(1008, 'authentication_failed');
      return {
        event: 'dashboard.authentication_failed',
        data: { reason: 'invalid or expired access token' },
      };
    }

    this.connections.authenticate(socket, user.id, user.email ?? null);
    return {
      event: 'dashboard.authenticated',
      data: {
        user_id: user.id,
        email: user.email ?? null,
        authenticated_at: new Date().toISOString(),
      },
    };
  }

  @SubscribeMessage('dashboard.ping')
  ping(@ConnectedSocket() socket: WebSocket) {
    if (!this.connections.isAuthenticated(socket)) {
      return {
        event: 'dashboard.authentication_required',
        data: {},
      };
    }
    return {
      event: 'dashboard.pong',
      data: { observed_at: new Date().toISOString() },
    };
  }

  @SubscribeMessage('signal.metrics.subscribe')
  subscribeSignalMetrics(@ConnectedSocket() socket: WebSocket) {
    if (!this.connections.isAuthenticated(socket)) {
      return { event: 'dashboard.authentication_required', data: {} };
    }
    this.connections.subscribeSignalMetrics(socket);
    return {
      event: 'signal.metrics.subscribed',
      data: { subscribers: this.connections.signalMetricSubscriberCount },
    };
  }

  @SubscribeMessage('signal.metrics.unsubscribe')
  unsubscribeSignalMetrics(@ConnectedSocket() socket: WebSocket) {
    this.connections.unsubscribeSignalMetrics(socket);
    return {
      event: 'signal.metrics.unsubscribed',
      data: { subscribers: this.connections.signalMetricSubscriberCount },
    };
  }

  @SubscribeMessage('execution.metrics.subscribe')
  async subscribeExecutionMetrics(
    @ConnectedSocket() socket: WebSocket,
    @MessageBody() message: ExecutionMetricsMessage,
  ) {
    const userId = this.connections.userId(socket);
    const engineId = String(message?.engine_id ?? '');
    if (!userId)
      return { event: 'dashboard.authentication_required', data: {} };
    const entry = this.engineRegistry.getEntry(engineId);
    const ownershipEngineId = entry?.parentSourceKey ?? engineId;
    if (
      !engineId ||
      !(await this.licenses.userOwnsEngine(userId, ownershipEngineId))
    ) {
      return {
        event: 'execution.metrics.forbidden',
        data: { engine_id: engineId, reason: 'engine is not owned by user' },
      };
    }
    this.connections.subscribeExecutionMetrics(socket, engineId);
    return {
      event: 'execution.metrics.subscribed',
      data: { engine_id: engineId },
    };
  }

  @SubscribeMessage('execution.metrics.unsubscribe')
  unsubscribeExecutionMetrics(@ConnectedSocket() socket: WebSocket) {
    this.connections.unsubscribeExecutionMetrics(socket);
    return { event: 'execution.metrics.unsubscribed', data: {} };
  }

  /** Returns all known execution sources and their latest state. */
  @SubscribeMessage('gateway.engines.snapshot')
  enginesSnapshot(@ConnectedSocket() socket: WebSocket) {
    if (!this.connections.isAuthenticated(socket)) {
      return { event: 'dashboard.authentication_required', data: {} };
    }
    return {
      event: 'gateway.engines.snapshot',
      data: {
        engines: this.engineRegistry
          .snapshot()
          .filter((entry) => !isManagerEngineId(entry.sourceKey)),
        ts: new Date().toISOString(),
      },
    };
  }
}
