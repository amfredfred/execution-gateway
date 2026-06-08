import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

export interface ExecutionEventEntry {
  id: string;
  event_type: string;
  ts: string;
  summary: string;
  data: unknown;
}

interface DashboardConnection {
  userId: string | null;
  email: string | null;
  connectedAt: string;
  signalMetrics: boolean;
  executionEngineId: string | null;
}

@Injectable()
export class DashboardConnectionRegistryService {
  private readonly connections = new Map<WebSocket, DashboardConnection>();
  private readonly eventBuffers = new Map<string, ExecutionEventEntry[]>();
  private readonly signalEventBuffer: ExecutionEventEntry[] = [];
  private readonly signalMetricDemandListeners = new Set<
    (subscribers: number) => void
  >();
  private readonly executionMetricDemandListeners = new Set<
    (engineId: string, subscribers: number) => void
  >();

  get count() {
    return this.connections.size;
  }

  add(socket: WebSocket) {
    this.connections.set(socket, {
      userId: null,
      email: null,
      connectedAt: new Date().toISOString(),
      signalMetrics: false,
      executionEngineId: null,
    });
  }

  authenticate(socket: WebSocket, userId: string, email: string | null) {
    const connection = this.connections.get(socket);
    if (!connection) return;
    connection.userId = userId;
    connection.email = email;
  }

  userId(socket: WebSocket) {
    return this.connections.get(socket)?.userId ?? null;
  }

  isAuthenticated(socket: WebSocket) {
    return this.userId(socket) !== null;
  }

  subscribeSignalMetrics(socket: WebSocket) {
    const connection = this.connections.get(socket);
    if (!connection || !connection.userId || connection.signalMetrics)
      return false;
    connection.signalMetrics = true;
    this.emitSignalMetricDemand();
    return true;
  }

  unsubscribeSignalMetrics(socket: WebSocket) {
    const connection = this.connections.get(socket);
    if (!connection?.signalMetrics) return false;
    connection.signalMetrics = false;
    this.emitSignalMetricDemand();
    return true;
  }

  get signalMetricSubscriberCount() {
    return [...this.connections.values()].filter(
      (connection) => connection.signalMetrics,
    ).length;
  }

  onSignalMetricDemandChanged(listener: (subscribers: number) => void) {
    this.signalMetricDemandListeners.add(listener);
    listener(this.signalMetricSubscriberCount);
    return () => this.signalMetricDemandListeners.delete(listener);
  }

