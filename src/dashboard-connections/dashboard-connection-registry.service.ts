import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

interface DashboardConnection {
  userId: string | null;
  email: string | null;
  connectedAt: string;
  signalMetrics: boolean;
}

@Injectable()
export class DashboardConnectionRegistryService {
  private readonly connections = new Map<WebSocket, DashboardConnection>();
  private readonly signalMetricDemandListeners = new Set<
    (subscribers: number) => void
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

  broadcastSignalMetrics(data: unknown) {
    const serialized = JSON.stringify({
      event: 'signal.metrics.snapshot',
      data,
    });
    let delivered = 0;
    for (const [socket, connection] of this.connections) {
      if (!connection.userId || !connection.signalMetrics) continue;
      if (socket.readyState !== WebSocket.OPEN) continue;
      socket.send(serialized);
      delivered += 1;
    }
    return delivered;
  }

  remove(socket: WebSocket) {
    const hadSignalMetrics = this.connections.get(socket)?.signalMetrics;
    this.connections.delete(socket);
    if (hadSignalMetrics) this.emitSignalMetricDemand();
  }

  private emitSignalMetricDemand() {
    const count = this.signalMetricSubscriberCount;
    for (const listener of this.signalMetricDemandListeners) listener(count);
  }
}
