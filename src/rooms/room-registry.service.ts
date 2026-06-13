import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocket } from 'ws';

interface Membership {
  engineId: string;
  socket: WebSocket;
  expiresAt: number;
}

interface Room {
  symbol: string;
  members: Map<string, Membership>;
}

type SymbolsChangedListener = (symbols: ReadonlySet<string>) => void;

@Injectable()
export class RoomRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RoomRegistryService.name);
  private readonly rooms = new Map<string, Room>();
  private readonly listeners = new Set<SymbolsChangedListener>();
  private evictionTimer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {}

  get symbols(): ReadonlySet<string> {
    return new Set(this.rooms.keys());
  }

  get roomCount() {
    return this.rooms.size;
  }

  join(
    engineId: string,
    socket: WebSocket,
    symbols: string[],
    ttlSeconds?: number,
  ): boolean {
    const ttl =
      ttlSeconds ?? this.config.get<number>('rooms.defaultTtlSeconds', 3600);
    const expiresAt = Date.now() + ttl * 1000;
    let symbolsChanged = false;

    for (const requested of symbols) {
      const symbol = this.normalizeSymbol(requested);
      let room = this.rooms.get(symbol);
      if (!room) {
        room = { symbol, members: new Map() };
        this.rooms.set(symbol, room);
        symbolsChanged = true;
      }
      room.members.set(engineId, { engineId, socket, expiresAt });
    }

    if (symbolsChanged) this.notifySymbolsChanged();
    return symbolsChanged;
  }

  /**
   * Refresh the TTL for all room memberships held by an engine.
   * Called on every engine heartbeat so rooms never expire for active engines.
   */
  renew(engineId: string, ttlSeconds?: number) {
    const ttl =
      ttlSeconds ?? this.config.get<number>('rooms.defaultTtlSeconds', 3600);
    const expiresAt = Date.now() + ttl * 1000;
    for (const room of this.rooms.values()) {
      const membership = room.members.get(engineId);
      if (membership) membership.expiresAt = expiresAt;
    }
  }

  leave(engineId: string, symbols?: string[], socket?: WebSocket) {
    const targets = symbols?.map((symbol) => this.normalizeSymbol(symbol));
    let symbolsChanged = false;

    for (const [symbol, room] of this.rooms) {
      if (targets && !targets.includes(symbol)) continue;
      const membership = room.members.get(engineId);
      if (!membership || (socket && membership.socket !== socket)) continue;
      room.members.delete(engineId);
      if (room.members.size === 0) {
        this.rooms.delete(symbol);
        symbolsChanged = true;
      }
    }

    if (symbolsChanged) this.notifySymbolsChanged();
  }

  broadcast(symbol: string, serializedFrame: string) {
    const room = this.rooms.get(this.normalizeSymbol(symbol));
    if (!room) return 0;

    let delivered = 0;
    for (const membership of room.members.values()) {
      if (membership.socket.readyState !== WebSocket.OPEN) continue;
      membership.socket.send(serializedFrame);
      delivered += 1;
    }
    return delivered;
  }

  onSymbolsChanged(listener: SymbolsChangedListener) {
    this.listeners.add(listener);
    listener(this.symbols);
    return () => this.listeners.delete(listener);
  }

  onModuleInit() {
    const intervalSeconds = this.config.get<number>(
      'rooms.evictionIntervalSeconds',
      15,
    );
    this.evictionTimer = setInterval(
      () => this.evictExpired(),
      intervalSeconds * 1000,
    );
    this.evictionTimer.unref();
  }

  onModuleDestroy() {
    if (this.evictionTimer) clearInterval(this.evictionTimer);
  }

  private evictExpired() {
    const now = Date.now();
    let symbolsChanged = false;

    for (const [symbol, room] of this.rooms) {
      for (const [engineId, membership] of room.members) {
        if (membership.expiresAt <= now) room.members.delete(engineId);
      }
      if (room.members.size === 0) {
        this.rooms.delete(symbol);
        symbolsChanged = true;
      }
    }

    if (symbolsChanged) {
      this.logger.debug('Expired room memberships evicted');
      this.notifySymbolsChanged();
    }
  }

  private notifySymbolsChanged() {
    const symbols = this.symbols;
    for (const listener of this.listeners) listener(symbols);
  }

  private normalizeSymbol(symbol: string) {
    return symbol.trim().replaceAll('/', '').toUpperCase();
  }
}
