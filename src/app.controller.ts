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
}
