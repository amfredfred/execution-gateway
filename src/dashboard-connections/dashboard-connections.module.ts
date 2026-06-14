import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DashboardAuthService } from './dashboard-auth.service';
import { DashboardConnectionRegistryService } from './dashboard-connection-registry.service';
import { DashboardGateway } from './dashboard.gateway';
import { LicensingModule } from '../licensing/licensing.module';
import { EngineRegistryModule } from '../engine-connections/engine-registry.module';

@Module({
  imports: [ConfigModule, LicensingModule, EngineRegistryModule],
  providers: [
    DashboardAuthService,
    DashboardConnectionRegistryService,
    DashboardGateway,
  ],
  exports: [DashboardConnectionRegistryService],
})
export class DashboardConnectionsModule {}
