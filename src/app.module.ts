import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import gatewayConfig from './config/gateway.config';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { DashboardConnectionsModule } from './dashboard-connections/dashboard-connections.module';
import { EngineConnectionsModule } from './engine-connections/engine-connections.module';
import { LicensingModule } from './licensing/licensing.module';
import { CommandsModule } from './commands/commands.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { ProtocolModule } from './protocol/protocol.module';
import { RoomsModule } from './rooms/rooms.module';
import { SignalEngineModule } from './signal-engine/signal-engine.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [gatewayConfig],
    }),
    RateLimitModule,   // global — injects RateLimitService everywhere
    ProtocolModule,
    RoomsModule,
    LicensingModule,
    EngineConnectionsModule,
    CommandsModule,
    WebhooksModule,
    SignalEngineModule,
    DashboardConnectionsModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