  pushSignalEvent(eventType: string, data: unknown): ExecutionEventEntry {
    const entry: ExecutionEventEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      event_type: eventType,
      ts: new Date().toISOString(),
      summary: this.summariseEvent(eventType, data),
      data,
    };
    this.signalEventBuffer.unshift(entry);
    if (this.signalEventBuffer.length > 200) this.signalEventBuffer.length = 200;
    return entry;
  }

  broadcastSignalMetrics(data: unknown) {
    const enriched =
      typeof data === 'object' && data !== null
        ? {
            ...(data as Record<string, unknown>),
            recent_events: this.signalEventBuffer,
          }
        : { recent_events: this.signalEventBuffer };

    const serialized = JSON.stringify({
      event: 'signal.metrics.snapshot',
      data: enriched,
    });
    let delivered = 0;
    for (const [socket, connection] of this.connections) {
      if (!connection.userId || !connection.signalMetrics) continue;
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(serialized);
        delivered += 1;
      } catch {
        // Socket closed mid-send (CLOSING race) — evict so next broadcast
        // skips it; the ws 'close' event will call handleDisconnect normally.
        this.connections.delete(socket);
      }
    }
    return delivered;
  }

  subscribeExecutionMetrics(socket: WebSocket, engineId: string) {
    const connection = this.connections.get(socket);
    if (!connection?.userId || connection.executionEngineId === engineId)
      return false;
    const previous = connection.executionEngineId;
    connection.executionEngineId = engineId;
    if (previous) this.emitExecutionMetricDemand(previous);
    this.emitExecutionMetricDemand(engineId);
    return true;
  }

  unsubscribeExecutionMetrics(socket: WebSocket) {
    const connection = this.connections.get(socket);
    const engineId = connection?.executionEngineId;
    if (!connection || !engineId) return false;
    connection.executionEngineId = null;
    this.emitExecutionMetricDemand(engineId);
    return true;
  }

  executionMetricSubscriberCount(engineId: string) {
    return [...this.connections.values()].filter(
      (connection) => connection.executionEngineId === engineId,
    ).length;
  }

  onExecutionMetricDemandChanged(
    listener: (engineId: string, subscribers: number) => void,
  ) {
    this.executionMetricDemandListeners.add(listener);
    return () => this.executionMetricDemandListeners.delete(listener);
  }

  pushEngineEvent(
    engineId: string,
    eventType: string,
    data: unknown,
  ): ExecutionEventEntry {
    const entry: ExecutionEventEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      event_type: eventType,
      ts: new Date().toISOString(),
      summary: this.summariseEvent(eventType, data),
      data,
    };
    const buf = this.eventBuffers.get(engineId) ?? [];
    buf.unshift(entry);
    if (buf.length > 200) buf.length = 200;
    this.eventBuffers.set(engineId, buf);
    return entry;
  }

  broadcastEngineOffline(engineId: string): void {
    const serialized = JSON.stringify({
      event: 'engine.offline',
      data: { engine_id: engineId, offline_at: new Date().toISOString() },
    });
    for (const [socket, connection] of this.connections) {
      if (connection.executionEngineId !== engineId) continue;
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(serialized);
      } catch {
        this.connections.delete(socket);
      }
    }
  }

  broadcastExecutionMetrics(engineId: string, data: unknown) {
    const events = this.eventBuffers.get(engineId) ?? [];
    const snapshotWithEvents =
      typeof data === 'object' && data !== null
        ? { ...(data as Record<string, unknown>), recent_events: events }
        : { recent_events: events };

    const serialized = JSON.stringify({
      event: 'execution.metrics.snapshot',
      data: { engine_id: engineId, snapshot: snapshotWithEvents },
    });
    let delivered = 0;
    for (const [socket, connection] of this.connections) {
      if (!connection.userId || connection.executionEngineId !== engineId)
        continue;
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(serialized);
        delivered += 1;
      } catch {
        // Socket closed mid-send (CLOSING race) — evict so next broadcast
        // skips it; the ws 'close' event will call handleDisconnect normally.
        this.connections.delete(socket);
      }
    }
    return delivered;
  }

  remove(socket: WebSocket) {
    const hadSignalMetrics = this.connections.get(socket)?.signalMetrics;
    const executionEngineId =
      this.connections.get(socket)?.executionEngineId ?? null;
    this.connections.delete(socket);
    if (hadSignalMetrics) this.emitSignalMetricDemand();
    if (executionEngineId) this.emitExecutionMetricDemand(executionEngineId);
  }

  private summariseEvent(type: string, data: unknown): string {
    if (!data || typeof data !== 'object') return type;
    const p = data as Record<string, unknown>;
    const parts: string[] = [];
    if (p.symbol) parts.push(String(p.symbol));
    if (p.strategy) parts.push(`strategy=${String(p.strategy)}`);
    if (p.reason) parts.push(String(p.reason));
    if (p.message) parts.push(String(p.message));
    if (p.ticket) parts.push(`#${String(p.ticket)}`);
    return parts.length ? parts.join(' · ') : type;
  }

  private emitSignalMetricDemand() {
    const count = this.signalMetricSubscriberCount;
    for (const listener of this.signalMetricDemandListeners) listener(count);
  }

  private emitExecutionMetricDemand(engineId: string) {
    const count = this.executionMetricSubscriberCount(engineId);
    for (const listener of this.executionMetricDemandListeners)
      listener(engineId, count);
  }
}
