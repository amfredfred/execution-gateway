import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProtocolModule } from '../protocol/protocol.module';
import { RoomsModule } from '../rooms/rooms.module';
import { LicensingModule } from '../licensing/licensing.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { EngineGateway } from './engine.gateway';
import { EngineSessionService } from './engine-session.service';
import { ExecutionLifecycleService } from './execution-lifecycle.service';

@Module({
  imports: [ConfigModule, ProtocolModule, RoomsModule, LicensingModule],
  providers: [
    ConnectionRegistryService,
    EngineSessionService,
    ExecutionLifecycleService,
    EngineGateway,
  ],
  exports: [ConnectionRegistryService],
})
export class EngineConnectionsModule {}
