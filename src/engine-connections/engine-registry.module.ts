import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EngineRegistryService } from './engine-registry.service';

/**
 * Standalone module so EngineRegistryService can be imported by
 * EngineConnectionsModule, DashboardConnectionsModule, and SignalEngineModule
 * without creating circular dependencies.
 */
@Module({
  imports: [ConfigModule],
  providers: [EngineRegistryService],
  exports: [EngineRegistryService],
})
export class EngineRegistryModule {}
