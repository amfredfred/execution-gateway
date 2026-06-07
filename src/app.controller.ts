import { Controller, Get } from '@nestjs/common';
import { ConnectionRegistryService } from './engine-connections/connection-registry.service';
import { ProtocolService } from './protocol/protocol.service';
import { RoomRegistryService } from './rooms/room-registry.service';

@Controller()
export class AppController {
  constructor(
    private readonly protocol: ProtocolService,
    private readonly connections: ConnectionRegistryService,
    private readonly rooms: RoomRegistryService,
  ) {}

  @Get('health')
  health() {
    return {
      service: 'traderelay-execution-gateway',
      status: 'ok',
      protocol_versions: this.protocol.supportedVersions,
      connected_engines: this.connections.count,
      active_rooms: this.rooms.roomCount,
      subscribed_symbols: [...this.rooms.symbols],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * GET /engine-version
   *
   * Used by the engine auto-updater (scripts/update.ps1) to check whether
   * a newer engine build is available for download.
   *
   * Configure via environment variables:
   *   ENGINE_LATEST_VERSION   — semver string, e.g. "0.2.0"
   *   ENGINE_DOWNLOAD_URL     — full URL to TradeRelay-Engine-<ver>.zip
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
