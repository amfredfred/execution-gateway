import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';
import { DashboardConnectionRegistryService } from '../dashboard-connections/dashboard-connection-registry.service';

interface EngineConnection {
  socket: WebSocket;
  engineId: string | null;
  licenseId: string | null;
  engineDeviceId: string | null;
  sessionId: string | null;
  entitledSymbols: ReadonlySet<string>;
  licenseExpiresAt: string | null;
  connectedAt: string;
  lastSeenAt: string;
}

export type StaleConnectionHandler = (
  socket: WebSocket,
  engineId: string | null,
  reason: 'heartbeat_timeout' | 'license_expired',
) => void;

@Injectable()
export class ConnectionRegistryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(ConnectionRegistryService.name);
  private readonly connections = new Map<WebSocket, EngineConnection>();
  private readonly staleHandlers = new Set<StaleConnectionHandler>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly dashboards: DashboardConnectionRegistryService,
  ) {
    this.dashboards.onExecutionMetricDemandChanged((engineId, subscribers) => {
      this.sendExecutionMetricDemand(engineId, subscribers > 0);
    });
  }

  get count() {
    return this.connections.size;
  }

  add(socket: WebSocket) {
    const now = new Date().toISOString();
    this.connections.set(socket, {
      socket,
      engineId: null,
      licenseId: null,
      engineDeviceId: null,
      sessionId: null,
      entitledSymbols: new Set(),
      licenseExpiresAt: null,
      connectedAt: now,
      lastSeenAt: now,
    });
  }

  identify(socket: WebSocket, engineId: string) {
    const connection = this.connections.get(socket);
    if (!connection) return;
    connection.engineId = engineId;
    connection.lastSeenAt = new Date().toISOString();
  }

  engineId(socket: WebSocket) {
    return this.connections.get(socket)?.engineId ?? null;
  }

  authorize(
    socket: WebSocket,
    licenseId: string,
    engineDeviceId: string | undefined,
    entitledSymbols: ReadonlySet<string>,
    licenseExpiresAt: string | null,
  ) {
    const connection = this.connections.get(socket);
    if (!connection) return;
    connection.licenseId = licenseId;
    connection.engineDeviceId = engineDeviceId ?? null;
    connection.entitledSymbols = new Set(entitledSymbols);
    connection.licenseExpiresAt = licenseExpiresAt;
    connection.lastSeenAt = new Date().toISOString();
    if (
      connection.engineId &&
      this.dashboards.executionMetricSubscriberCount(connection.engineId) > 0
    ) {
      this.sendExecutionMetricDemand(connection.engineId, true);
    }
  }

  authorizationErrors(socket: WebSocket, symbols: string[]) {
    const connection = this.connections.get(socket);
    if (!connection?.licenseId) return ['activation.request required'];
    if (
      connection.licenseExpiresAt &&
      Date.parse(connection.licenseExpiresAt) <= Date.now()
    ) {
      return ['license expired'];
    }

    const unauthorized = symbols
      .map((symbol) => this.normalizeSymbol(symbol))
      .filter((symbol) => !connection.entitledSymbols.has(symbol));
    return unauthorized.length > 0
      ? [`symbols not entitled: ${unauthorized.join(', ')}`]
      : [];
  }

  licenseExpiresAt(socket: WebSocket): string | null {
    return this.connections.get(socket)?.licenseExpiresAt ?? null;
  }

  engineDeviceId(socket: WebSocket): string | null {
    return this.connections.get(socket)?.engineDeviceId ?? null;
  }

  sessionId(socket: WebSocket): string | null {
    return this.connections.get(socket)?.sessionId ?? null;
  }

  setSessionId(socket: WebSocket, sessionId: string) {
    const connection = this.connections.get(socket);
    if (connection) connection.sessionId = sessionId;
  }

  touch(socket: WebSocket) {
    const connection = this.connections.get(socket);
    if (connection) connection.lastSeenAt = new Date().toISOString();
  }

  /**
   * Sends a message to the currently connected engine with the given engineId.
   * Returns true if the send succeeded, false if the engine is offline or the
   * socket is not in OPEN state.
   */
  sendToEngine(engineId: string, event: string, data: unknown): boolean {
    const connection = [...this.connections.values()].find(
      (c) => c.engineId === engineId && c.licenseId,
    );
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) {
      return false;
    }
    try {
      connection.socket.send(JSON.stringify({ event, data }));
      return true;
    } catch {
      return false;
    }
  }

  remove(socket: WebSocket) {
    this.connections.delete(socket);
  }

  private sendExecutionMetricDemand(engineId: string, subscribed: boolean) {
    const connection = [...this.connections.values()].find(
      (candidate) => candidate.engineId === engineId && candidate.licenseId,
    );
    if (!connection || connection.socket.readyState !== WebSocket.OPEN) return;
    connection.socket.send(
      JSON.stringify({
        event: subscribed
          ? 'execution.metrics.subscribe'
          : 'execution.metrics.unsubscribe',
        data: {},
      }),
    );
  }

  onStale(handler: StaleConnectionHandler) {
    this.staleHandlers.add(handler);
    return () => this.staleHandlers.delete(handler);
  }

  onModuleInit() {
    // Sweep more frequently than the timeout so stale connections are caught promptly.
    const offlineAfterSeconds = this.config.get<number>(
      'connections.offlineAfterSeconds',
      90,
    );
    const sweepIntervalMs = Math.max(5_000, (offlineAfterSeconds / 3) * 1000);
    this.sweepTimer = setInterval(() => this.sweepStale(), sweepIntervalMs);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private sweepStale() {
    const now = Date.now();
    const offlineAfterMs =
      this.config.get<number>('connections.offlineAfterSeconds', 90) * 1000;

    for (const connection of this.connections.values()) {
      const lastSeen = Date.parse(connection.lastSeenAt);

      if (
        connection.licenseExpiresAt &&
        Date.parse(connection.licenseExpiresAt) <= now
      ) {
        this.logger.warn(
          `Engine ${connection.engineId ?? 'unidentified'} license expired; terminating connection`,
        );
        this.notifyStale(
          connection.socket,
          connection.engineId,
          'license_expired',
        );
        continue;
      }

      if (now - lastSeen > offlineAfterMs) {
        this.logger.warn(
          `Engine ${connection.engineId ?? 'unidentified'} heartbeat timeout; terminating connection`,
        );
        this.notifyStale(
          connection.socket,
          connection.engineId,
          'heartbeat_timeout',
        );
      }
    }
  }

  private notifyStale(
    socket: WebSocket,
    engineId: string | null,
    reason: 'heartbeat_timeout' | 'license_expired',
  ) {
    for (const handler of this.staleHandlers) handler(socket, engineId, reason);
  }

  private normalizeSymbol(symbol: string) {
    return symbol.trim().replaceAll('/', '').toUpperCase();
  }
}
