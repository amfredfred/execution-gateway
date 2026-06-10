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
  // BUG-12: reverse index for O(1) engineId lookups. Latest identify wins;
  // remove() only clears the entry if it still points at the removed socket.
  private readonly byEngineId = new Map<string, EngineConnection>();
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
    if (connection.engineId && connection.engineId !== engineId) {
      const indexed = this.byEngineId.get(connection.engineId);
      if (indexed === connection) this.byEngineId.delete(connection.engineId);
    }
    connection.engineId = engineId;
    connection.lastSeenAt = new Date().toISOString();
    this.byEngineId.set(engineId, connection);
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
    const connection = this.authorizedConnection(engineId);
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

  /**
   * Returns a list of all currently connected engine IDs (authenticated
   * connections only — those that have completed activation.request).
   */
  connectedEngineIds(): string[] {
    return [...this.connections.values()]
      .filter((c) => c.engineId && c.licenseId)
      .map((c) => c.engineId as string);
  }

  remove(socket: WebSocket) {
    const connection = this.connections.get(socket);
    if (connection?.engineId) {
      const indexed = this.byEngineId.get(connection.engineId);
      if (indexed === connection) this.byEngineId.delete(connection.engineId);
    }
    this.connections.delete(socket);
  }

  /** BUG-12: O(1) lookup of the authenticated connection for an engineId. */
  private authorizedConnection(engineId: string): EngineConnection | null {
    const connection = this.byEngineId.get(engineId);
    return connection?.licenseId ? connection : null;
  }

  private sendExecutionMetricDemand(engineId: string, subscribed: boolean) {
    const connection = this.authorizedConnection(engineId);
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

    // BUG-10: Collect stale entries first, then process outside the Map iterator.
    // notifyStale → rooms.leave → notifySymbolsChanged → syncSubscriptions can call
    // remove() which mutates this.connections mid-iteration, and any throw would abort
    // the entire sweep silently.
    const stale: Array<{
      socket: WebSocket;
      engineId: string | null;
      reason: 'heartbeat_timeout' | 'license_expired';
    }> = [];

    for (const connection of this.connections.values()) {
      const lastSeen = Date.parse(connection.lastSeenAt);

      if (
        connection.licenseExpiresAt &&
        Date.parse(connection.licenseExpiresAt) <= now
      ) {
        this.logger.warn(
          `Engine ${connection.engineId ?? 'unidentified'} license expired; terminating connection`,
        );
        stale.push({
          socket: connection.socket,
          engineId: connection.engineId,
          reason: 'license_expired',
        });
        continue;
      }

      if (now - lastSeen > offlineAfterMs) {
        this.logger.warn(
          `Engine ${connection.engineId ?? 'unidentified'} heartbeat timeout; terminating connection`,
        );
        stale.push({
          socket: connection.socket,
          engineId: connection.engineId,
          reason: 'heartbeat_timeout',
        });
      }
    }

    for (const { socket, engineId, reason } of stale) {
      try {
        this.notifyStale(socket, engineId, reason);
      } catch (err) {
        this.logger.error(
          `sweepStale: handler threw for engine ${engineId ?? 'unidentified'} (${reason}): ${String(err)}`,
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
