import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DashboardAuthService } from './dashboard-auth.service';
import { DashboardConnectionRegistryService } from './dashboard-connection-registry.service';
import { DashboardGateway } from './dashboard.gateway';
import { LicensingModule } from '../licensing/licensing.module';

@Module({
  imports: [ConfigModule, LicensingModule],
  providers: [
    DashboardAuthService,
    DashboardConnectionRegistryService,
    DashboardGateway,
  ],
  exports: [DashboardConnectionRegistryService],
})
export class DashboardConnectionsModule {}
