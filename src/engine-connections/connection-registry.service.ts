import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

interface EngineConnection {
  socket: WebSocket;
  engineId: string | null;
  licenseId: string | null;
  entitledSymbols: ReadonlySet<string>;
  licenseExpiresAt: string | null;
  connectedAt: string;
  lastSeenAt: string;
}

@Injectable()
export class ConnectionRegistryService {
  private readonly connections = new Map<WebSocket, EngineConnection>();

  get count() {
    return this.connections.size;
  }

  add(socket: WebSocket) {
    const now = new Date().toISOString();
    this.connections.set(socket, {
      socket,
      engineId: null,
      licenseId: null,
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
    entitledSymbols: ReadonlySet<string>,
    licenseExpiresAt: string | null,
  ) {
    const connection = this.connections.get(socket);
    if (!connection) return;
    connection.licenseId = licenseId;
    connection.entitledSymbols = new Set(entitledSymbols);
    connection.licenseExpiresAt = licenseExpiresAt;
    connection.lastSeenAt = new Date().toISOString();
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

  touch(socket: WebSocket) {
    const connection = this.connections.get(socket);
    if (connection) connection.lastSeenAt = new Date().toISOString();
  }

  remove(socket: WebSocket) {
    this.connections.delete(socket);
  }

  private normalizeSymbol(symbol: string) {
    return symbol.trim().replaceAll('/', '').toUpperCase();
  }
}
