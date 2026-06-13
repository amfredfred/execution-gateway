import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { ConnectionRegistryService } from './engine-connections/connection-registry.service';
import { ProtocolService } from './protocol/protocol.service';
import { RoomRegistryService } from './rooms/room-registry.service';

@Controller()
export class AppController {
  private readonly supabase?: SupabaseClient;

  constructor(
    private readonly protocol: ProtocolService,
    private readonly connections: ConnectionRegistryService,
    private readonly rooms: RoomRegistryService,
    config: ConfigService,
  ) {
    const url = config.get<string>('supabase.url');
    const key = config.get<string>('supabase.serviceRoleKey');
    if (url && key) {
      this.supabase = createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
    }
  }

  @Get('health')
  async health() {
    let db: 'ok' | 'unreachable' = 'ok';
    if (this.supabase) {
      try {
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), 3_000),
        );
        const probe = this.supabase
          .from('licenses')
          .select('id', { count: 'exact', head: true });
        const { error } = await Promise.race([probe, timeout]);
        if (error) db = 'unreachable';
      } catch {
        db = 'unreachable';
      }
    }

    const payload = {
      service: 'apexquantel-execution-gateway',
      status: db === 'ok' ? 'ok' : 'degraded',
      db,
      protocol_versions: this.protocol.supportedVersions,
      connected_engines: this.connections.count,
      active_rooms: this.rooms.roomCount,
      subscribed_symbols: [...this.rooms.symbols],
      timestamp: new Date().toISOString(),
    };

    if (db !== 'ok') throw new ServiceUnavailableException(payload);
    return payload;
  }

  /**
   * GET /engine-version
   *
   * Used by the engine auto-updater (scripts/update.ps1) to check whether
   * a newer engine build is available for download.
   *
   * Configure via environment variables:
   *   ENGINE_LATEST_VERSION   — semver string, e.g. "0.2.0"
   *   ENGINE_DOWNLOAD_URL     — full URL to apex-quant-trader-agent-<ver>.zip
   *   ENGINE_DOWNLOAD_SHA256  — hex SHA-256 of the zip (optional but recommended)
   */
  @Get('engine-version')
  engineVersion() {
    return {
      version: process.env.ENGINE_LATEST_VERSION ?? '0.1.0',
      download_url: process.env.ENGINE_DOWNLOAD_URL ?? null,
      sha256: process.env.ENGINE_DOWNLOAD_SHA256 ?? null,
    };
  }
}
