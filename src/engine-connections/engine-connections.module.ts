import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ProtocolModule } from '../protocol/protocol.module';
import { RoomsModule } from '../rooms/rooms.module';
import { LicensingModule } from '../licensing/licensing.module';
import { DashboardConnectionsModule } from '../dashboard-connections/dashboard-connections.module';
import { ConnectionRegistryService } from './connection-registry.service';
import { EngineGateway } from './engine.gateway';
import { EngineSessionService } from './engine-session.service';
import { ExecutionLifecycleService } from './execution-lifecycle.service';
import { RemoteCommandService } from '../commands/remote-command.service';

@Module({
  imports: [
    ConfigModule,
    ProtocolModule,
    RoomsModule,
    LicensingModule,
    DashboardConnectionsModule,
  ],
  providers: [
    ConnectionRegistryService,
    EngineSessionService,
    ExecutionLifecycleService,
    RemoteCommandService,
    EngineGateway,
  ],
  exports: [ConnectionRegistryService, RemoteCommandService],
})
export class EngineConnectionsModule {}
