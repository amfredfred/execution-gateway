import { Module } from '@nestjs/common';
import { ProtocolModule } from '../protocol/protocol.module';
import { RoomsModule } from '../rooms/rooms.module';
import { LicensingModule } from '../licensing/licensing.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { EngineGateway } from './engine.gateway';

@Module({
  imports: [ProtocolModule, RoomsModule, LicensingModule],
  providers: [ConnectionRegistryService, EngineGateway],
  exports: [ConnectionRegistryService],
})
export class EngineConnectionsModule {}
