import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Mt5AccountMetadata } from '../licensing/license.types';

export type EngineHealthState =
  | 'online'
  | 'stale'
  | 'offline'
  | 'error'
  | 'unknown';

export interface EngineAwarenessPayload {
  /** Operator-configured label that matches the signal manager's broker name. */
  source_key?: string;
  broker?: string;
  terminal_connected?: boolean;
  autotrading_enabled?: boolean;
  runtime_state?: string;
  last_error?: string | null;
  [key: string]: unknown;
}

export interface EngineRegistryEntry {
  /** Source Key = engineId — unique per execution engine instance. */
  sourceKey: string;
  connectedAt: string | null;
  lastSeenAt: string | null;
  lastMetricsAt: string | null;
  lastAwarenessAt: string | null;
  healthState: EngineHealthState;
  latestMetrics: unknown;
  latestAwareness: EngineAwarenessPayload | null;
  lastError: string | null;
  account: Mt5AccountMetadata | null;
  deviceName: string | null;
  engineVersion: string | null;
}

type HealthListener = (entry: EngineRegistryEntry) => void;

@Injectable()
export class EngineRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EngineRegistryService.name);
  private readonly entries = new Map<string, EngineRegistryEntry>();
  private readonly healthListeners = new Set<HealthListener>();
  private sweepTimer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const intervalMs = Math.max(
      5_000,
      this.config.get<number>('engineRegistry.staleAfterSeconds', 30) * 333,
    );
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  onModuleDestroy() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ── Mutation ──────────────────────────────────────────────────────────────

  register(
    sourceKey: string,
    account: Mt5AccountMetadata | null,
    deviceName?: string,
    engineVersion?: string,
  ): void {
    const now = new Date().toISOString();
    const existing = this.entries.get(sourceKey);
    const entry: EngineRegistryEntry = {
      sourceKey,
      connectedAt: now,
      lastSeenAt: now,
      lastMetricsAt: existing?.lastMetricsAt ?? null,
      lastAwarenessAt: existing?.lastAwarenessAt ?? null,
      healthState: 'online',
      latestMetrics: existing?.latestMetrics ?? null,
      latestAwareness: existing?.latestAwareness ?? null,
      lastError: null,
      account: account ?? existing?.account ?? null,
      deviceName: deviceName ?? existing?.deviceName ?? null,
      engineVersion: engineVersion ?? existing?.engineVersion ?? null,
    };
    this.entries.set(sourceKey, entry);
    this.logger.log(
      `Engine registered: sourceKey=${sourceKey} account=${account?.login ?? 'none'} server=${account?.server ?? 'none'}`,
    );
    this.emit(entry);
  }

  heartbeat(sourceKey: string): void {
    const entry = this.entries.get(sourceKey);
    if (!entry) return;
    const was = entry.healthState;
    entry.lastSeenAt = new Date().toISOString();
    entry.healthState = 'online';
    if (was !== 'online') {
      this.logger.log(`Engine recovered: sourceKey=${sourceKey} was=${was}`);
      this.emit(entry);
    }
  }

  recordMetrics(sourceKey: string, metrics: unknown): void {
    const entry = this.entries.get(sourceKey);
    if (!entry) return;
    entry.lastMetricsAt = new Date().toISOString();
    entry.latestMetrics = metrics;
  }

  updateAwareness(sourceKey: string, awareness: EngineAwarenessPayload): void {
    const entry = this.entries.get(sourceKey);
    if (!entry) return;
    entry.latestAwareness = awareness;
    entry.lastAwarenessAt = new Date().toISOString();
    if (awareness.last_error) entry.lastError = String(awareness.last_error);
    if (awareness.runtime_state === 'error') {
      const was = entry.healthState;
      entry.healthState = 'error';
      if (was !== 'error') this.emit(entry);
    }
    this.logger.debug(
      `Engine awareness updated: sourceKey=${sourceKey} source_key=${awareness.source_key ?? 'none'}`,
    );
  }

  markOffline(sourceKey: string): void {
    const entry = this.entries.get(sourceKey);
    if (!entry) return;
    const was = entry.healthState;
    entry.healthState = 'offline';
    if (was !== 'offline') {
      this.logger.log(`Engine offline: sourceKey=${sourceKey}`);
      this.emit(entry);
    }
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  getEntry(sourceKey: string): EngineRegistryEntry | null {
    return this.entries.get(sourceKey) ?? null;
  }

  snapshot(): EngineRegistryEntry[] {
    return [...this.entries.values()];
  }

  /**
   * Finds the sourceKey (engineId) of the engine matching the given broker name.
   *
   * Matching order:
   *  1. Exact case-insensitive match on awareness.source_key (preferred)
   *  2. Fuzzy: account.server contains broker substring (e.g. "fundednext" in "FundedNext-Demo")
   *
   * Returns the first online match, then any match if no online one exists.
   */
  findByBroker(broker: string): string | null {
    const lc = broker.toLowerCase();

    const pass = (
      predicate: (e: EngineRegistryEntry) => boolean,
      onlineOnly: boolean,
    ): string | null => {
      for (const entry of this.entries.values()) {
        if (onlineOnly && entry.healthState !== 'online') continue;
        if (predicate(entry)) return entry.sourceKey;
      }
      return null;
    };

    // Pass 1: exact source_key match (online engines first)
    const byKey = pass(
      (e) => (e.latestAwareness?.source_key ?? '').toLowerCase() === lc,
      true,
    ) ?? pass(
      (e) => (e.latestAwareness?.source_key ?? '').toLowerCase() === lc,
      false,
    );
    if (byKey) return byKey;

    // Pass 2: server fuzzy match
    return (
      pass((e) => Boolean(e.account?.server?.toLowerCase().includes(lc)), true) ??
      pass((e) => Boolean(e.account?.server?.toLowerCase().includes(lc)), false)
    );
  }

  onHealthChanged(listener: HealthListener) {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private emit(entry: EngineRegistryEntry) {
    for (const listener of this.healthListeners) {
      try {
        listener(entry);
      } catch (err) {
        this.logger.error(
          `EngineRegistry health listener threw for ${entry.sourceKey}: ${String(err)}`,
        );
      }
    }
  }

  private sweep() {
    const now = Date.now();
    const staleMs =
      this.config.get<number>('engineRegistry.staleAfterSeconds', 30) * 1000;
    const offlineMs =
      this.config.get<number>('engineRegistry.offlineAfterSeconds', 90) * 1000;

    for (const entry of this.entries.values()) {
      if (entry.healthState === 'offline') continue;
      if (!entry.lastSeenAt) continue;
      const age = now - Date.parse(entry.lastSeenAt);

      if (age >= offlineMs) {
        entry.healthState = 'offline';
        this.logger.warn(`Engine sweep → offline: sourceKey=${entry.sourceKey} age=${age}ms`);
        this.emit(entry);
      } else if (
        age >= staleMs &&
        entry.healthState === 'online'
      ) {
        entry.healthState = 'stale';
        this.logger.warn(`Engine sweep → stale: sourceKey=${entry.sourceKey} age=${age}ms`);
        this.emit(entry);
      }
    }
  }
}
