import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RawData, WebSocket } from 'ws';
import { DashboardConnectionRegistryService } from '../dashboard-connections/dashboard-connection-registry.service';
import { RoomRegistryService } from '../rooms/room-registry.service';

interface SignalEngineMessage {
  event?: string;
  payload?: Record<string, unknown> & { symbol?: string };
}

@Injectable()
export class SignalEngineSubscriberService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(SignalEngineSubscriberService.name);
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private pingTimer?: NodeJS.Timeout;
  private unsubscribeRoomChanges?: () => void;
  private unsubscribeMetricDemand?: () => void;
  private desiredSymbols = new Set<string>();
  private subscribedSymbols = new Set<string>();
  private metricsDesired = false;
  private metricsSubscribed = false;
  private stopping = false;
  private _availableSymbols: string[] = [];

  /** Symbols the signal engine currently supports — populated on connect. */
  get availableSymbols(): string[] {
    return this._availableSymbols;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly rooms: RoomRegistryService,
    private readonly dashboards: DashboardConnectionRegistryService,
  ) {}

  onModuleInit() {
    this.unsubscribeRoomChanges = this.rooms.onSymbolsChanged((symbols) => {
      this.desiredSymbols = new Set(symbols);
      this.syncSubscriptions();
    });
    this.unsubscribeMetricDemand = this.dashboards.onSignalMetricDemandChanged(
      (subscribers) => {
        this.metricsDesired = subscribers > 0;
        this.syncMetricSubscription();
      },
    );
    this.connect();
  }

  onModuleDestroy() {
    this.stopping = true;
    this.unsubscribeRoomChanges?.();
    this.unsubscribeMetricDemand?.();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.socket?.close();
  }

  private connect() {
    const baseUrl = this.config.get<string>(
      'signalEngine.url',
      'ws://localhost:8765',
    );
    const secret = this.config.get<string>('signalEngine.secret');
    const url = secret
      ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(secret)}`
      : baseUrl;

    this.socket = new WebSocket(url);
    this.socket.on('open', () => {
      this.logger.log('Connected as sole Signal Engine subscriber');
      this.subscribedSymbols.clear();
      this.metricsSubscribed = false;
      this.syncSubscriptions();
      this.syncMetricSubscription();
      this.startPing();
    });
    this.socket.on('message', (raw) => this.handleMessage(raw));
    this.socket.on('close', () => {
      this.stopPing();
      this.scheduleReconnect();
    });
    this.socket.on('error', (error) => {
      this.logger.warn(`Signal Engine connection error: ${error.message}`);
    });
    // Terminate zombie connections: if a pong is not received within the ping
    // interval, the ws library will emit 'error' + 'close', triggering reconnect.
    this.socket.on('pong', () => {
      // pong received — connection is alive; nothing to do.
    });
  }

  private handleMessage(raw: RawData) {
    // Outer try/catch: a bad message payload or a CLOSING-race send() inside
    // broadcastSignalMetrics must never escape as an uncaught exception and
    // crash the gateway process (raw ws 'message' events are not wrapped by
    // NestJS, so any throw here becomes an unhandled Node.js error).
    try {
      const serialized = this.rawToString(raw);
      let message: SignalEngineMessage;
      try {
        message = JSON.parse(serialized) as SignalEngineMessage;
      } catch {
        return;
      }

      const event = String(message.event ?? '');

      // Signal engine handshake — capture the symbols it trades.
      if (event === 'connected' && message.payload) {
        const raw = (message.payload as Record<string, unknown>)
          .supported_symbols;
        if (Array.isArray(raw)) {
          this._availableSymbols = (raw as unknown[])
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim().toUpperCase());
          this.logger.log(
            `Signal Engine supports: ${this._availableSymbols.join(', ')}`,
          );
        }
        return;
      }

      // Metrics snapshot → enrich with buffered events and broadcast to dashboards
      if (event === 'metrics.snapshot' && message.payload) {
        const delivered = this.dashboards.broadcastSignalMetrics(
          this.sanitizeMetrics(message.payload),
        );
        this.logger.debug(
          `Delivered signal metrics to ${delivered} dashboard(s)`,
        );
        return;
      }

      // signal.triggered → forward raw message to subscribed execution engine rooms
      if (event === 'signal.triggered' && message.payload?.symbol) {
        const delivered = this.rooms.broadcast(
          message.payload.symbol,
          serialized,
        );
        this.logger.debug(
          `Delivered ${message.payload.symbol} signal to ${delivered} engine(s)`,
        );
        // fall through — also buffer for the dashboard event log
      }

      // Buffer every non-metrics event so dashboards can display signal feeds,
      // rejections, and operational logs.  Events ride in the next metrics
      // broadcast via recent_events — no extra WS message type needed.
      if (event) {
        this.dashboards.pushSignalEvent(event, message.payload ?? {});
      }
    } catch (err) {
      this.logger.error(
        `Unhandled error in signal-engine message handler: ${String(err)}`,
      );
    }
  }

  private syncMetricSubscription() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.metricsDesired && !this.metricsSubscribed) {
      this.socket.send(JSON.stringify({ action: 'subscribe_metrics' }));
      this.metricsSubscribed = true;
    } else if (!this.metricsDesired && this.metricsSubscribed) {
      this.socket.send(JSON.stringify({ action: 'unsubscribe_metrics' }));
      this.metricsSubscribed = false;
    }
  }

  private sanitizeMetrics(payload: Record<string, unknown>) {
    const system = (payload.system ?? {}) as Record<string, unknown>;
    const api = (payload.api ?? {}) as Record<string, unknown>;
    return {
      observed_at: payload.ts ?? Date.now(),
      system: {
        uptime_ms: system.uptime_ms,
        uptime_s: system.uptime_s,
        memory_mb: system.memory_mb,
      },
      metrics: payload.metrics ?? {},
      latency: payload.latency ?? {},
      scheduler: payload.scheduler ?? [],
      active_signals: payload.active_signals ?? [],
      active_zones: payload.active_zones ?? [],
      // config is intentionally excluded — it may contain private strategy settings
      api: {
        calls_last_min: api.calls_last_min,
        by_source: api.by_source,
      },
    };
  }

  private syncSubscriptions() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const additions = [...this.desiredSymbols].filter(
      (symbol) => !this.subscribedSymbols.has(symbol),
    );
    const removals = [...this.subscribedSymbols].filter(
      (symbol) => !this.desiredSymbols.has(symbol),
    );

    if (additions.length > 0) {
      this.socket.send(
        JSON.stringify({ action: 'subscribe', symbols: additions }),
      );
      for (const symbol of additions) this.subscribedSymbols.add(symbol);
    }

    if (removals.length > 0) {
      this.socket.send(
        JSON.stringify({ action: 'unsubscribe', symbols: removals }),
      );
      for (const symbol of removals) this.subscribedSymbols.delete(symbol);
    }
  }

  private startPing() {
    this.stopPing();
    // Send a WS ping every 30 s. If the signal engine doesn't respond with a
    // pong, the ws library will terminate the socket (error + close events),
    // which triggers reconnect and a fresh subscribe — preventing zombie sockets
    // where readyState appears OPEN but the signal engine side is already gone.
    this.pingTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.ping();
      }
    }, 30_000);
    this.pingTimer.unref();
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const delay = this.config.get<number>(
      'signalEngine.reconnectDelayMs',
      1000,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      try {
        this.connect();
      } catch (err) {
        // new WebSocket() can throw for a malformed URL — log and schedule
        // another attempt rather than letting the process crash.
        this.logger.error(`Signal Engine reconnect failed: ${String(err)}`);
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref();
  }

  private rawToString(raw: RawData): string {
    if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
    return raw.toString('utf8');
  }
}
