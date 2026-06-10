import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LicensingModule } from '../licensing/licensing.module';
import { EngineConnectionsModule } from '../engine-connections/engine-connections.module';
import { AdminController } from './admin.controller';

@Module({
  imports: [ConfigModule, LicensingModule, EngineConnectionsModule],
  controllers: [AdminController],
})
export class AdminModule {}
